import { consumeStream, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from 'ai'
import { after } from 'next/server'
import { DEFAULT_MODEL, MODEL_NAMES } from '@/ai/constants'
import { getModelOptions } from '@/ai/gateway'
import { getAIServiceFailure } from '@/ai/service-error'
import { checkBotId } from 'botid/server'
import { tools } from '@/ai/tools'
import type { ChatUIMessage } from '@/components/chat/types'
import prompt from './prompt'
import { findOwnedActivity } from '@/lib/server/activities'
import { ApiError, apiFailure, assertSameOrigin, requestBodyFailure, requireOwnedProject, requireUser, type AuthContext } from '@/lib/server/api'
import { createOwnedSandbox, getOwnedSandbox, getOwnedSandboxUrl } from '@/lib/server/sandbox'
import { beginChatTurn, loadAuthoritativeHistory, saveAssistantTurn } from '@/lib/server/chat'
import { consumeQuota } from '@/lib/server/rate-limit'
import { prepareOwnedFileWrites, writeOwnedSandboxFiles } from '@/lib/server/source-files'
import { MAX_CHAT_REQUEST_BYTES, parseChatRequestBody } from '@/ai/chat-request'
import { readJsonBody } from '@/lib/request-body'
import { runOwnedCommand, startOwnedCommand } from '@/lib/server/owned-command'

export const maxDuration = 300

function compactGeneratedFilesOutput(output: string) {
  if (!output.includes('Content:')) return output
  const paths = [...output.matchAll(/Path:\s*([^\n]+)/g)].map((match) => match[1].trim())
  return paths.length ? `Previously generated and uploaded files: ${paths.join(', ')}. Read the files for current contents.` : 'Files were generated successfully. Read the files for current contents.'
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  let reserved: { auth: AuthContext; projectId: string; assistantId: string } | undefined
  let cleanup = () => {}
  try {
    const auth = await requireUser(req)
    assertSameOrigin(req)
    const payload = await readJsonBody(req, MAX_CHAT_REQUEST_BYTES)
    if (!payload.ok) throw requestBodyFailure(payload.reason)
    const body = parseChatRequestBody(payload.data)
    if (!body.ok) throw new ApiError(body.status, body.code, body.message)
    const { projectId, modelId = DEFAULT_MODEL, reasoningEffort } = body.data
    const project = await requireOwnedProject(projectId, auth)
    if ((await checkBotId()).isBot) throw new ApiError(403, 'BOT_DETECTED', 'Automated requests are not allowed.')
    const minuteQuota = await consumeQuota(auth.user.id, 'ai-minute')
    await consumeQuota(auth.user.id, 'ai-day')
    const assistantId = await beginChatTurn(auth, body.data, requestId, modelId)
    reserved = { auth, projectId, assistantId }
    const messages = await loadAuthoritativeHistory(auth, projectId, assistantId)
    const { data: sessions, error: sessionError } = await auth.supabase.from('sandbox_sessions').select('sandbox_id,status,expires_at,ports')
      .eq('project_id', projectId).eq('user_id', auth.user.id).eq('status', 'running').gt('expires_at', new Date().toISOString()).limit(1)
    if (sessionError) throw sessionError
    const activeSandbox = sessions[0]
    const sandboxPrompt = activeSandbox
      ? `\n\nThis project's registered sandbox is ${activeSandbox.sandbox_id}. Reuse it instead of creating another sandbox. Exposed ports: ${activeSandbox.ports.join(', ')}.`
      : '\n\nThis project has no active sandbox. Create one if coding tools are needed.'
    const activity = project.activity_id ? await findOwnedActivity(auth, project.activity_id) : undefined
    const activityPrompt = activity
      ? `\n\nTrusted activity: ${activity.title}\nMode: ${activity.mode}\nDifficulty: ${activity.difficulty}\nLanguage: ${activity.framework ?? activity.language}\nConcepts: ${activity.concepts.join(', ')}\nInstructions:\n${activity.instructions.join('\n')}\nDo not reveal hidden checks.` : ''

    const cancellation = new AbortController()
    const signal = AbortSignal.any([req.signal, cancellation.signal, AbortSignal.timeout(270_000)])
    let failure = false
    let failureMessage = 'The tutor could not finish this response. Your saved conversation is unchanged; retry when ready.'
    let finished = false
    let inactivity: ReturnType<typeof setTimeout>
    let heartbeatWork: Promise<void> | undefined
    const progress = () => {
      if (finished || signal.aborted) return
      clearTimeout(inactivity)
      inactivity = setTimeout(() => cancellation.abort(new DOMException('No tutor progress for 90 seconds.', 'AbortError')), 90_000)
    }
    const safeError = (error: unknown) => {
      if (!signal.aborted) {
        if (!failure) {
          const service = getAIServiceFailure(error)
          if (service) failureMessage = `${service.message} Your conversation has not been cleared.`
          console.error('Chat request failed', { requestId, errorName: error instanceof Error ? error.name : 'ProviderError',
            ...(service ? { code: service.code, upstreamStatus: service.upstreamStatus } : {}), durationMs: Date.now() - startedAt })
        }
        failure = true
        if (!finished) cancellation.abort(new DOMException('The tutor response could not continue.', 'AbortError'))
      }
      return failureMessage
    }
    const heartbeat = setInterval(() => {
      if (heartbeatWork || finished || signal.aborted) return
      heartbeatWork = saveAssistantTurn(auth, projectId, assistantId, requestId, undefined, 'pending')
        .catch((error) => { safeError(error) }).finally(() => { heartbeatWork = undefined })
    }, 20_000)
    cleanup = () => { finished = true; clearInterval(heartbeat); clearTimeout(inactivity) }
    progress()
    let firstOutput = false
    console.info('Chat request started', { requestId, projectId, modelId })
    const stream = createUIMessageStream<ChatUIMessage>({
      originalMessages: messages,
      generateId: () => assistantId,
      onError: safeError,
      onStepFinish: ({ responseMessage }) => saveAssistantTurn(auth, projectId, assistantId, requestId, responseMessage, 'pending'),
      onFinish: async ({ responseMessage, isAborted, finishReason }) => {
        cleanup()
        // Drain the last lease update before finalizing. Otherwise a late
        // heartbeat sees status=complete, reports a false failure, and may
        // abort a response that was successfully saved.
        await heartbeatWork
        const status = failure ? 'failed' : isAborted || signal.aborted ? 'interrupted' : !finishReason || finishReason === 'error' ? 'failed' : 'complete'
        try {
          await saveAssistantTurn(auth, projectId, assistantId, requestId, responseMessage, status)
        } catch (error) {
          await saveAssistantTurn(auth, projectId, assistantId, requestId, undefined, 'failed').catch(() => undefined)
          throw error
        } finally {
          console.info('Chat request finished', { requestId, status, durationMs: Date.now() - startedAt })
        }
      },
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageId: assistantId, messageMetadata: { model: MODEL_NAMES[modelId] ?? modelId, requestId } })
        const progressWriter = { ...writer, write: (part: Parameters<typeof writer.write>[0]) => { progress(); writer.write(part) } }
        const result = streamText({
          ...getModelOptions(modelId, { reasoningEffort }),
          abortSignal: signal,
          system: `${prompt}${activityPrompt}${sandboxPrompt}`,
          messages: await convertToModelMessages(messages.map((message) => ({ ...message, parts: message.parts.map((part) =>
            part.type === 'tool-generateFiles' && part.state === 'output-available' && typeof part.output === 'string'
              ? { ...part, output: compactGeneratedFilesOutput(part.output) } : part) })), { ignoreIncompleteToolCalls: true }),
          stopWhen: stepCountIs(20),
          tools: tools({ modelId, writer: progressWriter, sandboxAccess: {
            create: (settings) => createOwnedSandbox(auth, projectId, settings),
            get: (sandboxId) => getOwnedSandbox(auth, sandboxId, projectId),
            getUrl: (sandboxId, port) => getOwnedSandboxUrl(auth, sandboxId, port, projectId, req.signal),
            writeFiles: async (sandboxId, files) => { await writeOwnedSandboxFiles(auth, sandboxId, files, { projectId }) },
            prepareWriteFiles: (sandboxId, paths) => prepareOwnedFileWrites(auth, sandboxId, projectId, paths),
            execute: async (sandboxId, input, executionOptions) => {
              const options = { origin: 'ai' as const, projectId, requestId: crypto.randomUUID(), signal: executionOptions.signal }
              if (input.wait) return runOwnedCommand(auth, sandboxId, { executable: input.command, args: input.args }, options, executionOptions.onStarted)
              const execution = await startOwnedCommand(auth, sandboxId, { executable: input.command, args: input.args, background: true }, options)
              try { executionOptions.onStarted?.(execution.command) }
              catch (error) { await execution.cancel(); throw error }
              return { commandId: execution.command.cmdId, exitCode: null, output: '', outputTruncated: false }
            },
          } }),
          onChunk: ({ chunk }) => {
            progress()
            if (!firstOutput) {
              firstOutput = true
              console.info('Chat first output', { requestId, chunkType: chunk.type, durationMs: Date.now() - startedAt })
            }
          },
          experimental_onToolCallStart: ({ toolCall }) => { progress(); console.info('Chat tool started', { requestId, toolName: toolCall.toolName }) },
          experimental_onToolCallFinish: ({ durationMs, success, toolCall }) => { progress(); console.info('Chat tool finished', { requestId, toolName: toolCall.toolName, success, durationMs }) },
          onError: ({ error }) => { safeError(error) },
        })
        writer.merge(result.toUIMessageStream<ChatUIMessage>({ sendReasoning: true, sendStart: false, onError: safeError }).pipeThrough(new TransformStream({
          // Abort chunks otherwise serialize AbortSignal.reason independently
          // of onError, so never forward arbitrary upstream cancellation text.
          transform(part, controller) {
            controller.enqueue(part.type === 'abort' ? { type: 'abort', reason: 'The tutor response was interrupted. You can retry.' } : part)
          },
        })))
      },
    })
    return createUIMessageStreamResponse({
      headers: { ...minuteQuota, 'x-request-id': requestId, 'cache-control': 'private, no-store' },
      stream,
      // Finish persistence even if the browser closes the response stream.
      consumeSseStream: ({ stream }) => after(() => consumeStream({ stream })),
    })
  } catch (error) {
    cleanup()
    if (reserved) await saveAssistantTurn(reserved.auth, reserved.projectId, reserved.assistantId, requestId, undefined, 'failed').catch(() => undefined)
    return apiFailure(error, requestId)
  }
}

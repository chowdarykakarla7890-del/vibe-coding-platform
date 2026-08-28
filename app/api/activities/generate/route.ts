import { DEFAULT_MODEL, SUPPORTED_MODELS } from '@/ai/constants'
import { getModelOptions } from '@/ai/gateway'
import { activityManifestSchema } from '@/lib/learning/types'
import { ACTIVITY_GENERATION_TIMEOUT_MS, activityGenerationRequestSchema } from '@/lib/learning/activity-generation'
import { isSafeCommand } from '@/lib/learning/scoring'
import { readJsonBody } from '@/lib/request-body'
import { generateText, Output } from 'ai'
import { checkBotId } from 'botid/server'
import { awaitMutationReceipt, MutationReceiptTimeoutError } from '@/lib/mutation-receipt'
import { ApiError, apiFailure, assertSameOrigin, requestBodyFailure, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { apiJson } from '@/lib/server/api'
import { storeGeneratedActivity, validateGeneratedActivity } from '@/lib/server/activities'

export const maxDuration = 180

const generatedSchema = activityManifestSchema.omit({ id: true, source: true })

export async function POST(request: Request) {
  const requestId = crypto.randomUUID(), startedAt = Date.now()
  console.info('Activity generation lifecycle', { requestId, outcome: 'started', durationMs: 0 })
  try {
    return await awaitMutationReceipt(async signal => {
      const auth = await requireUser(request)
      signal.throwIfAborted()
      assertSameOrigin(request)
      const payload = await readJsonBody(request, 8 * 1024)
      signal.throwIfAborted()
      if (!payload.ok) throw requestBodyFailure(payload.reason)
      const body = activityGenerationRequestSchema.safeParse(payload.data)
      if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'The activity request is incomplete or too large.')
      const modelId = body.data.modelId ?? DEFAULT_MODEL
      if (!SUPPORTED_MODELS.some((id) => id === modelId)) throw new ApiError(400, 'UNSUPPORTED_MODEL', 'Choose a supported model.')
      if ((await checkBotId()).isBot) throw new ApiError(403, 'BOT_DETECTED', 'Automated requests are not allowed.')
      signal.throwIfAborted()
      const quota = await consumeQuota(auth.user.id, 'ai-minute')
      signal.throwIfAborted()
      await consumeQuota(auth.user.id, 'ai-day')
      signal.throwIfAborted()
      const result = await generateText({
        ...getModelOptions(modelId),
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: 16_384,
        output: Output.object({ schema: generatedSchema }),
        prompt: `Create one safe, focused coding learning activity.\nMode: ${body.data.mode}\nDifficulty: ${body.data.difficulty}\nLanguage or framework: ${body.data.language}\nLearner goal: ${body.data.goal}\nUse relative text-file paths only. Starter files must be under 256 KB. Commands must be structured as executable plus arguments, never shell strings. Prefer a deterministic verification command; use rubric-only for UI work without a reliable runner. Rubric weights must total 100. Do not include dependency folders or generated binaries.`,
      })
      signal.throwIfAborted()
      const output = generatedSchema.safeParse(result.output)
      if (!output.success) throw new ApiError(502, 'INVALID_ACTIVITY', 'The model did not return a valid activity. Try a more specific goal.')
      const candidate = { ...output.data, id: `generated-${body.data.mode}-${crypto.randomUUID()}`, mode: body.data.mode, difficulty: body.data.difficulty, source: 'generated' as const }
      if (candidate.verify.kind === 'command' && !isSafeCommand(candidate.verify.command.executable, candidate.verify.command.args)) candidate.verify = { kind: 'rubric' }
      const activity = activityManifestSchema.parse(candidate)
      for (const variant of Object.values(activity.variants ?? {})) {
        if (variant.verify.kind === 'command' && !isSafeCommand(variant.verify.command.executable, variant.verify.command.args)) variant.verify = { kind: 'rubric' }
      }
      try { validateGeneratedActivity(activity) }
      catch { throw new ApiError(502, 'INVALID_ACTIVITY', 'The generated activity did not pass safety or size validation. Try a more focused goal.') }
      signal.throwIfAborted()
      await storeGeneratedActivity(auth, activity)
      signal.throwIfAborted()
      console.info('Activity generation lifecycle', { requestId, outcome: 'complete', durationMs: Date.now() - startedAt })
      return apiJson({ activity, requestId }, requestId, 200, quota)
    }, request.signal, ACTIVITY_GENERATION_TIMEOUT_MS, 'Activity generation timed out.')
  } catch (error) {
    console.info('Activity generation lifecycle', { requestId, outcome: request.signal.aborted ? 'cancelled' : 'failed', durationMs: Date.now() - startedAt })
    if (request.signal.aborted || error instanceof MutationReceiptTimeoutError) return apiFailure(new ApiError(408, 'GENERATION_INTERRUPTED', 'Generation was interrupted. Usage may already have been incurred and a saved activity may still appear. Reload saved activities before generating again.'), requestId)
    return apiFailure(error, requestId)
  }
}

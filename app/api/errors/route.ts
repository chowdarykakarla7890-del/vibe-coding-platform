import { Models } from '@/ai/constants'
import { getModelOptions } from '@/ai/gateway'
import { checkBotId } from 'botid/server'
import { generateText, Output } from 'ai'
import { linesSchema, resultSchema } from '@/components/error-monitor/schemas'
import { isDiagnosticFailure } from '@/lib/commands/diagnostic-candidates'
import { awaitMutationReceipt, MutationReceiptTimeoutError } from '@/lib/mutation-receipt'
import prompt from './prompt'
import { ApiError, apiFailure, apiJson, assertSameOrigin, parseBody, requireOwnedSandbox, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'

export const maxDuration = 60

export async function POST(req: Request) {
  const requestId = crypto.randomUUID(), startedAt = Date.now()
  try {
    return await awaitMutationReceipt(async signal => {
      const auth = await requireUser(req)
      signal.throwIfAborted()
      assertSameOrigin(req)
      const body = await parseBody(req, linesSchema, 128 * 1024)
      await requireOwnedSandbox(body.sandboxId, auth, signal)
      signal.throwIfAborted()
      if (!body.lines.some(line => line.data.split(/\r?\n/).some(isDiagnosticFailure))) {
        console.info('Error analysis lifecycle', { requestId, outcome: 'skipped', durationMs: Date.now() - startedAt })
        return apiJson({ shouldBeFixed: false, summary: '', paths: [] }, requestId)
      }
      if ((await checkBotId()).isBot) throw new ApiError(403, 'BOT_DETECTED', 'Automated requests are not allowed.')
      signal.throwIfAborted()
      const headers = await consumeQuota(auth.user.id, 'ai-minute')
      signal.throwIfAborted()
      await consumeQuota(auth.user.id, 'ai-day')
      signal.throwIfAborted()
      const result = await generateText({
        ...getModelOptions(Models.OpenAIGPT53Codex),
        system: prompt,
        messages: [{ role: 'user', content: JSON.stringify(body) }],
        output: Output.object({ schema: resultSchema }),
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: 4096,
      })
      signal.throwIfAborted()
      const parsed = resultSchema.safeParse(result.output)
      if (!parsed.success || (parsed.data.shouldBeFixed && !parsed.data.summary.trim())) throw new ApiError(502, 'INVALID_ANALYSIS', 'The tutor returned an invalid analysis. Please retry.')
      console.info('Error analysis lifecycle', { requestId, outcome: 'complete', durationMs: Date.now() - startedAt })
      return apiJson(parsed.data, requestId, 200, headers)
    }, req.signal, 45_000, 'Error analysis timed out.')
  } catch (error) {
    console.info('Error analysis lifecycle', { requestId, outcome: req.signal.aborted ? 'cancelled' : 'failed', durationMs: Date.now() - startedAt })
    if (req.signal.aborted || error instanceof MutationReceiptTimeoutError) return apiFailure(new ApiError(408, 'ANALYSIS_INTERRUPTED', 'Error analysis was interrupted. No automatic retry was started; usage may already have been incurred.'), requestId)
    return apiFailure(error, requestId)
  }
}

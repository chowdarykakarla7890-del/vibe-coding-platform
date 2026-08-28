import { describe, expect, it } from 'vitest'
import { getModelOptions } from '@/ai/gateway'
import { DEFAULT_MODEL, Models, PRIMARY_MODELS, AFFORDABLE_MODELS } from '@/ai/constants'

describe('stable model selection and current Gateway routing', () => {
  it('routes existing Grok selections to the current creator prefix', () => {
    expect(Models.XaiGrok41Reasoning).toBe('xai/grok-4.1-fast-reasoning')
    expect(getModelOptions(Models.XaiGrok41Reasoning).model.modelId).toBe('spacexai/grok-4.1-fast-reasoning')
  })
  it('preserves the default, tier order and the other seven Gateway routes', () => {
    expect(DEFAULT_MODEL).toBe(Models.AnthropicClaudeOpus46)
    expect(PRIMARY_MODELS).toHaveLength(4)
    expect(AFFORDABLE_MODELS).toHaveLength(4)
    for (const id of [...PRIMARY_MODELS, ...AFFORDABLE_MODELS]) {
      if (id !== Models.XaiGrok41Reasoning) expect(getModelOptions(id).model.modelId).toBe(id)
    }
  })
  it('keeps provider-specific settings out of the affordable models', () => {
    for (const id of AFFORDABLE_MODELS) expect(getModelOptions(id).providerOptions).toBeUndefined()
    expect(getModelOptions(Models.OpenAIGPT53Codex).providerOptions?.openai.reasoningEffort).toBe('low')
    expect(getModelOptions(Models.AnthropicClaudeOpus46).providerOptions?.anthropic.cacheControl).toEqual({ type: 'ephemeral' })
  })
})

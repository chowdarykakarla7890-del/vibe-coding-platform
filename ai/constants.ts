import { type GatewayModelId } from '@ai-sdk/gateway'

export enum Models {
  AnthropicClaudeOpus46 = 'anthropic/claude-opus-4.6',
  AnthropicClaudeSonnet46 = 'anthropic/claude-sonnet-4.6',
  OpenAIGPT53Codex = 'openai/gpt-5.3-codex',
  XaiGrok41Reasoning = 'xai/grok-4.1-fast-reasoning',
  DeepSeekV4Flash = 'deepseek/deepseek-v4-flash',
  OpenAIGPT5Nano = 'openai/gpt-5-nano',
  GoogleGemini31FlashLite = 'google/gemini-3.1-flash-lite',
  MistralDevstralSmall2 = 'mistral/devstral-small-2',
}

export const DEFAULT_MODEL = Models.AnthropicClaudeOpus46

export type ModelTier = 'primary' | 'affordable'

export const PRIMARY_MODELS: GatewayModelId[] = [
  Models.AnthropicClaudeOpus46,
  Models.AnthropicClaudeSonnet46,
  Models.OpenAIGPT53Codex,
  Models.XaiGrok41Reasoning,
]

export const AFFORDABLE_MODELS: GatewayModelId[] = [
  Models.DeepSeekV4Flash,
  Models.OpenAIGPT5Nano,
  Models.GoogleGemini31FlashLite,
  Models.MistralDevstralSmall2,
]

export const SUPPORTED_MODELS: GatewayModelId[] = [
  ...PRIMARY_MODELS,
  ...AFFORDABLE_MODELS,
]

export const MODEL_NAMES: Record<string, string> = {
  [Models.AnthropicClaudeOpus46]: 'Claude Opus 4.6',
  [Models.AnthropicClaudeSonnet46]: 'Claude Sonnet 4.6',
  [Models.OpenAIGPT53Codex]: 'GPT-5.3 Codex',
  [Models.XaiGrok41Reasoning]: 'Grok 4.1 Reasoning',
  [Models.DeepSeekV4Flash]: 'DeepSeek V4 Flash',
  [Models.OpenAIGPT5Nano]: 'GPT-5 nano',
  [Models.GoogleGemini31FlashLite]: 'Gemini 3.1 Flash Lite',
  [Models.MistralDevstralSmall2]: 'Devstral Small 2',
}

export const MODEL_TIERS: Record<string, ModelTier> = {
  ...Object.fromEntries(PRIMARY_MODELS.map((id) => [id, 'primary'] as const)),
  ...Object.fromEntries(
    AFFORDABLE_MODELS.map((id) => [id, 'affordable'] as const)
  ),
}

export const TEST_PROMPTS = [
  'I am a beginner. Teach me React by building a small habit tracker with tests.',
  'Teach me TypeScript by building a typed expense calculator. Let me implement each step.',
  'I know JavaScript basics. Help me learn APIs by building a weather dashboard, one milestone at a time.',
]

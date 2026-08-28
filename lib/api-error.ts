const MAX_ERROR_MESSAGE_LENGTH = 500

function cleanMessage(value: unknown) {
  if (typeof value !== 'string') return undefined
  const message = value.trim()
  if (!message || /^\s*</.test(message)) return undefined
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

/**
 * Extracts a safe message from both the current structured API envelope and
 * older string-based responses used by a few routes.
 */
export function getApiErrorMessage(payload: unknown, fallback: string): string {
  const direct = cleanMessage(payload)
  if (direct) {
    try {
      return getApiErrorMessage(JSON.parse(direct), fallback)
    } catch {
      return direct
    }
  }

  if (!payload || typeof payload !== 'object') return fallback

  const record = payload as Record<string, unknown>
  const nested = record.error
  const nestedMessage =
    nested && typeof nested === 'object'
      ? cleanMessage((nested as Record<string, unknown>).message)
      : cleanMessage(nested)

  return nestedMessage ?? cleanMessage(record.message) ?? fallback
}

export async function readApiErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  const payload = await response.text().catch(() => '')
  return getApiErrorMessage(payload, fallback)
}

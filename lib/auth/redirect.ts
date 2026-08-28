const ALLOWED_ROOTS = new Set(['playground', 'practice', 'debug', 'challenges', 'projects', 'dsa', 'portfolio'])

export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return '/playground'
  try {
    const url = new URL(value, 'https://codetutor.invalid')
    if (url.origin !== 'https://codetutor.invalid' || !ALLOWED_ROOTS.has(url.pathname.split('/')[1])) return '/playground'
    return url.pathname + url.search
  } catch {
    return '/playground'
  }
}

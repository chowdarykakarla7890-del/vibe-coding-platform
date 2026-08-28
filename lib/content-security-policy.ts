// Public SDK namespace only; the challenge iframe serves its own policy.
export const BOTID_PREFIX = '/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3'

export function createNonce() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64')
}

function authOrigin(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    return url.origin
  } catch { return undefined }
}

/** Per-document policy. Styles remain inline-compatible for Monaco/Radix;
 * JavaScript never uses unsafe-inline, and unsafe-eval is development-only.
 * wasm-unsafe-eval is limited to the highlighter's WebAssembly engine.
 * Origins come from server configuration, never a client-provided policy.
 */
export function contentSecurityPolicy(nonce: string, options: {
  origin: string; supabaseUrl?: string; development: boolean
}) {
  if (!/^[A-Za-z0-9+/]{24}$/.test(nonce)) throw new Error('Invalid generated CSP nonce.')
  const origin = new URL(options.origin).origin
  const auth = authOrigin(options.supabaseUrl)
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${options.development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    // Markdown may contain public remote images; it cannot add scripts/frames.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${auth ? ` ${auth}` : ''}${options.development ? ' ws: wss:' : ''}`,
    "worker-src 'self' blob:",
    `frame-src https://*.vercel.run ${origin}${BOTID_PREFIX}/`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Local production-build tests intentionally use HTTP.
    ...(origin.startsWith('https:') ? ['upgrade-insecure-requests'] : []),
  ].join('; ')
}

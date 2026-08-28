/** Frame/navigation baseline. This is not a nonce-based script CSP; a full
 * script policy still needs verification with Monaco, streaming and OAuth. */
export const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-src https://*.vercel.run; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
]

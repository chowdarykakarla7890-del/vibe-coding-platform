const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** NextURL normalizes loopback addresses to localhost. Recover the exact
 * browser authority only for a validated loopback Host on the same port.
 * Never trust forwarded headers or treat distinct loopback origins as equal. */
export function requestOrigin(request: Pick<Request, 'url' | 'headers'>): string | undefined {
  const url = new URL(request.url)
  if (!LOOPBACK_HOSTS.has(url.hostname)) return url.origin
  const host = request.headers.get('host')
  if (!host) return url.origin
  try {
    const authority = new URL(`${url.protocol}//${host}`)
    if (!LOOPBACK_HOSTS.has(authority.hostname) || authority.port !== url.port ||
      authority.host !== host || authority.username || authority.password ||
      authority.pathname !== '/' || authority.search || authority.hash) return
    return authority.origin
  } catch { return }
}

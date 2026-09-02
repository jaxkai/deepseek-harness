/**
 * Readiness parsing for the supervised web host. The `dsh web:` URL line is
 * the host's own readiness signal — printed only after its Loader tree
 * settles — and with `--port 0` it is also the only place the OS-assigned
 * port is published.
 * @module @deepseek-ai/dsh-desktop/readiness
 */

/** Matches the URL token of a `dsh web: <url> [(LAN: …)]` readiness line. */
const WEB_URL_LINE = /^dsh web: (http:\/\/\S+)/

/** Hostnames the desktop shell is willing to load into a window. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Parse one output line as the host readiness URL. Only plain-http loopback
 * URLs qualify: the desktop window loads a private local host, never a LAN
 * or TLS endpoint.
 * @param line - one stdout line from the host child.
 * @returns the parsed URL, or undefined when the line is not a qualifying readiness line.
 */
export function parseWebUrlLine(line: string): URL | undefined {
  const match = WEB_URL_LINE.exec(line)
  const raw = match?.[1]
  if (raw === undefined) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  return url
}

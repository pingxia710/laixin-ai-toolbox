import { net } from 'electron'

/**
 * Main-process provider traffic must use Chromium's network stack. Node's global
 * fetch does not consume the user's WinINET/PAC/proxy state, so using it here can
 * report a provider as unreachable while the same machine is reachable through
 * the active system path.
 */
export function electronSystemFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
  if (typeof net.fetch !== 'function') return Promise.reject(new Error('ELECTRON_NET_FETCH_UNAVAILABLE'))
  return net.fetch(input as string | Request, init)
}

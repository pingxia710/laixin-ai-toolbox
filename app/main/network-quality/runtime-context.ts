import { createHash } from 'node:crypto'
import type { DaemonStateView, TunnelStatus } from '../tunnel/status-service'
import type { CurrentInfo } from '../tunnel/import-meta'
import type { NetworkAccountAccess } from '../tunnel/account-client'

/** Private main-process evidence. Neither accessToken nor any path is exposed to renderer. */
export interface QualityRuntime {
  readonly origin: string
  readonly proxy: string | null
  readonly pathKind: 'laixin' | 'other'
  readonly authorizationId: string
  readonly bindingVersion: number
  readonly accessToken: string
  readonly fingerprint: string
}

export function qualityRuntimeFrom(input: { info: CurrentInfo | undefined; daemon: DaemonStateView | undefined;
  status: TunnelStatus; intent: { desired: string; sessionToken?: string } | undefined;
  access: NetworkAccountAccess | undefined; now: number; allowLocalForTests?: boolean }): QualityRuntime | undefined {
  const { info, daemon, status, intent, access, now } = input
  const version = info?.customerEntry?.bindingVersion ?? info?.configVersion
  if (!info || !Number.isSafeInteger(version) || !version || version < 1 || info.configVersion !== version ||
      !info.accountId || !access || info.accountId !== access.session.accountId ||
      !daemon || daemon.state !== 'connected' ||
      !daemon.runId || !daemon.sessionToken || !intent?.sessionToken || intent.desired !== 'connected' || daemon.intentToken !== intent.sessionToken ||
      !Number.isSafeInteger(daemon.connectionEpoch) || daemon.connectionEpoch! < 0 ||
      !Number.isSafeInteger(daemon.lastVerifiedAt) || daemon.lastVerifiedAt! > now || now - daemon.lastVerifiedAt! > 90_000 ||
      status.state !== '已连' || !['laixin', 'reused'].includes(status.pathSource) || status.unrestored || status.componentMissing) return undefined
  let account: URL
  try { account = new URL(access.client.qualityOrigin()) } catch { return undefined }
  const localTest = input.allowLocalForTests === true && account.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(account.hostname)
  if (account.protocol !== 'https:' && !localTest) return undefined
  let proxy: string | null
  const pathKind = status.pathSource === 'laixin' ? 'laixin' : 'other'
  if (pathKind === 'laixin') {
    if (daemon.reusedProxy || daemon.pathVerified !== true || !info.verifyUrl || !Number.isInteger(daemon.bridgePort) ||
        daemon.bridgePort! < 1 || daemon.bridgePort! > 65535) return undefined
    let verify: URL
    try { verify = new URL(info.verifyUrl) } catch { return undefined }
    // Existing Xray rules pin the signed verification host and port to the owned path.
    if (verify.protocol !== account.protocol || verify.username || verify.password || verify.origin !== account.origin) return undefined
    proxy = `http://127.0.0.1:${String(daemon.bridgePort)}`
  } else {
    const reused = daemon.reusedProxy
    if (!reused) return undefined
    if (reused.kind === 'direct') proxy = null
    else if (['http', 'socks'].includes(reused.kind) && reused.host && !/[\s/@?#;\\]/.test(reused.host) &&
        Number.isInteger(reused.port) && reused.port! > 0 && reused.port! <= 65535) {
      const host = reused.host.includes(':') && !reused.host.startsWith('[') ? `[${reused.host}]` : reused.host
      try {
        const value = new URL(`${reused.kind === 'socks' ? 'socks5' : 'http'}://${host}:${String(reused.port)}`)
        proxy = `${value.protocol}//${value.host}`
      }
      catch { return undefined }
    } else return undefined
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([info.batchId, info.authorizationId, info.configVersion,
    version, daemon.runId, daemon.sessionToken, daemon.intentToken, daemon.writeRightToken ?? '',
    daemon.connectionEpoch, daemon.recovery?.id ?? null, proxy, pathKind, access.session.accountId, access.session.accessToken,
    account.origin])).digest('hex')
  return { origin: account.origin, proxy, pathKind, authorizationId: info.authorizationId, bindingVersion: version,
    accessToken: access.session.accessToken, fingerprint }
}

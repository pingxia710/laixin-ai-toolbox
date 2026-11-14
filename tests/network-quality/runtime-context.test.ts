import { describe, expect, it } from 'vitest'
import { NetworkAccountClient } from '../../app/main/tunnel/account-client'
import type { CurrentInfo } from '../../app/main/tunnel/import-meta'
import type { DaemonStateView, TunnelStatus } from '../../app/main/tunnel/status-service'
import { qualityRuntimeFrom } from '../../app/main/network-quality/runtime-context'

function fixture() {
  const now = Date.now()
  const info = { singleAddressMode: true, accountId: 'account-1', authorizationId: 'lx-123456', batchId: 'batch', configVersion: 7,
    verifyUrl: 'https://example.test/toolbox-exit-ip', customerEntry: { bindingVersion: 7 } } as CurrentInfo
  const daemon: DaemonStateView = { state: 'connected', runId: 'run', sessionToken: 'intent', intentToken: 'intent',
    pathVerified: true, lastVerifiedAt: now - 100, bridgePort: 18080, connectionEpoch: 3 }
  const status = { state: '已连', pathSource: 'laixin', unrestored: '', componentMissing: '' } as TunnelStatus
  const intent = { desired: 'connected', sessionToken: 'intent' }
  const access = { client: new NetworkAccountClient('https://example.test/v1/network/'), session: { accountId: 'account-1', accessToken: 'secret' } }
  return { now, info, daemon, status, intent, access }
}

describe('current owned measurement path', () => {
  it('requires a verified connection and an account origin pinned by the signed verify target', () => {
    const f = fixture()
    const result = qualityRuntimeFrom(f)
    expect(result).toMatchObject({ origin: 'https://example.test', proxy: 'http://127.0.0.1:18080', bindingVersion: 7 })
    expect(result?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result?.fingerprint).not.toContain('secret')
  })
  it('rejects reused, stale, disconnected, foreign or mismatched paths', () => {
    const f = fixture()
    for (const input of [
      { ...f, status: { ...f.status, pathSource: 'reused' } as TunnelStatus },
      { ...f, daemon: { ...f.daemon, lastVerifiedAt: f.now - 91_000 } },
      { ...f, daemon: { ...f.daemon, state: 'error' } },
      { ...f, daemon: { ...f.daemon, connectionEpoch: undefined } },
      { ...f, intent: { ...f.intent, sessionToken: 'another' } },
      { ...f, info: { ...f.info, accountId: 'other' } },
      { ...f, info: { ...f.info, verifyUrl: 'https://other.test/ip' } },
      { ...f, info: { ...f.info, customerEntry: { ...f.info.customerEntry!, bindingVersion: 8 } } },
    ]) expect(qualityRuntimeFrom(input)).toBeUndefined()
  })
  it('allows previously existing network without attributing it to a server', () => {
    const f = fixture()
    const result = qualityRuntimeFrom({ ...f, status: { ...f.status, pathSource: 'reused' },
      daemon: { ...f.daemon, pathVerified: false, reusedProxy: { kind: 'direct' } } })
    expect(result).toMatchObject({ pathKind: 'other', proxy: null })
  })
  it('keeps the fingerprint during normal revalidation and changes it on reconnect', () => {
    const f = fixture()
    const original = qualityRuntimeFrom(f)?.fingerprint
    expect(qualityRuntimeFrom({ ...f, daemon: { ...f.daemon, lastVerifiedAt: f.now - 10 } })?.fingerprint).toBe(original)
    expect(qualityRuntimeFrom({ ...f, daemon: { ...f.daemon, connectionEpoch: 4 } })?.fingerprint).not.toBe(original)
    expect(qualityRuntimeFrom({ ...f, daemon: { ...f.daemon, runId: 'new' } })?.fingerprint).not.toBe(original)
  })
})

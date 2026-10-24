import { afterEach, expect, it } from 'vitest'
import { computeStatus, type DaemonStateView } from '../../app/main/tunnel/status-service'
import type { CurrentInfo } from '../../app/main/tunnel/import-meta'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })

const current: CurrentInfo = {
  protocol: 'vless-reality', batchId: 'batch-1', configVersion: 1, authorizationId: 'authorization-fixture',
  node: { host: '45.32.65.81', port: 443 },
  nodes: [
    { host: '45.32.65.81', port: 443, credentialName: 'vultr.json' },
    { host: '23.252.105.113', port: 443, credentialName: 'nyc.json' }
  ],
  credentialName: 'vultr.json', expiresAt: '2026-11-01T00:00:00.000Z', sourceLine: 'fixture'
}

function status(daemon: DaemonStateView) {
  const dataDir = makeTempDir('observed-node-diagnostic-')
  roots.push(dataDir)
  return computeStatus({ dataDir, daemonState: daemon, daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '',
    preReadInfo: { current, pending: undefined } })
}

it('reports the multi-entry node whose literal host matches the freshly verified exit', () => {
  expect(status({ state: 'connected', exitIp: '23.252.105.113', pathVerified: true, lastVerifiedAt: Date.now() }).observedNodeLabel)
    .toBe('23.252.105.113:443')
})

it('keeps the observed node unknown when the exit cannot prove a configured entry', () => {
  expect(status({ state: 'connected', exitIp: '198.51.100.9', pathVerified: true, lastVerifiedAt: Date.now() }).observedNodeLabel)
    .toBe('')
})

it('keeps the observed node unknown when one exit IP belongs to multiple configured ports', () => {
  const dataDir = makeTempDir('observed-node-ambiguous-')
  roots.push(dataDir)
  const ambiguous: CurrentInfo = { ...current, nodes: [
    { host: '23.252.105.113', port: 443, credentialName: 'nyc-443.json' },
    { host: '23.252.105.113', port: 8443, credentialName: 'nyc-8443.json' }
  ] }
  const result = computeStatus({ dataDir, daemonState: { state: 'connected', exitIp: '23.252.105.113', pathVerified: true,
    lastVerifiedAt: Date.now() }, daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '',
    preReadInfo: { current: ambiguous, pending: undefined } })
  expect(result.observedNodeLabel).toBe('')
})

it('does not attribute a reused external proxy to a configured Laixin node', () => {
  expect(status({ state: 'connected', code: 'TUNNEL_REUSED_EXISTING', exitIp: '23.252.105.113', pathVerified: true,
    lastVerifiedAt: Date.now(), reusedProxy: { kind: 'direct' } }).observedNodeLabel).toBe('')
})

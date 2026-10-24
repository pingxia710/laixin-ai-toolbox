import { afterEach, expect, it } from 'vitest'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerActions } from '../../app/main/actions/tunnel'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { REJECT_REASONS, type RejectCode } from '../../app/main/tunnel/package-format'
import { computeStatus } from '../../app/main/tunnel/status-service'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

it('all package rejection states remain readable through the registered status action', async () => {
  const dataDir = makeTempDir('audit-status-contract-'); roots.push(dataDir)
  const ordinary = computeStatus({ dataDir, daemonState: undefined, daemonUnexpectedExitAt: undefined,
    componentMissing: [], sshBinary: '' })
  const access = {}
  // Only environmental inputs are supplied; status() and bridge validation run unchanged.
  const service = Object.assign(Object.create(TunnelService.prototype), {
    deps: { dataDir }, rawStatus: () => ordinary,
    supervisor: { isRestoring: () => false }, residentTakeoverInFlight: () => false,
    stopConfirmationPending: () => false, accountTemporary: true, accountAccess: access,
    rejectedConfiguration: undefined as { access: object; code: RejectCode } | undefined
  }) as TunnelService
  const registry = new BridgeRegistry(); registerActions(registry, { service })
  const results: { code: string; backendLength: number; bridge: string }[] = []
  for (const code of Object.keys(REJECT_REASONS) as RejectCode[]) {
    Object.assign(service, { rejectedConfiguration: { access, code } })
    const backendLength = service.status().backend.length
    let bridge = 'ok'
    try { await registry.execute('tunnel.status', undefined) }
    catch (error) { bridge = (error as Error).message }
    results.push({ code, backendLength, bridge })
  }
  expect(results).toHaveLength(23)
  expect(results.filter((entry) => entry.bridge !== 'ok')).toEqual([])
  expect(results.every((entry) => entry.backendLength <= 40)).toBe(true)
})

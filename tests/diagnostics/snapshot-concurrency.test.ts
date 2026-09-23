import { expect, it, vi } from 'vitest'
import type { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import type { ActionDefinition } from '../../app/main/bridge/action-registry'
import { runNetworkDiagnostics } from '../../app/main/network-diagnostics/service'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/dg-rc1-unused' }, clipboard: { writeText: vi.fn() } }))
const { registerActions } = await import('../../app/main/actions/diagnostics')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const wrapped = (value: unknown) => ({ snapshot: JSON.stringify(value) })

function fixture() {
  let clock = Date.parse('2026-09-21T00:00:00Z')
  let counter = 0
  let faultsRead = async (): Promise<[]> => []
  const handlers = new Map<string, (params?: unknown) => unknown>()
  const registry = {
    registerAction: (action: ActionDefinition) => handlers.set(action.name, action.handler),
    execute: async (name: string, params?: unknown) => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`missing action ${name}`)
      return await handler(params) as { snapshot: string }
    }
  }
  const tunnel = () => ({ state: '已连', lastVerifiedAt: new Date(clock).toISOString(), configVersion: '1',
    nodeLabel: 'fixture', unrestored: '', componentMissing: '' })
  handlers.set('networkdiagnostics.run', async () => wrapped(await runNetworkDiagnostics('codex', {
    now: () => clock, status: tunnel, selection: async () => ({ mode: 'official' }), probe: async () => ({ status: 204, durationMs: 1 })
  })))
  handlers.set('aiaccess.status', () => wrapped({ shells: { codex: { selected: 'official' } } }))
  handlers.set('aiaccess.serviceStatus', () => wrapped({ running: false, usage: [] }))
  handlers.set('tunnel.status', tunnel)
  handlers.set('tunnel.repairStatus', () => ({ running: false, phase: 'idle', outcome: 'idle' }))
  const appInfo = () => ({ version: '0.5.14-rc.1', platform: 'darwin', architecture: 'arm64', packaged: true })
  handlers.set('app.info', appInfo)
  handlers.set('shells.inventory', () => wrapped([]))
  handlers.set('desktop.status', () => wrapped({}))
  const copyText = vi.fn()
  const submitReport = vi.fn(async () => ({ receipt: 'LX-TEST-ONLY', uploaded: true, message: 'fixture' }))
  registerActions(registry as unknown as BridgeRegistry, {
    now: () => clock, createId: () => `DG-AAAAAA-${String(++counter).padStart(6, '0')}`,
    recentFaults: () => faultsRead(), recordNetworkFault: async () => undefined, recipesVersion: () => 1,
    installStatus: () => ({ phase: 'idle' }), copyText, submitReport
  })
  return {
    handlers, appInfo, submitReport,
    run: async () => JSON.parse((await registry.execute('diagnostics.run', { software: 'codex' })).snapshot) as { id: string },
    copy: async (id: string) => JSON.parse((await registry.execute('diagnostics.copy', { id })).snapshot) as { copied: boolean; stale: boolean },
    report: async (id: string) => JSON.parse((await registry.execute('diagnostics.report', { id })).snapshot) as { uploaded: boolean; stale: boolean },
    advance: () => { clock += 601_000 },
    delayNextFaultRead: () => {
      const entered = deferred(); const release = deferred()
      faultsRead = async () => { faultsRead = async () => []; entered.resolve(); await release.promise; return [] }
      return { entered: entered.promise, release: release.resolve }
    }
  }
}

it('旧页诊断迟到不覆盖新页已完成的快照，复制与上报继续使用新结果', async () => {
  const f = fixture(); const entered = deferred(); const release = deferred()
  f.handlers.set('app.info', async () => {
    f.handlers.set('app.info', f.appInfo); entered.resolve(); await release.promise; return f.appInfo()
  })
  const old = f.run().catch(() => undefined)
  await entered.promise
  const current = await f.run()
  expect(await f.copy(current.id)).toMatchObject({ copied: true })
  release.resolve(); await old
  expect(await f.copy(current.id)).toMatchObject({ copied: true })
  expect(await f.report(current.id)).toMatchObject({ uploaded: true })
  expect(f.submitReport).toHaveBeenCalledWith(expect.objectContaining({ id: current.id }), [])
})

it('旧复制慢读后发现过期，不能清掉期间生成的新快照', async () => {
  const f = fixture(); const old = await f.run(); const delay = f.delayNextFaultRead()
  const copying = f.copy(old.id)
  await delay.entered; f.advance()
  const current = await f.run()
  delay.release()
  expect(await copying).toMatchObject({ copied: false, stale: true })
  expect(await f.copy(current.id)).toMatchObject({ copied: true })
})

it('新诊断失败后不退回旧诊断，旧任务也不能迟到复活', async () => {
  const f = fixture(); const old = await f.run()
  f.handlers.set('networkdiagnostics.run', () => { throw new Error('fixture failed') })
  await expect(f.run()).rejects.toThrow('DIAGNOSTIC_REPORT_INVALID')
  expect(await f.copy(old.id)).toMatchObject({ copied: false, stale: true })
})

it('旧上报补采集失败时只作废自己，不清除已经完成的新诊断', async () => {
  const f = fixture(); const old = await f.run(); const entered = deferred(); const release = deferred()
  f.submitReport.mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; throw new Error('DIAGNOSTIC_CONTEXT_CHANGED')
  })
  const reporting = f.report(old.id)
  await entered.promise
  const current = await f.run()
  release.resolve()
  expect(await reporting).toMatchObject({ uploaded: false, stale: true })
  expect(await f.copy(current.id)).toMatchObject({ copied: true })
})

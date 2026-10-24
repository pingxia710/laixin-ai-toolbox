// GPT-6 09-13 第二轮复核:Windows 四项设置只还回一部分时,下一轮通道恢复必须能重新接入,⛔ 误判致命停止。
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger } from '../../sidecar/win/ledger.mjs'
import { notifyOwed } from '../../sidecar/win/restore.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

async function connectedHarness() {
  const dataDir = makeTempDir('partial-recovery-review-'); roots.push(dataDir)
  const store = join(dataDir, 'registry.json')
  const base = createAdapter({ FAKE_WININET_STORE: store })
  const controls = { failOverrideRestore: false, offline: false, failNotification: false, notifications: 0 }
  const clock = new FakeClock()
  let killBridge = () => {}
  const adapter = {
    ...base,
    write(ref: { service: string; item: string }, value: Parameters<typeof base.write>[1]) {
      if (controls.failOverrideRestore && ref.item === 'ProxyOverride' && value === null) throw Error('transient write failure')
      return base.write(ref, value)
    },
    broadcastSettingsChanged() {
      controls.notifications++
      if (controls.failNotification) throw Error('transient notification failure')
      return base.broadcastSettingsChanged()
    }
  }
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'review', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => {},
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { if (controls.offline) throw Error('offline') },
      stop: async () => {}, localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => {
      let alive = true
      let lost: (error: Error) => void = () => {}
      killBridge = () => { alive = false; lost(Error('kernel exited')) }
      return { listen: async () => {}, close: async () => { alive = false }, isAlive: () => alive,
        onLost: (callback: (error: Error) => void) => { lost = callback } }
    }
  })
  await daemon.run()
  const view = () => JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
  return { dataDir, controls, clock, daemon, view, kill: () => killBridge(),
    registry: () => JSON.parse(readFileSync(store, 'utf8')),
    ledger: () => loadLedger(dataDir).filter(entry => entry.kind === 'setting').map(entry => ({ item: entry.item, status: entry.status })) }
}

it('WinINET 部分恢复后，下一轮内核重启成功应重新接入，不能误判致命停止', async () => {
  const h = await connectedHarness()
  try {
    expect(h.view().state).toBe('connected')
    h.controls.failOverrideRestore = true
    h.kill(); await flushMicrotasks()
    const partlyRestored = h.ledger()
    expect(partlyRestored).toContainEqual({ item: 'ProxyOverride', status: 'restore-failed' })
    expect(partlyRestored.filter((entry) => entry.status === 'restored')).toHaveLength(3)
    h.controls.failOverrideRestore = false
    h.clock.advance(2000); await flushMicrotasks()
    expect(h.view().state).toBe('connected')
    expect(h.registry().ProxyEnable?.data).toBe('1')
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
  } finally { h.daemon.requestShutdown(); await flushMicrotasks() }
})

it('对照：下一轮上游仍不可达时先完成剩余恢复，之后可以重新接入', async () => {
  const h = await connectedHarness()
  try {
    h.controls.failOverrideRestore = true; h.controls.offline = true
    h.kill(); await flushMicrotasks()
    h.controls.failOverrideRestore = false
    h.clock.advance(2000); await flushMicrotasks()
    expect(h.registry()).toEqual({})
    h.controls.offline = false
    h.clock.advance(4000); await flushMicrotasks()
    expect(h.view().state).toBe('connected')
  } finally { h.daemon.requestShutdown(); await flushMicrotasks() }
})

it('守护在 5 秒后自动补发通知并删除欠账标记', async () => {
  const h = await connectedHarness()
  try {
    h.controls.failNotification = true; h.controls.offline = true
    h.kill(); await flushMicrotasks()
    expect(notifyOwed(h.dataDir)).toBe(true)
    const before = h.controls.notifications
    h.controls.failNotification = false
    h.clock.advance(5000); await flushMicrotasks()
    expect(h.controls.notifications).toBe(before + 1)
    expect(notifyOwed(h.dataDir)).toBe(false)
  } finally { h.daemon.requestShutdown(); await flushMicrotasks() }
})

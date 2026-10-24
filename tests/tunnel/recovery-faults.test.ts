// GPT-6 09-13 复核补的三条恢复故障路径:恢复写入失败不得报已恢复、通知失败要补发、restore 子命令认 preserved。
import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { appendSettingEntry, loadLedger } from '../../sidecar/win/ledger.mjs'
import { restoreLedger } from '../../sidecar/win/restore.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

function harness() {
  const dataDir = makeTempDir('network-review-'); roots.push(dataDir)
  const clock = new FakeClock()
  const state = { value: null as unknown, alive: true, offline: false, writeFails: false, notifyFails: false, notifications: 0 }
  let lose: (error: Error) => void = () => {}
  const adapter = {
    managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: '127.0.0.1:18080' }],
    read: () => state.value,
    write: (_ref: unknown, value: unknown) => { if (value === null && state.writeFails) throw Error('transient registry write failure'); state.value = value },
    broadcastSettingsChanged: () => { state.notifications++; if (state.notifyFails) throw Error('notification unavailable') }
  }
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'review', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => {},
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { if (state.offline) throw Error('offline') },
      stop: async () => {}, localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => state.alive,
      onLost: (callback: (error: Error) => void) => { lose = callback } }) })
  return { dataDir, clock, state, adapter, daemon, lose: () => { state.alive = false; state.offline = true; lose(Error('kernel exited')) },
    view: () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) }
}

it('恢复写入失败不能标记正常上网，后续重连应补做恢复', async () => {
  const h = harness(); await h.daemon.run()
  h.state.writeFails = true; h.lose(); await flushMicrotasks()
  const initial = h.view()
  h.state.writeFails = false
  h.clock.advance(2000); await flushMicrotasks()
  try {
    expect(initial.message).not.toContain('已先恢复电脑正常上网')
    expect(initial.message).toContain('恢复未完成')
    expect(h.state.value).toBe(null)
    expect(loadLedger(h.dataDir).filter(e => e.kind === 'setting').map(e => e.status)).toEqual(['restored'])
    expect(h.view().message).toContain('已先恢复电脑正常上网')
  } finally { h.daemon.requestShutdown(); await flushMicrotasks() }
})

it('恢复通知失败后下一次恢复应补发通知', async () => {
  const h = harness(); await h.daemon.run()
  h.state.notifyFails = true
  const first = restoreLedger(h.dataDir, h.adapter)
  expect(first.notifyFailed).toBe(true)
  const count = h.state.notifications
  h.state.notifyFails = false
  restoreLedger(h.dataDir, h.adapter)
  try { expect(h.state.notifications).toBe(count + 1) }
  finally { h.daemon.requestShutdown(); await flushMicrotasks() }
})

it('真实恢复子命令应把 preserved 终态判为恢复完成', () => {
  const dataDir = makeTempDir('network-review-entry-'); roots.push(dataDir)
  const store = join(dataDir, 'registry.json')
  const adapter = createAdapter({ FAKE_WININET_STORE: store })
  const ref = { service: 'WinINET', item: 'ProxyOverride' }
  appendSettingEntry(dataDir, { ...ref, originalValue: null, writtenValue: { type: 'REG_SZ', data: '<local>;localhost;127.*' }, sessionToken: 'review', time: Date.now() })
  adapter.write(ref, { type: 'REG_SZ', data: 'corp.example' })
  let exitCode = 0
  let output: string
  try {
    output = execFileSync(process.execPath, [join(process.cwd(), 'sidecar/win/tunnel-daemon.mjs'), 'restore', '--data-dir', dataDir,
      '--adapter', join(process.cwd(), 'tests/tunnel/fixtures/fake-wininet-adapter.mjs')], {
      env: { ...process.env, FAKE_WININET_STORE: store }, encoding: 'utf8', timeout: 5000 })
  } catch (error) {
    const failure = error as { status: number; stdout: string }
    exitCode = failure.status; output = String(failure.stdout)
  }
  const ledger = loadLedger(dataDir).filter(e => e.kind === 'setting').map(e => e.status)
  expect(exitCode).toBe(0)
  expect(ledger).toEqual(['preserved'])
  expect(JSON.parse(output)).toMatchObject({ restored: 0, failed: [] })
})

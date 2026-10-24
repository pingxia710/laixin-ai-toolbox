import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { appendSettingEntry } from '../../sidecar/mac/ledger.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const daemon = fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
const adapter = fileURLToPath(new URL('./fixtures/mac-restore-inspection-adapter.mjs', import.meta.url))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

function restore(scenario: string) {
  const root = makeTempDir('laixin-mac-restore-inspection-')
  roots.push(root)
  // A new connection intent skips retry sleeps, not the inspection or result gate.
  writeFileSync(join(root, 'intent.json'), JSON.stringify({ desired: 'connected' }))
  if (scenario === 'restored-ledger') appendSettingEntry(root, {
    service: 'Wi-Fi', item: 'secure-web-proxy', sessionToken: 'local-test', time: 1,
    originalValue: { enabled: false, host: '127.0.0.1', port: 51234 },
    writtenValue: { enabled: true, host: '127.0.0.1', port: 51234 }
  })
  const opsPath = join(root, 'ops.jsonl')
  const run = spawnSync(process.execPath, [daemon, 'restore', '--data-dir', root, '--adapter', adapter], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, MAC_RESTORE_SCENARIO: scenario, MAC_RESTORE_OPS: opsPath }
  })
  expect(run.error).toBeUndefined()
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string; code: string }
  const ops = existsSync(opsPath) ? readFileSync(opsPath, 'utf8') : ''
  return { run, state, ops }
}

it.each(['off', 'live', 'remote', 'restored-ledger'])('Mac 恢复检查使用原生代理字段并正常完成：%s', (scenario) => {
  const { run, state, ops } = restore(scenario)
  expect(run.status).toBe(0)
  expect(state).toMatchObject({ state: 'stopped-restored', code: '' })
  expect(ops).toContain('-listallnetworkservices')
  expect(ops).toContain('-getsecurewebproxy')
  expect(ops).not.toContain('WinINET')
  expect(ops).not.toContain('Disabled')
  if (scenario === 'restored-ledger') expect(ops).toContain('"write":')
  else expect(ops).not.toContain('"write":')
  if (scenario === 'off') expect(ops).not.toContain('identifyPort')
})

it.each([
  ['dead', 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN'],
  ['second-service-dead', 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN'],
  ['ipv6', 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN'],
  ['read-failed', 'TUNNEL_PROXY_INSPECTION_FAILED'],
  ['owner-unreadable', 'TUNNEL_PROXY_INSPECTION_FAILED']
])('Mac 真正不能确认恢复时不假报成功或擅改代理：%s', (scenario, code) => {
  const { run, state, ops } = restore(scenario)
  expect(run.status).toBe(65)
  expect(state).toMatchObject({ state: 'error', code })
  expect(ops).toContain('-listallnetworkservices')
  expect(ops).not.toContain('"write":')
})

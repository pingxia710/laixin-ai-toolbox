import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { appendSettingEntry, loadLedger } from '../../sidecar/win/ledger.mjs'
import { restoreLedger } from '../../sidecar/win/restore.mjs'
import { readRestoreObservation, restoreObservationText, restoreObservationActive } from '../../sidecar/win/restore-observation.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

it.each([
  ['timeout', 'PORT_QUERY_TIMEOUT'], ['command-unavailable', 'PORT_QUERY_UNAVAILABLE'],
  ['permission-denied', 'PORT_QUERY_PERMISSION_DENIED'], ['address-ambiguous', 'PORT_ADDRESS_AMBIGUOUS'],
  ['invalid-result', 'PORT_QUERY_INVALID'], ['SECRET_DO_NOT_COPY', 'PORT_QUERY_FAILED']
])('原因 %s 从识别进入恢复结果，仍不写未知归属设置', (reason, code) => {
  const root = makeTempDir('restore-observation-'); roots.push(root)
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const ref = { service: 'WinINET', item: 'ProxyServer' }
  const value = { type: 'REG_SZ', data: '127.0.0.1:18080' }
  base.write(ref, value)
  appendSettingEntry(root, { ...ref, originalValue: null, writtenValue: value, sessionToken: 'fixture', time: 1 })
  const unknown = restoreLedger(root, { ...base, identifyPortOwner: () => ({ kind: 'unknown', reason }) })
  expect(unknown.reasonCodes).toEqual([code])
  expect(unknown.failed).toHaveLength(1)
  expect(base.read(ref)).toEqual(value)
  expect(JSON.stringify(loadLedger(root))).not.toContain('SECRET_DO_NOT_COPY')
  // 下一次成功取得第三方证据，照旧保留其值并结算，不为诊断改变归属规则。
  const external = restoreLedger(root, { ...base, identifyPortOwner: () => ({ kind: 'other', pid: process.pid + 1 }) })
  expect(external.failed).toHaveLength(0)
  expect(external.keptModified[0].status).toBe('preserved')
  expect(base.read(ref)).toEqual(value)
})

it('自有入口端口不再查询进程归属，端口查询超时也能一次还原', () => {
  const root = makeTempDir('restore-own-port-'); roots.push(root)
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const ref = { service: 'WinINET', item: 'ProxyServer' }
  const value = { type: 'REG_SZ', data: '127.0.0.1:18080' }
  base.write(ref, value)
  appendSettingEntry(root, { ...ref, originalValue: null, writtenValue: value, sessionToken: 'fixture', time: 1 })
  let ownerQueries = 0
  const result = restoreLedger(root, {
    ...base,
    identifyPortOwner: () => { ownerQueries += 1; return { kind: 'unknown', reason: 'timeout' } }
  }, { knownOwnPorts: [18080] })
  expect(result.failed).toHaveLength(0)
  expect(result.restored).toHaveLength(1)
  expect(ownerQueries).toBe(0)
  expect(base.read(ref)).toBeNull()
})

it('旧 state.json bridgePort 不足以绕过第三方端口归属查询', () => {
  const root = makeTempDir('restore-state-port-'); roots.push(root)
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const ref = { service: 'WinINET', item: 'ProxyServer' }
  const value = { type: 'REG_SZ', data: '127.0.0.1:18081' }
  base.write(ref, value)
  appendSettingEntry(root, { ...ref, originalValue: null, writtenValue: value, sessionToken: 'fixture', time: 1 })
  writeFileSync(join(root, 'state.json'), JSON.stringify({ bridgePort: 18081 }))
  let ownerQueries = 0
  let ownerOptions: unknown
  const external = restoreLedger(root, {
    ...base,
    identifyPortOwner: (_port, options) => { ownerQueries += 1; ownerOptions = options; return { kind: 'other', pid: process.pid + 1 } }
  })
  expect(external.failed).toHaveLength(0)
  expect(external.keptModified[0].status).toBe('preserved')
  expect(ownerQueries).toBe(1)
  expect(ownerOptions).toEqual({ fresh: true })
  expect(base.read(ref)).toEqual(value)
})

it('旧 state.json bridgePort 遇到归属不明时保留账目且不写回', () => {
  const root = makeTempDir('restore-state-port-ambiguous-'); roots.push(root)
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const ref = { service: 'WinINET', item: 'ProxyServer' }
  const value = { type: 'REG_SZ', data: '127.0.0.1:18082' }
  base.write(ref, value)
  appendSettingEntry(root, { ...ref, originalValue: null, writtenValue: value, sessionToken: 'fixture', time: 1 })
  writeFileSync(join(root, 'state.json'), JSON.stringify({ bridgePort: 18082 }))
  let ownerQueries = 0
  const unknown = restoreLedger(root, {
    ...base,
    identifyPortOwner: () => { ownerQueries += 1; return { kind: 'unknown', reason: 'address-ambiguous' } }
  })
  expect(unknown.failed).toHaveLength(1)
  expect(unknown.reasonCodes).toEqual(['PORT_ADDRESS_AMBIGUOUS'])
  expect(ownerQueries).toBe(1)
  expect(base.read(ref)).toEqual(value)
})

it('摘要只保留受控字段，历史等待和畸形输入不冒充活动恢复', () => {
  const record = { phase: 'waiting', result: 'unconfirmed', attempts: 3, startedAt: 1000, updatedAt: 2000,
    nextRetryAt: 3000, lastFailureCode: 'PORT_QUERY_TIMEOUT', processPath: 'SECRET_DO_NOT_COPY' }
  expect(readRestoreObservation(record)).not.toHaveProperty('processPath')
  expect(restoreObservationActive(record, 2000)).toBe(true)
  expect(restoreObservationActive(record, 200_000)).toBe(false)
  expect(restoreObservationActive(record, 1000)).toBe(false)
  expect(restoreObservationText(record, 200_000)).toContain('当前进度未确认')
  for (const value of [undefined, {}, { ...record, attempts: -1 }, { ...record, attempts: Infinity },
    { ...record, updatedAt: 0 }, { ...record, phase: 'complete' }, { ...record, result: 'restored' },
    { ...record, nextRetryAt: 9e18 }]) expect(readRestoreObservation(value)).toBeUndefined()
  expect(restoreObservationText({ ...record, lastFailureCode: 'SECRET_DO_NOT_COPY' }, 2000)).not.toContain('SECRET')
  expect(restoreObservationText({ ...record, phase: 'complete', result: 'preserved', nextRetryAt: 0 }, 2000)).toContain('未覆盖')
})

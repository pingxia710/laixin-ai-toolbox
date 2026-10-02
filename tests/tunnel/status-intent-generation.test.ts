// N-27:同一个常驻守护收到新连接意图后，设置锁忙会暂缓写 state.json。
// 席位 runId 虽相同，盘上旧 connected 也不能冒充新意图已连接。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { layout, writeFileAtomic } from '../../app/main/tunnel/paths'
import { ENTRY_STATUS, appendSettingEntry, markEntry } from '../../sidecar/mac/ledger.mjs'
import type { DiagnosisPayload } from '../../app/main/tunnel/diagnosis-reporter'
import type { ResidentBridge } from '../../app/main/tunnel/supervisor'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(removeTempDir) })

it('同 runId 新连接/断开意图未落盘时不沿用旧状态，并保留真实恢复失败', async () => {
  const root = makeTempDir('laixin-n27-status-intent-')
  roots.push(root)
  const dataDir = join(root, 'data')
  const built = buildPackageEntries({})
  const packageDir = writePackageDir(join(root, 'package'), built)
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const reports: DiagnosisPayload[] = []
  const resident: ResidentBridge = {
    armed: () => true, alive: () => true, seatRunId: () => 'same-run', wake: async () => true
  }
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] },
    now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: () => { throw new Error('状态用例不得拉守护') },
    spawnRestore: () => undefined, routesFile: join(sidecarDir, 'routes.default.json'), resident,
    diagnosis: { enabled: () => true, version: () => 'test', send: async (payload) => { reports.push(payload) } } })
  expect((await service.importConfig()).outcome).toBe('imported')
  expect((await service.applyPending()).outcome).toBe('applied')

  // 同一常驻进程上一轮的意图与已连状态匹配，不能误压成“连接中”。
  const connected = { state: 'connected', runId: 'same-run',
    intentToken: 'previous', exitIp: '203.0.113.1', pathVerified: true, lastVerifiedAt: Date.parse('2026-10-01T00:00:00Z') }
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify(connected)}\n`)
  writeFileAtomic(layout.intent(dataDir), `${JSON.stringify({ desired: 'connected', sessionToken: 'previous' })}\n`)
  expect(service.status().state).toBe('已连')

  // 真实 start() 写出新 token；设置锁忙时 state.json 仍停在上一轮 connected。
  expect((await service.start()).outcome).toBe('started')
  const nextToken = (JSON.parse(readFileSync(layout.intent(dataDir), 'utf8')) as { sessionToken: string }).sessionToken
  expect(nextToken).not.toBe('previous')
  expect(service.status().state).toBe('连接中')
  expect(service.status().exitIp).toBe('')
  expect(service.status().pathVerified).toBe(false)

  // 守护后来把本轮状态落盘后，应恢复显示真实“已连”。
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ ...connected, intentToken: nextToken })}\n`)
  expect(service.status().state).toBe('已连')

  const applied = appendSettingEntry(dataDir, { service: 'Wi-Fi', item: 'socks-proxy', originalValue: null,
    writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 }, sessionToken: nextToken, time: 1 })

  // 客户刚点断开时，守护还没回写，上一轮已连及出口都不能冒充本次状态。
  expect((await service.stop()).outcome).toBe('stopped')
  const stopToken = (JSON.parse(readFileSync(layout.intent(dataDir), 'utf8')) as { sessionToken: string }).sessionToken
  expect(stopToken).not.toBe(nextToken)
  expect(service.status().state).toBe('断开中')
  expect(service.status().exitIp).toBe('')
  expect(service.status().unrestored).toBe('')
  expect(service.status().pathVerified).toBe(false)
  expect(reports).toHaveLength(0)
  const internal = service as unknown as { pausedAccount?: string }
  internal.pausedAccount = 'temporarily-unavailable'
  expect(service.status()).toMatchObject({ state: '断开中', message: expect.stringContaining('恢复原网络设置') })
  internal.pausedAccount = undefined
  const stoppingIntent = readFileSync(layout.intent(dataDir), 'utf8')
  expect((await service.stop()).outcome).toBe('stopped')
  expect(readFileSync(layout.intent(dataDir), 'utf8')).toBe(stoppingIntent)
  expect(service.repair()).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_BUSY' })
  expect(await service.start()).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_BUSY' })
  expect(readFileSync(layout.intent(dataDir), 'utf8')).toBe(stoppingIntent)
  expect(reports).toHaveLength(0)

  // 守护已经接收本轮断开、但还在按账本恢复：applied 是进度，不是失败终态。
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ state: 'user-disconnected', runId: 'same-run', intentToken: stopToken })}\n`)
  expect(service.status()).toMatchObject({ state: '断开中', unrestored: '' })
  expect(reports).toHaveLength(0)

  // 旧版状态缺令牌也不能证明本次断开完成，入口不可覆盖断开意图。
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ ...connected, intentToken: undefined })}\n`)
  expect(service.status().state).toBe('断开中')
  expect((await service.start())).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_BUSY' })
  expect(readFileSync(layout.intent(dataDir), 'utf8')).toBe(stoppingIntent)

  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ state: 'error', runId: 'same-run',
    intentToken: nextToken, code: '上游不可达' })}\n`)
  expect(service.status().state).toBe('断开中')
  expect(reports).toHaveLength(0)

  // 旧一轮的完成状态也不能说本次原设置已恢复。
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ state: 'stopped-restored', runId: 'same-run', intentToken: nextToken })}\n`)
  expect(service.status().state).toBe('断开中')
  markEntry(dataDir, applied.id, { status: ENTRY_STATUS.restored, note: 'restored' })
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ state: 'stopped-restored', runId: 'same-run', intentToken: stopToken })}\n`)
  expect(service.status().state).toBe('已停止并恢复原设置')

  // 新一轮连接尚未落盘时，也不能沿用上一轮的“已恢复”。
  expect((await service.start()).outcome).toBe('started')
  expect(service.status().state).toBe('连接中')
  const supervisor = (service as unknown as { supervisor: { unexpectedExit?: { at: number } } }).supervisor
  supervisor.unexpectedExit = { at: Date.parse('2026-09-30T23:59:59Z') }
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ ...connected, runId: 'old-run', intentToken: stopToken })}\n`)
  expect(service.status().state).toBe('连接中')
  writeFileAtomic(layout.state(dataDir), `${JSON.stringify({ state: 'error', runId: 'same-run',
    intentToken: stopToken, code: '上游不可达' })}\n`)
  expect(service.status().state).toBe('连接中')
  expect(reports).toHaveLength(0)

  // 本轮意图之后真正发生的崩溃仍要提示异常，不能被旧状态过滤吞掉。
  supervisor.unexpectedExit = { at: Date.parse('2026-10-01T00:00:01Z') }
  expect(service.status().state).toBe('异常')
  expect(reports.map((report) => report.code)).toEqual(['UNKNOWN'])
  supervisor.unexpectedExit = { at: Date.parse('2026-09-30T23:59:59Z') }

  // 真实的设置恢复失败要高于旧状态令牌的待确认提示。
  const entry = appendSettingEntry(dataDir, { service: 'Wi-Fi', item: 'socks-proxy', originalValue: null,
    writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 }, sessionToken: stopToken, time: 1 })
  markEntry(dataDir, entry.id, { status: ENTRY_STATUS.restoreFailed, note: 'restore failed' })
  expect(service.status().state).toBe('异常')
  expect(service.status().unrestored).toContain('未恢复')
  expect(reports.map((report) => report.code)).toEqual(['UNKNOWN', 'TUNNEL_RESTORE_INCOMPLETE'])
})

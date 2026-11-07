import { expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { RuntimeObservationTelemetryQueue } from '../../app/main/tunnel/runtime-observation-telemetry-queue'
import { isPreOneRuntimeObservationVersion, parseRuntimeObservationEvent } from '../../app/runtime-observation-types'
import { makeTempDir, removeTempDir } from './helpers'

const codec = {
  encrypt: (plain: string) => Buffer.from(plain, 'utf8'),
  decrypt: (encrypted: Buffer) => encrypted.toString('utf8')
}
const samples = [{ at: Date.UTC(2026, 9, 31, 2), state: 'connected', rssBytes: 10_000_000, cpuPercent: 12.3 }] as const

it('只在 1.0 之前打开运行观测，未知版本也关闭', () => {
  expect(isPreOneRuntimeObservationVersion('0.7.5')).toBe(true)
  expect(isPreOneRuntimeObservationVersion('0.7.5-test.1')).toBe(true)
  expect(isPreOneRuntimeObservationVersion('1.0.0')).toBe(false)
  expect(isPreOneRuntimeObservationVersion('1.2.0')).toBe(false)
  expect(isPreOneRuntimeObservationVersion('unknown')).toBe(false)
})

it('安装首连只入队一次，日观测按本地 10/16/20 时段去重', async () => {
  const root = makeTempDir('runtime-observation-telemetry-')
  try {
    let now = new Date(2026, 9, 31, 20, 30).getTime()
    const sent: string[] = []
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => true, platform: 'macos', version: () => '0.7.5',
      now: () => now, send: async (event) => { sent.push(event.kind + ':' + (event.slot ?? 'install')) }
    })
    expect(queue.collectInstall(samples)).toBe(true)
    expect(queue.collectInstall(samples)).toBe(false)
    expect(queue.collectDaily(samples)).toBe(3)
    expect(queue.collectDaily(samples)).toBe(0)
    await queue.flush()
    expect(sent).toEqual(['install:install', 'daily:10', 'daily:16', 'daily:20'])
    expect(queue.pendingCount()).toBe(0)
    expect(JSON.parse(readFileSync(join(root, 'queue.enc'), 'utf8'))).toMatchObject({ installSent: true })
    now += 24 * 60 * 60_000
    expect(queue.collectDaily(samples)).toBe(3)
  } finally { removeTempDir(root) }
})

it('即使本地样本文件暂时缺失，首连仍会上报一次安装类事件', () => {
  const root = makeTempDir('runtime-observation-install-empty-')
  try {
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => true, platform: 'windows', version: () => '0.7.5',
      now: () => Date.UTC(2026, 9, 31, 12), send: async () => undefined
    })
    expect(queue.collectInstall([])).toBe(true)
    expect(queue.pendingCount()).toBe(1)
  } finally { removeTempDir(root) }
})

it('安装事件的 firstConnectedAt 优先取样本中的首次已连接时间', async () => {
  const root = makeTempDir('runtime-observation-first-connected-')
  try {
    const sent: Array<{ firstConnectedAt?: number }> = []
    const now = Date.UTC(2026, 9, 31, 20)
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => true, platform: 'macos', version: () => '0.7.5',
      now: () => now, send: async (event) => { sent.push(event) }
    })
    expect(queue.collectInstall(samples)).toBe(true)
    await queue.flush()
    expect(sent[0]?.firstConnectedAt).toBe(samples[0].at)
  } finally { removeTempDir(root) }
})

it('日观测在一次收集内固定同一个时间快照', () => {
  const root = makeTempDir('runtime-observation-time-snapshot-')
  try {
    let calls = 0
    const snapshot = new Date(2026, 9, 31, 20, 30).getTime()
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => true, platform: 'macos', version: () => '0.7.5',
      now: () => { calls += 1; return snapshot }, send: async () => undefined
    })
    expect(queue.collectDaily(samples)).toBe(3)
    expect(calls).toBe(1)
  } finally { removeTempDir(root) }
})

it('本地持久化暂时失败时仍保留内存中的待发送事件', async () => {
  const root = makeTempDir('runtime-observation-persist-retry-')
  try {
    let fail = true
    const failingCodec = {
      encrypt: (plain: string) => { if (fail) throw new Error('disk-or-keychain-temporary'); return Buffer.from(plain, 'utf8') },
      decrypt: (encrypted: Buffer) => encrypted.toString('utf8')
    }
    const sent: string[] = []
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec: failingCodec, enabled: () => true, platform: 'macos', version: () => '0.7.5',
      now: () => Date.UTC(2026, 9, 31, 12), send: async (event) => { sent.push(event.kind) }
    })
    expect(queue.collectInstall(samples)).toBe(true)
    expect(queue.pendingCount()).toBe(1)
    fail = false
    await queue.flush()
    expect(sent).toEqual(['install'])
    expect(queue.pendingCount()).toBe(0)
  } finally { removeTempDir(root) }
})

it('1.0 阶段不采集，也不向队列写入', () => {
  const root = makeTempDir('runtime-observation-disabled-')
  try {
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => false, platform: 'windows', version: () => '1.0.0',
      now: () => Date.UTC(2026, 9, 31, 20), send: async () => undefined
    })
    expect(queue.collectInstall(samples)).toBe(false)
    expect(queue.collectDaily(samples)).toBe(0)
    expect(queue.pendingCount()).toBe(0)
  } finally { removeTempDir(root) }
})

it('1.0 阶段不读取旧的运行观测队列', () => {
  const root = makeTempDir('runtime-observation-disabled-read-')
  try {
    const disabledCodec = {
      encrypt: (plain: string) => Buffer.from(plain, 'utf8'),
      decrypt: () => { throw new Error('must-not-read') }
    }
    expect(() => new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec: disabledCodec, enabled: () => false, platform: 'macos', version: () => '1.0.0',
      now: () => Date.UTC(2026, 9, 31, 12), send: async () => undefined
    })).not.toThrow()
  } finally { removeTempDir(root) }
})

it('运行观测事件拒绝自由字段和 1.0 版本', () => {
  const base = { eventId: '00000000-0000-4000-8000-000000000001', kind: 'daily', clientVersion: '0.7.5', platform: 'macos', at: 1_700_000_000_000, slot: '10', samples }
  expect(parseRuntimeObservationEvent(base)).toMatchObject({ kind: 'daily', slot: '10' })
  expect(parseRuntimeObservationEvent({ ...base, extra: 'secret' })).toBeUndefined()
  expect(parseRuntimeObservationEvent({ ...base, firstConnectedAt: 1_700_000_000_000 })).toBeUndefined()
  expect(parseRuntimeObservationEvent({ ...base, clientVersion: '1.0.0' })).toBeUndefined()
})

it('并发 flush 不会重复删除或跳过待发送事件', async () => {
  const root = makeTempDir('runtime-observation-telemetry-concurrent-')
  try {
    let release!: () => void
    let started!: () => void
    const sending = new Promise<void>((resolve) => { release = resolve })
    const firstStarted = new Promise<void>((resolve) => { started = resolve })
    const sent: string[] = []
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => true, platform: 'macos', version: () => '0.7.5',
      now: () => new Date(2026, 9, 31, 20, 30).getTime(), send: async (event) => {
        sent.push(event.kind + ':' + (event.slot ?? 'install'))
        if (sent.length === 1) { started(); await sending }
      }
    })
    queue.collectInstall(samples)
    queue.collectDaily(samples)
    const first = queue.flush()
    await firstStarted
    const second = queue.flush()
    release()
    await Promise.all([first, second])
    expect(sent).toEqual(['install:install', 'daily:10', 'daily:16', 'daily:20'])
    expect(queue.pendingCount()).toBe(0)
  } finally { removeTempDir(root) }
})

it('离线队列淘汰事件时会释放对应时段，后续可重新补齐', () => {
  const root = makeTempDir('runtime-observation-telemetry-cap-')
  try {
    let now = new Date(2026, 9, 1, 20, 30).getTime()
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => true, platform: 'macos', version: () => '0.7.5',
      now: () => now, send: async () => undefined
    })
    for (let day = 0; day < 12; day += 1) {
      now = new Date(2026, 9, 1 + day, 20, 30).getTime()
      queue.collectDaily(samples)
    }
    expect(queue.pendingCount()).toBe(32)
    now = new Date(2026, 9, 1, 20, 30).getTime()
    expect(queue.collectDaily(samples)).toBe(3)
  } finally { removeTempDir(root) }
})

it('换号时清空旧账号离线事件，不能串发到新账号', async () => {
  const root = makeTempDir('runtime-observation-telemetry-account-')
  try {
    let accountId: string | undefined = 'customer-a'
    const sent: string[] = []
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath: join(root, 'queue.enc'), codec, enabled: () => true, platform: 'macos', version: () => '0.7.5',
      accountId: () => accountId, now: () => Date.UTC(2026, 9, 31, 12),
      send: async (event) => { sent.push(event.eventId) }
    })
    expect(queue.collectInstall(samples)).toBe(true)
    accountId = 'customer-b'
    expect(queue.collectInstall(samples)).toBe(true)
    await queue.flush()
    expect(sent).toHaveLength(1)
    expect(queue.hasInstallationSent()).toBe(true)
  } finally { removeTempDir(root) }
})

it('首次绑定账号时丢弃无归属旧队列，安装事件不会被旧 installSent 卡住', () => {
  const root = makeTempDir('runtime-observation-telemetry-legacy-')
  try {
    const queuePath = join(root, 'queue.enc')
    writeFileSync(queuePath, JSON.stringify({ events: [], processedSlots: [], installSent: true }), { mode: 0o600 })
    const queue = new RuntimeObservationTelemetryQueue({
      queuePath, codec, enabled: () => true, platform: 'macos', version: () => '0.7.5', accountId: () => 'customer-a',
      now: () => Date.UTC(2026, 9, 31, 12), send: async () => undefined
    })
    expect(queue.collectInstall(samples)).toBe(true)
  } finally { removeTempDir(root) }
})

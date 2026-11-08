import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  appendRuntimeObservation, buildRuntimeObservationSample, readRuntimeObservations,
  runtimeObservationPath, sanitizeRuntimeObservationSample, writeRuntimeObservations
} from '../../sidecar/shared/runtime-observation.mjs'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { FakeClock, makeTempDir, removeTempDir, readJsonFile } from './helpers'

it('运行观测只保留白名单字段，不把地址、令牌或自由文本带入样本', () => {
  const sample = sanitizeRuntimeObservationSample({
    at: 1_700_000_000_000, state: 'connected', stage: 'path-verify-after-settings', reconnectAttempts: 2,
    rssBytes: 123_456, cpuPercent: 34.56, endpoint: 'https://node.example.com', sessionToken: 'secret-token'
  })
  expect(sample).toEqual({ at: 1_700_000_000_000, state: 'connected', stage: 'path-verify-after-settings', reconnectAttempts: 2,
    rssBytes: 123_456, cpuPercent: 34.6 })
  expect(JSON.stringify(sample)).not.toContain('node.example.com')
  expect(JSON.stringify(sample)).not.toContain('secret-token')
  expect(sanitizeRuntimeObservationSample({ at: 1, state: 'unknown-state' })).toBeUndefined()
})

it('按两个采样点计算 CPU 趋势，并保留流量与内存数值', () => {
  const result = buildRuntimeObservationSample({
    at: 2_000, state: 'connected', reconnectAttempts: 0,
    traffic: { activeStreams: 3, uploadBytes: 20_000, downloadBytes: 40_000 },
    memoryUsage: { rss: 10_000_000, heapUsed: 4_000_000 },
    cpuUsage: { user: 500_000, system: 100_000 }, previous: { at: 1_000, user: 100_000, system: 0 }
  })
  expect(result?.sample).toMatchObject({ state: 'connected', activeStreams: 3, uploadBytes: 20_000, downloadBytes: 40_000,
    rssBytes: 10_000_000, heapUsedBytes: 4_000_000, cpuPercent: 50 })
})

it('运行观测原子写盘并裁剪为环形记录', () => {
  const root = makeTempDir('runtime-observation-')
  try {
    const path = runtimeObservationPath(join(root, 'tunnel'))
    const samples = Array.from({ length: 4 }, (_, index) => ({ at: index + 1, state: 'connected' }))
    writeRuntimeObservations(path, samples)
    const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number; samples: unknown[] }
    expect(file.version).toBe(1)
    expect(readRuntimeObservations(path)).toHaveLength(4)
    expect(appendRuntimeObservation(samples, { at: 5, state: 'error' }, 4).map((item) => item.at)).toEqual([2, 3, 4, 5])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'tunnel')).mode & 0o777).toBe(0o700)
  } finally { removeTempDir(root) }
})

it('守护启动后实际写入运行观测，并按采样周期追加样本', async () => {
  const root = makeTempDir('runtime-observation-daemon-')
  try {
    const clock = new FakeClock()
    const daemon = createDaemon({ clientVersion: '0.7.5', dataDir: root, clock, runtimeObservationIntervalMs: 1_000,
      adapter: { managedItems: () => [], read: () => undefined, write: () => undefined },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined,
        localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined }),
      parentAlive: () => true, onExit: () => undefined })
    await daemon.run()
    const path = runtimeObservationPath(root)
    expect(readJsonFile<{ samples: unknown[] }>(path).samples).toHaveLength(1)
    clock.advance(1_000)
    expect(readJsonFile<{ samples: unknown[] }>(path).samples).toHaveLength(2)
    daemon.requestShutdown()
  } finally { removeTempDir(root) }
})

it('客户端版本达到 1.0 后守护不再创建运行观测文件', async () => {
  const root = makeTempDir('runtime-observation-v1-')
  try {
    const clock = new FakeClock()
    const daemon = createDaemon({ clientVersion: '1.0.0', dataDir: root, clock,
      adapter: { managedItems: () => [], read: () => undefined, write: () => undefined },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined,
        localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined }),
      parentAlive: () => true, onExit: () => undefined })
    await daemon.run()
    expect(() => readJsonFile(runtimeObservationPath(root))).toThrow()
    daemon.requestShutdown()
  } finally { removeTempDir(root) }
})

it('升级停采标记出现后，仍在运行的旧守护停止继续写样本', async () => {
  const root = makeTempDir('runtime-observation-stop-marker-')
  try {
    const clock = new FakeClock()
    const daemon = createDaemon({ clientVersion: '0.7.5', dataDir: root, clock, runtimeObservationIntervalMs: 1_000,
      adapter: { managedItems: () => [], read: () => undefined, write: () => undefined },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined,
        localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined }),
      parentAlive: () => true, onExit: () => undefined })
    await daemon.run()
    const path = runtimeObservationPath(root)
    const before = readJsonFile<{ samples: unknown[] }>(path).samples.length
    writeFileSync(join(root, 'runtime-observation.disabled'), '1\n', { mode: 0o600 })
    clock.advance(1_000)
    expect(readJsonFile<{ samples: unknown[] }>(path).samples).toHaveLength(before)
    daemon.requestShutdown()
  } finally { removeTempDir(root) }
})

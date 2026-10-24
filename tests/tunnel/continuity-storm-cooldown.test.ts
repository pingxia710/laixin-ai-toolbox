// P2(网络数据面优化):logContinuity 去重按 per-key 冷却。只比「上一个 key」时,重连风暴里
// connecting↔error(code) 交替,相邻 key 永远不同,每次都过闸并置 continuityPending(下游
// 取证子进程每次都被拉起)。改后:同 key 在心跳窗口内只过一次;不同 key 首次必过;
// connected 心跳节律不变。变异自证:改回只比上一个 key → 本用例红(取证次数 2 → 20)。
import { afterEach, expect, it } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

interface Writer {
  writeStateNow(state: string, extra?: { code?: string; lastVerifiedAt?: number }): boolean
}

it('重连风暴交替键:同 key 心跳窗口内不重复触发取证;不同 key 首次必过;connected 节律不变', async () => {
  const root = makeTempDir('netopt-storm-')
  roots.push(root)
  const clock = new FakeClock()
  const lines: string[] = []
  let facesCalls = 0
  const daemon = createDaemon({
    dataDir: root, clock,
    adapter: { read: () => null, write: () => {}, managedItems: () => [] },
    connectorFactory: () => { throw new Error('unused') },
    bridgeFactory: () => { throw new Error('unused') },
    parentAlive: () => true, onExit: () => {},
    log: (line: string) => lines.push(line), continuityEvidence: true,
    readContinuityFaces: async () => { facesCalls += 1; return undefined }
  }) as unknown as Writer
  // 风暴:connecting ↔ error(code) 各 10 次,间隔远小于心跳窗口。
  for (let round = 0; round < 10; round += 1) {
    clock.advance(100)
    daemon.writeStateNow('connecting')
    clock.advance(100)
    daemon.writeStateNow('error', { code: 'TUNNEL_UPSTREAM_UNREACHABLE' })
  }
  await flushMicrotasks()
  await flushMicrotasks()
  const transitions = () => lines.filter((line) => line.includes('"phase":"transition"')).length
  expect(transitions()).toBeLessThanOrEqual(2)
  expect(facesCalls).toBeLessThanOrEqual(2)
  // 窗口过后同 key 恢复放行(风暴仍在继续时,取证按心跳节律补一次)。
  clock.advance(5 * 60_000 + 1)
  daemon.writeStateNow('connecting')
  await flushMicrotasks()
  await flushMicrotasks()
  expect(transitions()).toBeLessThanOrEqual(3)
  // connected 心跳节律不变:窗口内重复不记,窗口外再记。
  daemon.writeStateNow('connected', { lastVerifiedAt: clock.now() })
  daemon.writeStateNow('connected', { lastVerifiedAt: clock.now() })
  await flushMicrotasks()
  await flushMicrotasks()
  expect(transitions()).toBeLessThanOrEqual(4)
  clock.advance(5 * 60_000 + 1)
  daemon.writeStateNow('connected', { lastVerifiedAt: clock.now() })
  await flushMicrotasks()
  await flushMicrotasks()
  expect(transitions()).toBeLessThanOrEqual(5)
  expect(transitions()).toBeGreaterThanOrEqual(4)
}, 30_000)

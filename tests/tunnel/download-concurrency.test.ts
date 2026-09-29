// DL-01: Windows 的 Delivery Optimization 会把 Microsoft Store 大包拆成大量 HTTP 分块。
// 现场同一 Codex 桌面包在网络一般时 1–4 条通道流约 1.9 MB/s、25 条会拥塞；网络好时
// 25 条又能跑得很高。控制器必须从 4 条起步，按当次聚合吞吐逐级放大，不能写死四条。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Socket } from 'node:net'
import { createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import { createDeliveryOptimizationAdmission } from '../../sidecar/mac/download-concurrency.mjs'
import { socks5Connect } from '../../sidecar/mac/socks5.mjs'
import { makeTempDir, removeTempDir, startFakeSocks5Server, type FakeSocks5, waitFor } from './helpers'

const deliveryHost = 'content.dl.delivery.mp.microsoft.com'

describe('DL-01：Microsoft Store 分块下载的通道并发上限', () => {
  let dataDir: string
  let bridge: ReturnType<typeof createLocalBridge> | undefined
  let upstream: FakeSocks5 | undefined
  let target: ReturnType<typeof createServer> | undefined
  const targetSockets = new Set<Socket>()

  beforeEach(async () => {
    dataDir = makeTempDir('toolbox-download-gate-')
    target = createServer((socket) => {
      targetSockets.add(socket)
      socket.on('error', () => undefined)
      socket.on('close', () => targetSockets.delete(socket))
      // 目标保持连接，模拟尚未下载完的 1 MB 分块。
    })
    await new Promise<void>((resolve) => target!.listen(0, '127.0.0.1', resolve))
    const address = target.address()
    if (address === null || typeof address === 'string') throw new Error('测试目标未监听')
    upstream = await startFakeSocks5Server({ [`${deliveryHost}:80`]: ['127.0.0.1', address.port] })
    bridge = createLocalBridge({
      listenPort: 0,
      dataDir,
      upstream: { host: '127.0.0.1', port: upstream.port },
      // Xray 的 GeoSite 里可能把 microsoft.com 归到直连；这里显式压到假上游，才可观测准入数量。
      routes: { protectedDirectSuffixes: [], directSuffixes: [], tunnelSuffixes: ['delivery.mp.microsoft.com'] }
    })
    await bridge.listen()
  })

  afterEach(async () => {
    await bridge?.close()
    await upstream?.close()
    for (const socket of targetSockets) socket.destroy()
    await new Promise<void>((resolve) => target?.close(() => resolve()))
    removeTempDir(dataDir)
  })

  it('当次没有吞吐样本时，先只让四条 Microsoft Store 分块进入通道', async () => {
    const open = () => socks5Connect({ host: '127.0.0.1', port: bridge!.port(), targetHost: deliveryHost, targetPort: 80 })
    const firstFour = await Promise.all([open(), open(), open(), open()])
    await waitFor(() => upstream!.hits().length === 4)
    expect(upstream!.hits()).toHaveLength(4)

    let fifthOpened = false
    const fifth = open().then((socket) => { fifthOpened = true; return socket })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(fifthOpened).toBe(false)
    expect(upstream!.hits()).toHaveLength(4)

    firstFour[0].destroy()
    await waitFor(() => fifthOpened)
    expect(upstream!.hits()).toHaveLength(5)

    for (const socket of [...firstFour.slice(1), await fifth]) socket.destroy()
  })
})

describe('DL-01：按当次吞吐自适应扩缩 Microsoft Store 分块并发', () => {
  it('吞吐逐级增加时可扩到 25 条，网络好时不人为限速', async () => {
    let now = 0
    const admission = createDeliveryOptimizationAdmission({ now: () => now, sampleWindowMs: 1_000, minSampleBytes: 100 })
    const lease = await admission.acquire(deliveryHost)
    if (lease === undefined) throw new Error('Delivery Optimization 主机应受控制')

    for (const expected of [8, 12, 16, 20, 25]) {
      now += 1_000
      lease.noteBytes(1_000)
      expect(admission.status().concurrentLimit).toBe(expected)
    }
    lease.release()
  })

  it('新增并发使吞吐明显下降时退回已验证的档位，并在冷却期内不反复冲回高并发', async () => {
    let now = 0
    const admission = createDeliveryOptimizationAdmission({ now: () => now, sampleWindowMs: 1_000, minSampleBytes: 100, retryCooldownMs: 10_000 })
    const lease = await admission.acquire(deliveryHost)
    if (lease === undefined) throw new Error('Delivery Optimization 主机应受控制')

    now += 1_000
    lease.noteBytes(1_000) // 4 条的基线，试探到 8 条。
    expect(admission.status().concurrentLimit).toBe(8)

    now += 1_000
    lease.noteBytes(400) // 低于基线的 80%，退回 4 条。
    expect(admission.status().concurrentLimit).toBe(4)

    now += 1_000
    lease.noteBytes(1_000)
    expect(admission.status().concurrentLimit).toBe(4)
    lease.release()
  })

  it('已扩到 25 条后线路转差，也会降一档而不是继续保持高并发', async () => {
    let now = 0
    const admission = createDeliveryOptimizationAdmission({ now: () => now, sampleWindowMs: 1_000, minSampleBytes: 100 })
    const lease = await admission.acquire(deliveryHost)
    if (lease === undefined) throw new Error('Delivery Optimization 主机应受控制')

    for (let index = 0; index < 5; index += 1) {
      now += 1_000
      lease.noteBytes(1_000)
    }
    expect(admission.status().concurrentLimit).toBe(25)

    now += 1_000
    lease.noteBytes(400)
    expect(admission.status().concurrentLimit).toBe(20)
    lease.release()
  })

  it('高档吞吐持续下降时逐级退到四条，冷却后可以重新探索到 25 条', async () => {
    let now = 0
    const admission = createDeliveryOptimizationAdmission({ now: () => now, sampleWindowMs: 1_000, minSampleBytes: 100, retryCooldownMs: 10_000 })
    const lease = await admission.acquire(deliveryHost)
    if (lease === undefined) throw new Error('Delivery Optimization 主机应受控制')
    const sample = (bytes: number) => { now += 1_000; lease.noteBytes(bytes) }

    for (let index = 0; index < 6; index += 1) sample(10_000)
    expect(admission.status()).toMatchObject({ concurrentLimit: 25, provenLimit: 25 })
    for (const expected of [20, 16, 12, 8, 4]) {
      sample(1_000)
      expect(admission.status()).toMatchObject({ concurrentLimit: expected, provenLimit: expected })
    }
    for (let index = 0; index < 9; index += 1) {
      sample(1_000)
      expect(admission.status().concurrentLimit).toBe(4)
    }
    // 低档的新基线已经稳定；网络重新改善后仍可升档，不锁死在旧的高吞吐基线。
    for (const expected of [8, 12, 16, 20, 25]) {
      sample(2_000)
      expect(admission.status().concurrentLimit).toBe(expected)
    }
    lease.release()
  })

  it('降档保留已获准连接，只有空位足够时才放行新连接，普通域名不排队', async () => {
    let now = 0
    const admission = createDeliveryOptimizationAdmission({ now: () => now, sampleWindowMs: 1_000, minSampleBytes: 100 })
    const leases = await Promise.all(Array.from({ length: 4 }, () => admission.acquire(deliveryHost)))
    const sample = (bytes: number) => { now += 1_000; leases[0]!.noteBytes(bytes) }
    for (let index = 0; index < 6; index += 1) sample(10_000)
    leases.push(...await Promise.all(Array.from({ length: 21 }, () => admission.acquire(deliveryHost))))
    let admitted = false
    const waiting = admission.acquire(deliveryHost).then(lease => { admitted = true; return lease })

    for (let index = 0; index < 5; index += 1) sample(1_000)
    expect(admission.status()).toEqual({ active: 25, queued: 1, concurrentLimit: 4, provenLimit: 4 })
    await expect(admission.acquire('api.example.test')).resolves.toBeUndefined()
    for (const lease of leases.slice(0, 21)) lease!.release()
    await Promise.resolve()
    expect(admitted).toBe(false)
    leases[21]!.release()
    const last = await waiting
    expect(admitted).toBe(true)
    expect(admission.status()).toMatchObject({ active: 4, queued: 0 })
    for (const lease of leases.slice(22)) lease!.release()
    last!.release()
    expect(admission.status().active).toBe(0)
  })
})

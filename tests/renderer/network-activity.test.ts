import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeNetworkActivity, readTrafficSample, refreshNetworkActivity, type NetworkActivity } from '../../app/renderer/src/ui/network-activity'

const connected = { state: '已连', traffic: '上传 1.2 MB/秒 · 下载 8.4 MB/秒 · 累计 25 MB' }
const status = vi.fn()
const visibility = { visibilityState: 'visible' }
let stop = () => undefined as void
let latest: NetworkActivity

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T10:00:00Z'))
  vi.stubGlobal('window', { toolbox: { tunnel: { status } } })
  visibility.visibilityState = 'visible'; vi.stubGlobal('document', visibility)
  status.mockReset().mockResolvedValue(connected)
})
afterEach(() => { stop(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('仪表盘速率读数', () => {
  it('沿用本机汇总的单位和精度，零速率与未知分开', () => {
    expect(readTrafficSample(connected.traffic, 100)).toMatchObject({ upload: 1.2 * 1024 ** 2, download: 8.4 * 1024 ** 2, uploadLabel: '1.2 MB/s', at: 100 })
    expect(readTrafficSample('上传 0 B/秒 · 下载 9.5 KB/秒 · 累计 1 MB', 100)).toMatchObject({ upload: 0, download: 9.5 * 1024 })
    for (const invalid of [undefined, '', '读取失败', '上传 -1 B/秒 · 下载 0 B/秒 · 累计 0 B']) expect(readTrafficSample(invalid, 100)).toBeUndefined()
  })

  it('读取失败或断开立即清空旧曲线，不能继续显示已连接速率', async () => {
    stop = observeNetworkActivity((value) => { latest = value })
    await refreshNetworkActivity(); expect(latest.samples).toHaveLength(1)
    status.mockRejectedValueOnce(Error('unavailable'))
    await refreshNetworkActivity(); expect(latest).toEqual({ kind: 'unavailable', samples: [] })
    status.mockResolvedValueOnce({ ...connected, state: '用户主动断开' })
    await refreshNetworkActivity(); expect(latest.samples).toEqual([])
    status.mockResolvedValueOnce({ ...connected, traffic: '' })
    await refreshNetworkActivity(); expect(latest.samples).toEqual([])
  })

  it('只保留最近一分钟实际读数，隐藏窗口期间不读取', async () => {
    stop = observeNetworkActivity((value) => { latest = value })
    await refreshNetworkActivity()
    await vi.advanceTimersByTimeAsync(70_000)
    expect(latest.samples.length).toBeLessThanOrEqual(31)
    expect(latest.samples.every((sample) => sample.at > Date.now() - 60_000)).toBe(true)
    const count = status.mock.calls.length
    visibility.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(30_000)
    expect(status).toHaveBeenCalledTimes(count)
    visibility.visibilityState = 'visible'
    await vi.advanceTimersByTimeAsync(2_000)
    expect(latest.samples).toHaveLength(1)
  })

  it('离开仪表盘后停止读取，快速返回不产生重复轮询', async () => {
    let resolve: (value: typeof connected) => void = () => undefined
    status.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    stop = observeNetworkActivity(() => undefined)
    stop()
    stop = observeNetworkActivity((value) => { latest = value })
    resolve(connected); await refreshNetworkActivity()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(status).toHaveBeenCalledTimes(3)
    stop(); const count = status.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(status).toHaveBeenCalledTimes(count)
  })
})

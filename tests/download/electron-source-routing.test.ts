import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

afterEach(() => { vi.doUnmock('electron'); vi.resetModules(); vi.useRealTimers() })

function fixtureItem(overrides: Partial<Record<string, unknown>> = {}) {
  return Object.assign(new EventEmitter(), {
    setSavePath: vi.fn(), getState: () => 'progressing', canResume: () => true,
    getReceivedBytes: () => 0, getTotalBytes: () => 20, getETag: () => 'etag-fixture',
    getLastModifiedTime: () => '', getMimeType: () => 'application/octet-stream',
    getURLChain: () => ['https://downloads.example.cn/app.dmg'],
    resume: vi.fn(), cancel: vi.fn(), ...overrides
  })
}

function fixtureSession(item: ReturnType<typeof fixtureItem>, hooks: { clearStorageData: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> }) {
  const downloadSession = Object.assign(new EventEmitter(), {
    setProxy: async () => undefined,
    webRequest: { onBeforeRequest: vi.fn() },
    clearStorageData: hooks.clearStorageData,
    closeAllConnections: hooks.closeAllConnections,
    downloadURL: () => { downloadSession.emit('will-download', undefined, item) }
  })
  return downloadSession
}

describe('仅改变工具箱本次下载会话的路由', () => {
  it('Electron 仅发 updated 中断事件时也能恢复，并去除重复中断通知', async () => {
    const item = fixtureItem()
    const downloadSession = fixtureSession(item, { clearStorageData: vi.fn(), closeAllConnections: vi.fn() })
    vi.doMock('electron', () => ({ session: { fromPartition: () => downloadSession } }))
    const { ElectronDownloadEngine } = await import('../../app/main/download/electron-download-engine')
    const transfer = await new ElectronDownloadEngine().start({ taskId: 'interrupt', assetUrl: 'https://downloads.example.cn/app.dmg', allowedHosts: ['downloads.example.cn'], network: 'direct', proxyUrl: '', partPath: '/tmp/interrupt-fixture.part' })
    item.emit('updated', undefined, 'interrupted')
    item.emit('updated', undefined, 'interrupted')
    expect(await transfer.waitForCompletion()).toMatchObject({ state: 'interrupted', canResume: true })
    transfer.resume()
    item.emit('done', undefined, 'completed')
    expect(await transfer.waitForCompletion()).toMatchObject({ state: 'completed', canResume: false })
    expect(item.resume).toHaveBeenCalledOnce()
  })

  it('直连来源明确使用 direct，不继承系统代理；通道来源使用固定代理', async () => {
    const modes: unknown[] = []
    const partitions: string[] = []
    let willDownload: (_event: unknown, item: unknown) => void
    const session = {
      setProxy: async (value: unknown) => { modes.push(value) },
      webRequest: { onBeforeRequest: vi.fn() },
      clearStorageData: vi.fn(),
      closeAllConnections: vi.fn(),
      once: (_event: string, callback: typeof willDownload) => { willDownload = callback },
      removeListener: vi.fn(),
      downloadURL: () => { willDownload(undefined, { setSavePath: vi.fn(), on: vi.fn(), getState: () => 'progressing' }) }
    }
    vi.doMock('electron', () => ({ session: { fromPartition: (partition: string) => { partitions.push(partition); return session } } }))
    const { ElectronDownloadEngine } = await import('../../app/main/download/electron-download-engine')
    const engine = new ElectronDownloadEngine()
    const request = { taskId: 'source-routing', assetUrl: 'https://downloads.example.cn/app.dmg', allowedHosts: ['downloads.example.cn'], proxyUrl: '', partPath: '/tmp/source-routing-fixture.part' }
    await engine.start({ ...request, network: 'direct' })
    await engine.start({ ...request, network: 'tunnel', proxyUrl: 'http://127.0.0.1:19080' })
    expect(modes).toEqual([{ mode: 'direct' }, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:19080', proxyBypassRules: '<-loopback>' }])
    // 内存分区(无 persist: 前缀):cookie/缓存不落盘,userData/Partitions 不再随任务增长。
    expect(partitions.every((name) => name === 'toolbox-download-source-routing')).toBe(true)
    await expect(engine.start({ ...request, network: 'tunnel' })).rejects.toThrow('DOWNLOAD_PROXY_REQUIRED')
    expect(modes.length).toBe(2)
  })

  it('下载分区不带 persist: 前缀，终态释放时清空该分区存储', async () => {
    const item = fixtureItem()
    const clearStorageData = vi.fn(async () => undefined)
    const closeAllConnections = vi.fn(async () => undefined)
    const partitions: string[] = []
    const downloadSession = fixtureSession(item, { clearStorageData, closeAllConnections })
    vi.doMock('electron', () => ({ session: { fromPartition: (partition: string) => { partitions.push(partition); return downloadSession } } }))
    const { ElectronDownloadEngine } = await import('../../app/main/download/electron-download-engine')
    const engine = new ElectronDownloadEngine()
    const transfer = await engine.start({ taskId: 'release-partition', sourceId: 'official', assetUrl: 'https://downloads.example.cn/app.dmg', allowedHosts: ['downloads.example.cn'], network: 'direct', proxyUrl: '', partPath: '/tmp/release-fixture.part' })
    expect(partitions).toEqual(['toolbox-download-release-partition-official'])
    expect(partitions[0].startsWith('persist:')).toBe(false)
    expect(clearStorageData).not.toHaveBeenCalled()
    await transfer.release!()
    expect(closeAllConnections).toHaveBeenCalledOnce()
    expect(clearStorageData).toHaveBeenCalledOnce()
  })

  it('传输开始后 60 秒无新字节即判 stall,走可续传中断;不把随后的 cancelled 当用户取消', async () => {
    vi.useFakeTimers()
    let received = 0
    const item = fixtureItem({
      getReceivedBytes: () => received,
      cancel: vi.fn(() => { item.emit('done', undefined, 'cancelled') })
    })
    const downloadSession = fixtureSession(item, { clearStorageData: vi.fn(), closeAllConnections: vi.fn() })
    vi.doMock('electron', () => ({ session: { fromPartition: () => downloadSession } }))
    const { ElectronDownloadEngine } = await import('../../app/main/download/electron-download-engine')
    const engine = new ElectronDownloadEngine()
    const transfer = await engine.start({ taskId: 'stall-watchdog', assetUrl: 'https://downloads.example.cn/app.dmg', allowedHosts: ['downloads.example.cn'], network: 'direct', proxyUrl: '', partPath: '/tmp/stall-fixture.part' })
    const settled = transfer.waitForCompletion()
    // 传输开始后持续有字节推进:不判 stall。
    for (let second = 1; second <= 6; second += 1) {
      received += 1024
      item.emit('updated', undefined, 'progressing')
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(item.cancel).not.toHaveBeenCalled()
    // 最后一次字节后 60 秒无字节 → stall 中断,可续传,并主动取消底层传输。
    await vi.advanceTimersByTimeAsync(55_000)
    expect(await settled).toMatchObject({ state: 'interrupted', canResume: true, etag: 'etag-fixture' })
    expect(item.cancel).toHaveBeenCalledOnce()
    // stall 后 item.cancel() 引发的 done(cancelled) 被吞掉,恢复后不再有陈旧完成事件。
    transfer.resume()
    item.emit('done', undefined, 'completed')
    expect(await transfer.waitForCompletion()).toMatchObject({ state: 'completed' })
  })
})

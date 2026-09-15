// B1:启动失败的两条路径(15s 超时 / downloadURL 同步抛错)都不碰 downloadSession——
// 唯一的释放入口 release() 挂在「start 成功才返回」的 transfer 上。于是分区 Session、
// 代理规则与 once('will-download') 监听全部残留,而每次 retry 都是一个新的 taskId、新的分区。
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.doUnmock('electron'); vi.resetModules(); vi.useRealTimers() })

function failingSession(mode: 'timeout' | 'throw') {
  const hooks = {
    clearStorageData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
    removeListener: vi.fn(),
    onBeforeRequest: vi.fn()
  }
  const downloadSession = {
    setProxy: async () => undefined,
    webRequest: { onBeforeRequest: hooks.onBeforeRequest },
    clearStorageData: hooks.clearStorageData,
    closeAllConnections: hooks.closeAllConnections,
    once: vi.fn(),
    removeListener: hooks.removeListener,
    // timeout:对着永不应答的服务器,will-download 永远不来。
    downloadURL: () => { if (mode === 'throw') throw new Error('ERR_NAME_NOT_RESOLVED') }
  }
  return { downloadSession, hooks }
}

const request = {
  taskId: 'release-fixture', assetUrl: 'https://downloads.example.cn/app.dmg',
  allowedHosts: ['downloads.example.cn'], network: 'direct' as const, proxyUrl: '',
  partPath: '/tmp/release-fixture.part'
}

describe('下载引擎启动失败时释放会话', () => {
  it('downloadURL 同步抛错：连接、分区存储、监听与拦截器都清掉', async () => {
    const { downloadSession, hooks } = failingSession('throw')
    vi.doMock('electron', () => ({ session: { fromPartition: () => downloadSession } }))
    const { ElectronDownloadEngine } = await import('../../app/main/download/electron-download-engine')

    await expect(new ElectronDownloadEngine().start(request)).rejects.toThrow('ERR_NAME_NOT_RESOLVED')
    expect(hooks.closeAllConnections).toHaveBeenCalled()
    expect(hooks.clearStorageData).toHaveBeenCalled()
    expect(hooks.removeListener).toHaveBeenCalledWith('will-download', expect.any(Function))
    expect(hooks.onBeforeRequest).toHaveBeenLastCalledWith(null)
  })

  it('15 秒启动超时：同样释放，⛔ 每次重试都多留一份分区与监听', async () => {
    vi.useFakeTimers()
    const { downloadSession, hooks } = failingSession('timeout')
    vi.doMock('electron', () => ({ session: { fromPartition: () => downloadSession } }))
    const { ElectronDownloadEngine } = await import('../../app/main/download/electron-download-engine')

    const started = new ElectronDownloadEngine().start(request)
    const settled = expect(started).rejects.toThrow('DOWNLOAD_ENGINE_START_TIMEOUT')
    await vi.advanceTimersByTimeAsync(15_001)
    await settled
    await vi.advanceTimersByTimeAsync(0)

    expect(hooks.closeAllConnections).toHaveBeenCalled()
    expect(hooks.clearStorageData).toHaveBeenCalled()
    expect(hooks.removeListener).toHaveBeenCalledWith('will-download', expect.any(Function))
    expect(hooks.onBeforeRequest).toHaveBeenLastCalledWith(null)
  })
})

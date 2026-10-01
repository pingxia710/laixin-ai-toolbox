// 分区生命周期:分区按 resourceId 复用(同资源重试/续传不再各开一个 Electron 常驻分区),
// transfer.release 与失败路径对齐摘除 onBeforeRequest 监听(单监听槽,传 null 清空)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

type RequestListener = (details: { url: string }, callback: (decision: { cancel: boolean }) => void) => void

interface SessionDouble {
  readonly listeners: RequestListener[]
  readonly webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }
  readonly setProxy: ReturnType<typeof vi.fn>
}

afterEach(() => { vi.doUnmock('electron'); vi.resetModules(); vi.useRealTimers() })

function fixtureItem() {
  return Object.assign(new EventEmitter(), {
    setSavePath: vi.fn(), getState: () => 'progressing', canResume: () => true,
    getReceivedBytes: () => 0, getTotalBytes: () => 20, getETag: () => 'etag-fixture',
    getLastModifiedTime: () => '', getMimeType: () => 'application/octet-stream',
    getURLChain: () => ['https://downloads.example.cn/app.dmg'],
    resume: vi.fn(), cancel: vi.fn()
  })
}

// 模拟 Electron 语义:同名分区返回同一 Session;onBeforeRequest 单监听槽,后设覆盖前设,传 null 清空。
function fakeElectronSessions(): { partitions: string[]; sessions: Map<string, SessionDouble>; fromPartition: (partition: string) => SessionDouble } {
  const partitions: string[] = []
  const sessions = new Map<string, SessionDouble>()
  const fromPartition = (partition: string): SessionDouble => {
    partitions.push(partition)
    let value = sessions.get(partition)
    if (value === undefined) {
      const listeners: RequestListener[] = []
      value = Object.assign(new EventEmitter(), {
        setProxy: vi.fn(async () => undefined),
        webRequest: { onBeforeRequest: vi.fn((listener: RequestListener | null) => { if (listener === null) listeners.length = 0; else listeners[0] = listener }) },
        clearStorageData: vi.fn(async () => undefined),
        closeAllConnections: vi.fn(async () => undefined),
        downloadURL: () => { (value as unknown as EventEmitter).emit('will-download', undefined, fixtureItem()) },
        listeners
      }) as unknown as SessionDouble & EventEmitter
      sessions.set(partition, value)
    }
    return value
  }
  return { partitions, sessions, fromPartition }
}

async function importEngine(fromPartition: (partition: string) => SessionDouble) {
  vi.doMock('electron', () => ({ session: { fromPartition } }))
  const { ElectronDownloadEngine } = await import('../../app/main/download/electron-download-engine')
  return { ElectronDownloadEngine, engine: new ElectronDownloadEngine() }
}

const baseRequest = {
  resourceId: 'codex-official-download',
  assetUrl: 'https://downloads.example.cn/app.dmg',
  allowedHosts: ['downloads.example.cn'],
  network: 'direct' as const,
  proxyUrl: '',
  partPath: '/tmp/partition-fixture.part'
}

describe('下载分区按资源有界复用', () => {
  it('同 resourceId 的两个任务共用一个分区,任务 id 不再决定分区', async () => {
    const fake = fakeElectronSessions()
    const { engine } = await importEngine(fake.fromPartition)
    await engine.start({ ...baseRequest, taskId: 'task-first' })
    await engine.start({ ...baseRequest, taskId: 'task-retry' })
    expect(fake.partitions.length).toBeGreaterThan(0)
    expect(new Set(fake.partitions).size).toBe(1)
    expect(fake.partitions[0]).toBe('toolbox-download-codex-official-download')
  })

  it('复用分区上每次任务都重设代理与主机过滤,⛔ 沿用上一任务的配置', async () => {
    const fake = fakeElectronSessions()
    const { engine } = await importEngine(fake.fromPartition)
    await engine.start({ ...baseRequest, taskId: 'task-direct' })
    await engine.start({ ...baseRequest, taskId: 'task-tunnel', network: 'tunnel', proxyUrl: 'http://127.0.0.1:19080', allowedHosts: ['mirror.example.cn'] })
    const session = fake.sessions.get('toolbox-download-codex-official-download')!
    expect(session.setProxy).toHaveBeenCalledTimes(2)
    expect(session.setProxy).toHaveBeenNthCalledWith(2, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:19080', proxyBypassRules: '<-loopback>' })
    // 监听槽里是最新任务的主机清单:旧主机已被替换。
    let decision: { cancel: boolean } | undefined
    session.listeners[0]({ url: 'https://downloads.example.cn/app.dmg' }, (value) => { decision = value })
    expect(decision).toEqual({ cancel: true })
    session.listeners[0]({ url: 'https://mirror.example.cn/app.dmg' }, (value) => { decision = value })
    expect(decision).toEqual({ cancel: false })
  })

  it('transfer.release 摘除 onBeforeRequest 监听,与失败路径对齐', async () => {
    const fake = fakeElectronSessions()
    const { engine } = await importEngine(fake.fromPartition)
    const transfer = await engine.start({ ...baseRequest, taskId: 'task-release' })
    const session = fake.sessions.get('toolbox-download-codex-official-download')!
    expect(session.listeners).toHaveLength(1)
    await transfer.release!()
    expect(session.listeners).toHaveLength(0)
    expect(session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null)
  })

  it('跨资源分区缓存有上限:超出后逐出最久未用的引用,被逐出资源再来任务仍可用', async () => {
    const fake = fakeElectronSessions()
    const { engine } = await importEngine(fake.fromPartition)
    const { DOWNLOAD_PARTITION_LIMIT } = await import('../../app/main/download/electron-download-engine')
    for (let index = 0; index < DOWNLOAD_PARTITION_LIMIT + 2; index += 1) {
      await engine.start({ ...baseRequest, resourceId: `resource-${index}`, taskId: `task-${index}` })
    }
    const cache = (engine as unknown as { partitions: Map<string, unknown> }).partitions
    expect(cache.size).toBeLessThanOrEqual(DOWNLOAD_PARTITION_LIMIT)
    await expect(engine.start({ ...baseRequest, resourceId: 'resource-0', taskId: 'task-revisit' })).resolves.toBeTruthy()
  })
})

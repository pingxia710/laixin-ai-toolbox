// P2(网络数据面优化):tickIntent 的 catch ⛔ 无声吞错。意图切换中途抛错(如状态落盘失败)时,
// 错误此前被整个丢弃,随后 requestShutdown 很快退出——日志是唯一的第一现场(甲-6 同款纪律:
// 错误名+截断首行)。变异自证:删掉 catch 里的 log → 本用例红。
import { expect, it } from 'vitest'
import { join } from 'node:path'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import { FakeClock, fakeAdapterEnv, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

interface Internal {
  run(): Promise<void>
  writeStateNow(state: string, extra?: object): boolean
  intent?: { desired?: string }
}

it('意图切换中途抛错:先留证(错误名+首行)再请求关停', async () => {
  const root = makeTempDir('netopt-tickfault-')
  try {
    const clock = new FakeClock()
    const lines: string[] = []
    let exitCode: number | undefined
    const daemon = createDaemon({
      dataDir: root, clock,
      adapter: createAdapter(fakeAdapterEnv(join(root, 'store.json'))),
      connectorFactory: () => { throw new Error('unused') },
      bridgeFactory: () => { throw new Error('unused') },
      parentAlive: () => true, onExit: (code: number) => { exitCode = code },
      log: (line: string) => lines.push(line)
    }) as unknown as Internal
    await daemon.run()
    await flushMicrotasks()
    // 稳定 idle 后注入:意图落盘路径中途抛错 → applyIntent 把错误带到 tickIntent 的 catch。
    const injected = Object.assign(new Error('意图切换中途失败(注入)'), { name: 'InjectedIntentFault' })
    daemon.writeStateNow = () => { throw injected }
    writeIntentFile(root, { desired: 'user-disconnected', sessionToken: 'netopt-tickfault' })
    clock.advance(500)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(lines.some((line) => line.includes('InjectedIntentFault') && line.includes('意图切换中途失败'))).toBe(true)
    // 关停确已请求:请求即把意图钉成 shutdown,并最终走到退出。
    expect(daemon.intent?.desired).toBe('shutdown')
    clock.advance(120_000)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(exitCode).toBeDefined()
  } finally {
    removeTempDir(root)
  }
}, 30_000)

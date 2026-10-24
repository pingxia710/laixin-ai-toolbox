// N-22:文件选择框(picker)是导入的第一步,而对话框非模态——从前互斥锁先抢后选,
// 客户盯着文件框多久,锁就被攥多久:期间点连接/断开/应用全吃「另一个通道操作正在进行」,
// 刚点过「取消修复并断开」的还要进等锁自旋直到文件框关闭(N-02 工作单自证现实发生过)。
// 修法:picker 在锁外跑完拿到路径,tryAcquire 只盖解析与提交;客户取消不进锁。
// 本文件守这次拆分:主用例未修代码上必红;提交段仍在互斥内、修复互斥规则不回退,由其余用例守。
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { makeTempDir, removeTempDir, waitFor } from './helpers'

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const root = makeTempDir('laixin-n22-picker-')
  cleanups.push(() => removeTempDir(root))
  const dataDir = join(root, 'device')
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const built = buildPackageEntries({ configVersion: 1 })
  const packageDir = writePackageDir(join(root, 'package'), built)
  // 可控 picker:第一次放行真实包(备好已应用的配置),之后挂起,由用例决定何时放行、放行什么。
  const gate: { opened: boolean; release: (picked: string | undefined) => void } = { opened: false, release: () => undefined }
  let pickCount = 0
  const picker = async (): Promise<string | undefined> => {
    pickCount += 1
    if (pickCount === 1) return packageDir
    gate.opened = true
    return new Promise((resolve) => { gate.release = resolve })
  }
  const service = new TunnelService({ dataDir, sidecarDir, picker,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] }, now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
    routesFile: join(sidecarDir, 'routes.default.json') })
  cleanups.push(() => service.stop().then(() => undefined))
  await service.importConfig(); await service.applyPending()
  return { service, packageDir, gate }
}

const mutexOf = (service: TunnelService) =>
  (service as unknown as { mutex: { tryAcquire(): (() => void) | undefined } }).mutex

it('文件框挂起期间点连接/断开:照常工作,⛔ 吃「另一个通道操作正在进行」(未修代码上必红)', async () => {
  const f = await setup()
  const importing = f.service.importConfig()
  await waitFor(() => f.gate.opened)
  // 文件框开着(锁外):连接、断开必须真实完成——未修代码上这两步都回 TUNNEL_BUSY。
  expect(await f.service.start()).toMatchObject({ outcome: 'started' })
  expect(await f.service.stop()).toMatchObject({ outcome: 'stopped' })
  // 客户选完同一个包:提交段照常落成待用版本(版本同、字节同,允许重复导入)。
  f.gate.release(f.packageDir)
  expect(await importing).toMatchObject({ outcome: 'imported', pendingAvailable: true })
}, 15_000)

it('客户取消文件框:返回取消,随后锁空闲、连接照常', async () => {
  const f = await setup()
  const importing = f.service.importConfig()
  await waitFor(() => f.gate.opened)
  f.gate.release(undefined)
  expect(await importing).toMatchObject({ outcome: 'cancelled' })
  expect(await f.service.start()).toMatchObject({ outcome: 'started' })
}, 15_000)

it('提交窗口仍受互斥保护:锁被占着时选完文件 → 忙拒绝,⛔ 拆成无锁提交', async () => {
  const f = await setup()
  const release = mutexOf(f.service).tryAcquire()
  expect(release).toBeDefined()
  try {
    const importing = f.service.importConfig()
    f.gate.release(f.packageDir)
    expect(await importing).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_BUSY' })
  } finally {
    release?.()
  }
}, 15_000)

it('文件框开着时能点修复;修复进行中选完文件 → 忙拒绝(导入与修复互斥的既有规则)', async () => {
  const f = await setup()
  const importing = f.service.importConfig()
  await waitFor(() => f.gate.opened)
  // 未修代码上此刻锁被文件框攥着,修复按钮吃忙拒绝——这也是本单要在客户那侧摘掉的误拒之一。
  expect(f.service.repair()).toMatchObject({ outcome: 'started' })
  f.gate.release(f.packageDir)
  expect(await importing).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_BUSY' })
  // 收尾:取消修复并断开,别让后台修复流程拖着超时钟跑满。
  expect(await f.service.stop()).toMatchObject({ outcome: 'stopped' })
  await waitFor(() => !f.service.repairStatus().running, 15_000)
}, 15_000)

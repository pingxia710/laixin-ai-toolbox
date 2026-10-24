// FB-3 件三 · N-08 守卫用例:账号同步的写阶段(拿到 claim 结果、进互斥锁之后)必须**重新读**
// 本地当前状态,⛔ 用网络往返前的旧快照做写决策。
// 为什么必须有这条:N-08 把 claim 移出互斥锁后,锁空出来的同步窗口里客户能导入/应用配置——
// 这是该改动的本意;但正因如此,写阶段的 `current` 若还是往返前的快照,同步就会拿「已经不成立的
// 现场」做决策。本用例钉住:claim 挂起期间客户把本地配置换成了更新的版本(b v2),迟到的同步
// 必须按新现状(当前已是 b v2)拒绝后台旧包(a v1)的降级;若用旧快照(仍是 a v1),同一份包
// 会被误判成「当前已是这个账号的最新配置」直接放行。
// 把「读本地当前状态」挪回网络往返前(旧快照)→ 本用例红;恢复现实现 → 绿。
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { currentBatchId } from '../../app/main/tunnel/transactions'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { tarFromPackageEntries } from './fixtures/tar-writer'
import { makeTempDir, removeTempDir } from './helpers'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

it('claim 挂起期间客户换了更新的配置:迟到的同步按新现状拒绝旧包降级,⛔ 用旧快照谎报「已是最新」', async () => {
  const root = makeTempDir('laixin-sync-fresh-')
  dirs.push(root)
  const dataDir = join(root, 'data')
  // a = 后台当前配置(v1,首发同步已在本机);b = 同一客户的新版配置(v2)。
  // file 导入必须是同一客户(授权 ID 一致),只是版本与节点更新。
  const a = buildPackageEntries({ configVersion: 1 })
  const b = buildPackageEntries({ configVersion: 2, host: 'node-b.test.invalid' })
  const bPath = writePackageDir(join(root, 'b'), b)
  const aClaim = { id: 'lx-test0001', expiresAt: Date.parse('2027-01-01T00:00:00.000Z'), archive: tarFromPackageEntries(a.entries) }

  let claimCalls = 0
  let releaseClaim: (() => void) | undefined
  const heldClaim = new Promise<typeof aClaim>((resolve) => { releaseClaim = () => resolve(aClaim) })
  const access = {
    client: {
      claim: async () => {
        claimCalls += 1
        if (claimCalls === 1) return aClaim
        return heldClaim // 第 2 趟同步挂在网络往返上,给客户留出导入/应用的窗口
      }
    },
    session: { accountId: 'customer-a', accessToken: 'token' } // 无 deviceId:回执直接跳过
  }
  const tunnel = new TunnelService({
    dataDir, sidecarDir: join(root, 'empty-sidecar'), picker: async () => bPath,
    trust: { whitelistDigests: [a.digest, b.digest], signingPublicKeys: [] },
    now: () => Date.now(), spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
    routesFile: join(dataDir, 'routes.default.json')
  })

  // 首发同步:后台配置 a(v1)落地为本机当前配置。
  expect((await tunnel.setAccountAccess(access as never)).outcome).toBe('applied')

  // 同步窗口:claim 挂起期间,客户导入并应用新版配置 b(v2)(N-08 之后这才可能:网络在锁外)。
  const syncPromise = tunnel.syncAccountConfig()
  await vi.waitFor(() => expect(claimCalls).toBe(2))
  expect((await tunnel.importConfig()).outcome).toBe('imported')
  expect((await tunnel.applyPending()).outcome).toBe('applied')
  const appliedBatch = currentBatchId(dataDir)
  expect(appliedBatch).toBeDefined()

  releaseClaim?.()
  const result = await syncPromise
  // 写阶段读的是**新现状**(当前已是 b v2):后台旧包 a v1 是降级,⛔ 放行;
  // 若读旧快照(仍是 a v1),同一份包会被误判成「已是最新」(unchanged)——两种实现只有一种对。
  expect(result.outcome).toBe('rejected')
  expect(result.code).toBe('PACKAGE_VERSION_REGRESSION')
  expect(currentBatchId(dataDir)).toBe(appliedBatch) // 客户刚应用的 b 原样保留
}, 15_000)

// 防回归参照:没有中途换配置时,重发同一份包就是「已是最新」(同一行为,与上例唯一差一个交错)。
it('对照:同步窗口内本地现状未变,重发同一份包照常判「unchanged」', async () => {
  const root = makeTempDir('laixin-sync-fresh-')
  dirs.push(root)
  const dataDir = join(root, 'data')
  const a = buildPackageEntries({ configVersion: 1 })
  const aClaim = { id: 'lx-test0001', expiresAt: Date.parse('2027-01-01T00:00:00.000Z'), archive: tarFromPackageEntries(a.entries) }
  const access = {
    client: { claim: async () => aClaim },
    session: { accountId: 'customer-a', accessToken: 'token' }
  }
  const tunnel = new TunnelService({
    dataDir, sidecarDir: join(root, 'empty-sidecar'), picker: async () => undefined,
    trust: { whitelistDigests: [a.digest], signingPublicKeys: [] },
    now: () => Date.now(), spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
    routesFile: join(dataDir, 'routes.default.json')
  })
  expect((await tunnel.setAccountAccess(access as never)).outcome).toBe('applied')
  const batch = currentBatchId(dataDir)
  const result = await tunnel.syncAccountConfig()
  expect(result.outcome).toBe('unchanged')
  expect(currentBatchId(dataDir)).toBe(batch)
})

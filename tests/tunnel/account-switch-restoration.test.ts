import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import type { NetworkAccountAccess } from '../../app/main/tunnel/account-client'
import { readCurrentInfo } from '../../app/main/tunnel/import-meta'
import { layout } from '../../app/main/tunnel/paths'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { tarFromPackageEntries } from './fixtures/tar-writer'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(removeTempDir) })

async function setup() {
  const root = makeTempDir('laixin-account-switch-restore-')
  roots.push(root)
  const dataDir = join(root, 'data')
  const oldPackage = buildPackageEntries({ platform: 'windows', authorizationId: 'lx-test0001' })
  const newPackage = buildPackageEntries({ platform: 'windows', authorizationId: 'lx-test0002' })
  const oldPackageDir = writePackageDir(join(root, 'old-package'), oldPackage)
  const sidecarDir = fileURLToPath(new URL('../../sidecar/win', import.meta.url))
  const claim = vi.fn(async () => ({ id: 'lx-test0002', expiresAt: Date.parse(newPackage.manifest.expiresAt),
    archive: tarFromPackageEntries(newPackage.entries) }))
  let finishRestore: ((code: number) => void) | undefined
  const service = new TunnelService({ dataDir, sidecarDir, platform: 'windows', picker: async () => oldPackageDir,
    trust: { whitelistDigests: [oldPackage.digest, newPackage.digest], signingPublicKeys: [] },
    now: () => Date.parse('2026-09-25T00:00:00Z'),
    spawnDaemon: () => { throw new Error('不应在恢复旧账号设置时启动新通道') },
    spawnRestore: () => ({ on: (_event, callback) => { finishRestore = (code) => callback(code, null) } }),
    routesFile: join(sidecarDir, 'routes.default.json') })
  expect((await service.importConfig()).outcome).toBe('imported')
  expect((await service.applyPending()).outcome).toBe('applied')
  const current = readCurrentInfo(dataDir)!
  const metaPath = join(layout.batchDir(dataDir, current.batchId), 'import-meta.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
  writeFileSync(metaPath, `${JSON.stringify({ ...meta, accountId: 'old-account' })}\n`)
  const ledgerPath = join(dataDir, 'ledger.json')
  const items = ['ProxyServer', 'ProxyEnable', 'ProxyOverride', 'AutoConfigURL']
  const ledger = items.map((item) => ({ id: `old-${item}`, kind: 'setting', service: 'WinINET', item,
    originalValue: null, writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' },
    sessionToken: 'old-session', time: 1, status: 'applied', note: '' }))
  writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 })
  const access = { client: { claim, sameEndpoint: () => true }, session: { accountId: 'new-account', accessToken: 'new-token' } } as unknown as NetworkAccountAccess
  const finish = (success: boolean) => {
    if (success) writeFileSync(ledgerPath, `${JSON.stringify(ledger.map((entry) => ({ ...entry, status: 'restored' })))}\n`, { mode: 0o600 })
    writeFileSync(layout.state(dataDir), `${JSON.stringify(success
      ? { state: 'stopped-restored' }
      : { state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE', message: '原设置恢复失败' })}\n`, { mode: 0o600 })
    finishRestore?.(success ? 0 : 65)
  }
  return { service, dataDir, access, claim, finish }
}

it('切换账号时四项 WinINET 恢复超过五秒，恢复完成后自动同步新账号配置', async () => {
  const f = await setup()
  const result = await f.service.setAccountAccess(f.access)
  expect(result.outcome).toBe('started')
  expect(readCurrentInfo(f.dataDir)?.accountId).toBe('old-account')
  expect(f.claim).not.toHaveBeenCalled()
  expect(f.service.status()).toMatchObject({ state: '断开中', unrestored: '', message: expect.stringContaining('正在恢复原设置') })
  expect((await f.service.syncAccountConfig()).code).toBe('NETWORK_DISCONNECT_REQUIRED')
  expect((await f.service.setAccountAccess(f.access)).code).toBe('NETWORK_DISCONNECT_REQUIRED')
  expect(f.claim).not.toHaveBeenCalled()

  f.finish(true)
  await vi.waitFor(() => expect(readCurrentInfo(f.dataDir)?.accountId).toBe('new-account'), { timeout: 3_000 })
  expect(f.claim).toHaveBeenCalledTimes(1)
}, 15_000)

it('旧设置恢复失败时不读取新账号配置，并提示重试恢复', async () => {
  const f = await setup()
  expect((await f.service.setAccountAccess(f.access)).outcome).toBe('started')
  f.finish(false)
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(f.claim).not.toHaveBeenCalled()
  expect(readCurrentInfo(f.dataDir)?.accountId).toBe('old-account')
  expect(f.service.status().message).toContain('重试恢复原设置')
}, 15_000)

it('等待恢复时退出新账号，旧任务不能再为该账号领取配置', async () => {
  const f = await setup()
  expect((await f.service.setAccountAccess(f.access)).outcome).toBe('started')
  await f.service.setAccountAccess(undefined)
  f.finish(true)
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(f.claim).not.toHaveBeenCalled()
  expect(readCurrentInfo(f.dataDir)?.accountId).toBe('old-account')
}, 15_000)

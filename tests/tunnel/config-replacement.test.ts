import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { currentBatchId, pendingBatchId } from '../../app/main/tunnel/transactions'
import { layout } from '../../app/main/tunnel/paths'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(removeTempDir) })

function setup(allowSpawn = false) {
  const root = makeTempDir('laixin-replacement-')
  roots.push(root)
  const dataDir = join(root, 'data')
  let now = Date.parse('2026-10-01T00:00:00Z')
  const a = buildPackageEntries({ configVersion: 1 })
  const b = buildPackageEntries({ configVersion: 2, host: 'node-b.test.invalid', sshUser: 'proxy_new', expiresAt: '2026-10-02T00:00:00Z' })
  let selected = writePackageDir(join(root, 'a'), a)
  const bPath = writePackageDir(join(root, 'b'), b)
  const spawnDaemon = vi.fn(() => { if (!allowSpawn) throw new Error('must not launch for invalid config'); return { on: () => undefined } })
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const service = new TunnelService({
    dataDir, sidecarDir, picker: async () => selected,
    trust: { whitelistDigests: [a.digest, b.digest], signingPublicKeys: [] },
    now: () => now, spawnDaemon, spawnRestore: () => undefined,
    routesFile: join(sidecarDir, 'routes.default.json')
  })
  return { service, dataDir, spawnDaemon,
    chooseB: () => { selected = bPath },
    expireB: () => { now = Date.parse('2026-10-03T00:00:00Z') }
  }
}

it('同一客户可更换节点与凭据，导入只预览，应用后才切换当前配置', async () => {
  const f = setup()
  await f.service.importConfig()
  expect((await f.service.applyPending()).outcome).toBe('applied')
  const original = currentBatchId(f.dataDir)
  f.chooseB()
  await f.service.importConfig()
  expect(currentBatchId(f.dataDir)).toBe(original)
  expect(f.service.status()).toMatchObject({ currentConfig: expect.stringContaining('版本 1'), pendingConfig: expect.stringContaining('node-b.test.invalid'), canApplyPending: true })
  expect((await f.service.applyPending()).outcome).toBe('applied')
  expect(f.service.status()).toMatchObject({ configVersion: '2', nodeLabel: 'node-b.test.invalid:22', pendingConfig: '', canApplyPending: false })
  expect(f.spawnDaemon).not.toHaveBeenCalled()
})

it.each(['expired', 'tampered'] as const)('待换配置 %s 时拒绝应用并保留当前配置', async (fault) => {
  const f = setup()
  await f.service.importConfig()
  await f.service.applyPending()
  const original = currentBatchId(f.dataDir)
  f.chooseB()
  await f.service.importConfig()
  if (fault === 'expired') f.expireB()
  else writeFileSync(join(layout.batchDir(f.dataDir, pendingBatchId(f.dataDir)!), 'credentials/id_ed25519'), 'changed')
  expect((await f.service.applyPending()).outcome).toBe('rejected')
  expect(currentBatchId(f.dataDir)).toBe(original)
  expect(f.service.status().configVersion).toBe('1')
})

it('当前配置到期后拒绝启动，不拉起守护进程', async () => {
  const f = setup()
  f.chooseB()
  await f.service.importConfig()
  await f.service.applyPending()
  f.expireB()
  expect((await f.service.start()).outcome).toBe('rejected')
  expect(f.spawnDaemon).not.toHaveBeenCalled()
})

it('从已核验配置把授权与到期时间交给守护，期限不由页面提供', async () => {
  const f = setup(true)
  f.chooseB()
  const imported = await f.service.importConfig()
  await f.service.applyPending()
  expect((await f.service.start()).outcome).toBe('started')
  const intent = JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))
  expect(intent.authorization).toEqual({ id: imported.authorizationId, expiresAt: Date.parse(imported.expiresAt) })
  expect(intent.authorization.expiresAt).toBe(Date.parse('2026-10-02T00:00:00Z'))
})

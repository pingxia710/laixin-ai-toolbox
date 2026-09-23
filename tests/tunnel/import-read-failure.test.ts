// 甲-6 返工(④):读客户选的配置包失败 ≠ 写工具箱数据目录失败,要分开说。
// 基线(36315e5):readEntries() 也在 commitPackage 的 try 里,fs 码命中六码表 → 一律
// 「工具箱写入本地数据失败…请清理磁盘」——客户的包被移走(ENOENT)/没有读取权限(EACCES)
// 也被指去清磁盘;甲-6 之前的「请重新导入」反而是对症的。
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { importConfig } from '../../app/main/tunnel/import-service'
import { TRUST_LINES } from '../../app/main/tunnel/trust'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { makeTempDir, removeTempDir } from './helpers'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

function importFrom(dataDir: string, picked: string, whitelistDigest: string) {
  return importConfig({
    dataDir,
    picker: () => Promise.resolve(picked),
    trust: { whitelistDigests: [whitelistDigest], signingPublicKeys: [] },
    now: () => NOW,
    sourceLineOf: (validated) => TRUST_LINES[validated.trust.tier]
  })
}

/** 构建一次包并写入 picked 路径:digest 与信任清单必须同源(每次 build 的测试密钥不同)。 */
function writePackage(picked: string): string {
  const built = buildPackageEntries()
  writePackageDir(picked, built)
  return built.digest
}

describe('读客户选的配置包失败,对症说(甲-6 返工 ④)', () => {
  it('选中的配置包已被移走(ENOENT) → 读不到你选的包、请重新选择;⛔ 让客户去清磁盘', async () => {
    const dataDir = makeTempDir('laixin-j6r-data-')
    const packageDir = makeTempDir('laixin-j6r-pkg-')
    cleanups.push(() => removeTempDir(dataDir))
    cleanups.push(() => removeTempDir(packageDir))
    const built = buildPackageEntries()
    const outcome = await importFrom(dataDir, join(packageDir, 'moved-away'), built.digest)
    expect(outcome.outcome).toBe('rejected')
    expect(outcome.outcome === 'rejected' && outcome.code).toBe('TUNNEL_LOCAL_READ_FAILED')
    expect(outcome.outcome === 'rejected' && outcome.message).toContain('读不到你选的配置包')
    expect(outcome.outcome === 'rejected' && outcome.message).toContain('重新选择')
    expect(outcome.outcome === 'rejected' && outcome.message).not.toContain('磁盘')
  })

  it('选中的配置包没有读取权限(chmod 000) → 同样对症;⛔ 冒充写入失败', async () => {
    const dataDir = makeTempDir('laixin-j6r-data2-')
    const packageDir = makeTempDir('laixin-j6r-pkg2-')
    cleanups.push(() => removeTempDir(dataDir))
    const packagePath = join(packageDir, 'pkg')
    cleanups.push(() => { chmodSync(packagePath, 0o755); removeTempDir(packageDir) })
    const digest = writePackage(packagePath)
    chmodSync(packagePath, 0o000) // 无读取权限的真实现场
    const outcome = await importFrom(dataDir, packagePath, digest)
    expect(outcome.outcome).toBe('rejected')
    expect(outcome.outcome === 'rejected' && outcome.code).toBe('TUNNEL_LOCAL_READ_FAILED')
    expect(outcome.outcome === 'rejected' && outcome.message).toContain('读不到你选的配置包')
    expect(outcome.outcome === 'rejected' && outcome.message).not.toContain('磁盘')
  })

  it('真写入失败(数据目录不可写) → 码与文案逐字照旧(⛔ 借返工改写)', async () => {
    const dataDir = makeTempDir('laixin-j6r-ro-')
    const packageDir = makeTempDir('laixin-j6r-pkg3-')
    cleanups.push(() => { chmodSync(dataDir, 0o755); removeTempDir(dataDir) })
    cleanups.push(() => removeTempDir(packageDir))
    const packagePath = join(packageDir, 'pkg')
    const digest = writePackage(packagePath)
    chmodSync(dataDir, 0o555) // 工具箱数据目录不可写的真实现场
    const outcome = await importFrom(dataDir, packagePath, digest)
    expect(outcome.outcome).toBe('rejected')
    expect(outcome.outcome === 'rejected' && outcome.code).toBe('TUNNEL_LOCAL_WRITE_FAILED')
    expect(outcome.outcome === 'rejected' && outcome.message)
      .toBe('工具箱写入本地数据失败（磁盘已满或目录不可写），请清理磁盘空间或检查数据目录后重试')
  })
})

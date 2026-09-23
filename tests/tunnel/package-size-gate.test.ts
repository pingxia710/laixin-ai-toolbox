// 甲-8:读取前的尺寸闸。超大 / 损坏的「配置包」此前被整个 readFileSync 进主进程再同步
// 解包 + 逐项 sha256,卡死时长随文件大小线性增长;最后超限异常走桥层兜底,只剩一句
// 与真实原因无关的「操作未完成,请重试或重新导入来信配置包」。尺寸闸在读取之前按
// lstat 的 size 拒成受控 PACKAGE_TOO_LARGE,文案说对原因(「太大」),⛔ 说成「读不到」
// (甲-6 返工的读失败归因互不串)也 ⛔ 指去清磁盘。
import { afterEach, describe, expect, it } from 'vitest'
import { closeSync, ftruncateSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { importConfig, readPackageEntries } from '../../app/main/tunnel/import-service'
import { MAX_PACKAGE_ENTRY_BYTES, MAX_PACKAGE_TOTAL_BYTES } from '../../app/main/tunnel/package-format'
import { TRUST_LINES } from '../../app/main/tunnel/trust'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { tarFromPackageEntries } from './fixtures/tar-writer'
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

/** 在 path 落 content 后把文件稀疏扩展到 size(中间是洞,不占盘)。 */
function writeSparse(path: string, content: Buffer, size: number): void {
  writeFileSync(path, content)
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.from([0]), 0, 1, size - 1)
    ftruncateSync(fd, size)
  } finally {
    closeSync(fd)
  }
  expect(statSync(path).size).toBe(size)
}

describe('甲-8:读取前尺寸闸', () => {
  it('几百 MB 的 .lxtpack(稀疏)在读取前秒拒为 PACKAGE_TOO_LARGE;文案说「太大」,⛔ 说「读不到」', async () => {
    const dataDir = makeTempDir('laixin-jia8-data-')
    const packageDir = makeTempDir('laixin-jia8-pkg-')
    cleanups.push(() => removeTempDir(dataDir))
    cleanups.push(() => removeTempDir(packageDir))
    const built = buildPackageEntries()
    // 真实签发包 KB 级;这里在头部放一份合法 tar、再稀疏拖到 512MiB,模拟「选错文件」。
    const packagePath = join(packageDir, 'huge.lxtpack')
    const halfGiB = 512 * 1024 * 1024
    writeSparse(packagePath, tarFromPackageEntries(built.entries), halfGiB)
    const started = performance.now()
    const outcome = await importFrom(dataDir, packagePath, built.digest)
    const elapsedMs = performance.now() - started
    console.log(`[甲-8] 512MiB .lxtpack 拒绝耗时 ${elapsedMs.toFixed(1)}ms`)
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome !== 'rejected') return
    expect(outcome.code).toBe('PACKAGE_TOO_LARGE')
    expect(outcome.message).toContain('太大')
    expect(outcome.message).toContain('选对')
    // 归因互不串(甲-6 返工):尺寸闸的拒绝 ⛔ 落进「读不到」通道,也 ⛔ 指去清磁盘。
    expect(outcome.message).not.toContain('读不到')
    expect(outcome.message).not.toContain('磁盘')
    // 秒拒:整读 512MiB 再同步解包的旧路径远超这条线;给缓慢 CI 留裕量。
    expect(elapsedMs).toBeLessThan(5000)
  })

  it('目录形态总量超限(单文件都不越单文件上限)→ 同样 PACKAGE_TOO_LARGE', async () => {
    const dataDir = makeTempDir('laixin-jia8-data2-')
    const packageDir = makeTempDir('laixin-jia8-pkg2-')
    cleanups.push(() => removeTempDir(dataDir))
    cleanups.push(() => removeTempDir(packageDir))
    // 10 × 0.9MiB 稀疏文件 = 9MiB > 总量上限,且每个都低于单文件上限——钉住「总量」这道闸。
    const perFile = Math.floor(MAX_PACKAGE_ENTRY_BYTES * 0.9)
    for (let index = 0; index < 10; index++) {
      writeSparse(join(packageDir, `pad-${index}.bin`), Buffer.from([0x41]), perFile)
    }
    expect(statSync(packageDir).size).toBeGreaterThan(0)
    const started = performance.now()
    const outcome = await importFrom(dataDir, packageDir, buildPackageEntries().digest)
    console.log(`[甲-8] 目录总量超限拒绝耗时 ${(performance.now() - started).toFixed(1)}ms`)
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome !== 'rejected') return
    expect(outcome.code).toBe('PACKAGE_TOO_LARGE')
    expect(outcome.message).toContain('太大')
    expect(outcome.message).not.toContain('读不到')
  })

  it('目录形态单文件超限 → PACKAGE_TOO_LARGE', async () => {
    const dataDir = makeTempDir('laixin-jia8-data3-')
    const packageDir = makeTempDir('laixin-jia8-pkg3-')
    cleanups.push(() => removeTempDir(dataDir))
    cleanups.push(() => removeTempDir(packageDir))
    writeSparse(join(packageDir, 'manifest.json'), Buffer.from('{}'), MAX_PACKAGE_ENTRY_BYTES * 2)
    const outcome = await importFrom(dataDir, packageDir, buildPackageEntries().digest)
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome !== 'rejected') return
    expect(outcome.code).toBe('PACKAGE_TOO_LARGE')
  })

  it('正向格:合法 .lxtpack(整包远小于上限)照常导入;存量复查共用的 readPackageEntries 不误伤', async () => {
    const dataDir = makeTempDir('laixin-jia8-data4-')
    const packageDir = makeTempDir('laixin-jia8-pkg4-')
    cleanups.push(() => removeTempDir(dataDir))
    cleanups.push(() => removeTempDir(packageDir))
    const built = buildPackageEntries()
    const packagePath = join(packageDir, 'pkg.lxtpack')
    writeFileSync(packagePath, tarFromPackageEntries(built.entries))
    const outcome = await importFrom(dataDir, packagePath, built.digest)
    expect(outcome.outcome).toBe('imported')
    // validateStored / storedPackageDigest 走同一个 readPackageEntries:合法包必须原样读得出。
    expect(readPackageEntries(packagePath).map((entry) => entry.path))
      .toEqual(expect.arrayContaining(['manifest.json']))
  })

  it('正向格:目录形态合法包照常导入;单文件贴着上限(= 上限)不误伤', async () => {
    const dataDir = makeTempDir('laixin-jia8-data5-')
    const packageDir = makeTempDir('laixin-jia8-pkg5-')
    cleanups.push(() => removeTempDir(dataDir))
    cleanups.push(() => removeTempDir(packageDir))
    const built = buildPackageEntries({
      extraFiles: { 'credentials/exactly-entry-cap.bin': 'x'.repeat(MAX_PACKAGE_ENTRY_BYTES) }
    })
    writePackageDir(packageDir, built)
    const outcome = await importFrom(dataDir, packageDir, built.digest)
    expect(outcome.outcome).toBe('imported')
  })

  it('上限常量给真实签发包留足余量:单文件 ≥ 16×overlay 64KB,总量 ≥ 8×单文件', () => {
    expect(MAX_PACKAGE_ENTRY_BYTES).toBeGreaterThanOrEqual(16 * 64 * 1024)
    expect(MAX_PACKAGE_TOTAL_BYTES).toBeGreaterThanOrEqual(8 * MAX_PACKAGE_ENTRY_BYTES)
  })
})

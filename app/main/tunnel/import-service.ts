// 导入动作(定稿第 4 轮 2):批次目录隔离 + 解包安全 + 校验 + 原子落 pending。
// current 指针与它指向的批次目录在导入全程一个字节不动;取消 / 失败 / 崩溃只清本次 staging。
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  PackageReject,
  REJECT_REASONS,
  packageDigest,
  validatePackage,
  type PackageEntry,
  type RejectCode,
  type ValidatedPackage
} from './package-format'
import { readCurrentInfo, writeImportMeta } from './import-meta'
import { parseTarEntries, UnsafePackageEntry } from './tar'
import { layout, generateBatchId } from './paths'
import { sweepOrphanBatches, writePendingPointer } from './transactions'
import type { TrustContext } from './trust'
import type { Platform } from '../precheck/software-platform'

export type ImportOutcome =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'rejected'; readonly code: RejectCode; readonly message: string }
  | {
      readonly outcome: 'imported'
      readonly batchId: string
      readonly authorizationId: string
      readonly nodeLabel: string
      readonly expiresAt: string
      readonly sourceLine: string
      readonly packageDigest: string
    }

export interface ImportDeps {
  readonly dataDir: string
  readonly picker: () => Promise<string | undefined>
  readonly trust: TrustContext
  readonly now: () => number
  readonly sourceLineOf: (validated: ValidatedPackage) => string
  // 接收方运行平台:包平台与它不符即拒;缺省由 package-format 按进程平台推导。
  readonly runtimePlatform?: Platform
  // 测试钩子(判据 13③ 的 kill 窗口):校验通过、任何提交字节落盘之前调用
  readonly afterValidation?: (validated: ValidatedPackage) => Promise<void>
}

export function readCurrentManifest(
  dataDir: string
): { batchId: string; configVersion: number; authorizationId: string; expiresAt: string } | undefined {
  const info = readCurrentInfo(dataDir)
  return info === undefined
    ? undefined
    : { batchId: info.batchId, configVersion: info.configVersion, authorizationId: info.authorizationId, expiresAt: info.expiresAt }
}

function storedPackageDigest(deps: ImportDeps, current: NonNullable<ReturnType<typeof readCurrentManifest>>): string | undefined {
  try {
    const entries = readPackageEntries(layout.batchDir(deps.dataDir, current.batchId)).filter((entry) => entry.path !== 'import-meta.json')
    const expiresAt = Date.parse(current.expiresAt)
    return validatePackage(entries, { now: Number.isFinite(expiresAt) ? Math.min(deps.now(), expiresAt - 1) : deps.now(), currentVersion: undefined, currentAuthorizationId: current.authorizationId,
      trust: deps.trust, runtimePlatform: deps.runtimePlatform }).packageDigest
  } catch { return undefined }
}

// 读包:目录或 .lxtpack(ustar)。解包前逐项拒绝越界 / 绝对路径 / 符号链接逃逸 / 重名。
export function readPackageEntries(packagePath: string): PackageEntry[] {
  const stat = lstatSync(packagePath)
  if (stat.isDirectory()) {
    return readDirectoryEntries(packagePath)
  }
  return parseTarEntries(readFileSync(packagePath))
}

function readDirectoryEntries(root: string): PackageEntry[] {
  const resolvedRoot = realpathSync(resolve(root))
  const entries: PackageEntry[] = []
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        throw new UnsafePackageEntry(`符号链接:${relative(root, path)}`)
      }
      if (stat.isDirectory()) {
        walk(path)
        continue
      }
      if (!stat.isFile()) {
        throw new UnsafePackageEntry(`非常规文件:${relative(root, path)}`)
      }
      const real = realpathSync(path)
      if (real !== resolve(path) && !real.startsWith(`${resolvedRoot}${sep}`)) {
        throw new UnsafePackageEntry(`路径逃逸:${relative(root, path)}`)
      }
      const rel = relative(root, path).split(sep).join('/')
      entries.push({ path: rel, data: readFileSync(path) })
    }
  }
  walk(root)
  return entries
}

export async function importConfig(deps: ImportDeps): Promise<ImportOutcome> {
  const picked = await deps.picker()
  if (picked === undefined) {
    return { outcome: 'cancelled' }
  }
  return commitPackage(deps, () => readPackageEntries(picked))
}

export function importAccountConfig(deps: ImportDeps, archive: Buffer,
  account: { id: string; authorizationId: string; expiresAt: number }, beforeCommit: () => void): Promise<ImportOutcome> {
  return commitPackage(deps, () => parseTarEntries(archive), account, beforeCommit)
}

async function commitPackage(deps: ImportDeps, readEntries: () => PackageEntry[],
  account?: { id: string; authorizationId: string; expiresAt: number }, beforeCommit?: () => void): Promise<ImportOutcome> {
  const batchId = generateBatchId(deps.now)
  const stagingDir = layout.stagingDir(deps.dataDir, batchId)

  try {
    sweepOrphanBatches(deps.dataDir)
    const entries = readEntries()
    const current = readCurrentManifest(deps.dataDir)
    const comparesCurrent = !account || current?.authorizationId === account.authorizationId
    const validated = validatePackage(entries, {
      now: deps.now(),
      currentVersion: comparesCurrent ? current?.configVersion : undefined,
      currentAuthorizationId: account?.authorizationId ?? current?.authorizationId,
      currentPackageDigest: comparesCurrent && current ? storedPackageDigest(deps, current) : undefined,
      trust: deps.trust,
      runtimePlatform: deps.runtimePlatform
    })
    if (account && Date.parse(validated.manifest.expiresAt) !== account.expiresAt) throw new PackageReject('PACKAGE_MALFORMED')
    await deps.afterValidation?.(validated)
    beforeCommit?.()
    // 全部校验通过才落盘:先 staging,再原子 rename 进 imports/,最后原子写 pending 指针。
    writeEntriesToStaging(stagingDir, entries)
    const commitDir = layout.batchDir(deps.dataDir, batchId)
    mkdirSync(layout.imports(deps.dataDir), { recursive: true })
    renameSync(stagingDir, commitDir)
    const sourceLine = deps.sourceLineOf(validated)
    writeImportMeta(deps.dataDir, batchId, {
      ...(account ? { accountId: account.id } : {}),
      sourceLine,
      packageDigest: validated.packageDigest,
      importedAt: new Date(deps.now()).toISOString()
    })
    writePendingPointer(deps.dataDir, batchId)
    return {
      outcome: 'imported',
      batchId,
      authorizationId: validated.manifest.authorizationId,
      nodeLabel: `${validated.manifest.node.host}:${String(validated.manifest.node.port)}`,
      expiresAt: validated.manifest.expiresAt,
      sourceLine: deps.sourceLineOf(validated),
      packageDigest: validated.packageDigest
    }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    if (error instanceof PackageReject) {
      return { outcome: 'rejected', code: error.code, message: REJECT_REASONS[error.code] }
    }
    if (error instanceof UnsafePackageEntry) {
      return { outcome: 'rejected', code: 'PACKAGE_ENTRY_UNSAFE', message: REJECT_REASONS.PACKAGE_ENTRY_UNSAFE }
    }
    throw error
  }
}

function writeEntriesToStaging(stagingDir: string, entries: readonly PackageEntry[]): void {
  for (const entry of entries) {
    const target = join(stagingDir, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    // 凭据 0600;其余包文件同样 0600(数据目录本来就只属本用户)
    writeFileSync(target, entry.data, { mode: 0o600 })
  }
}

export { packageDigest }

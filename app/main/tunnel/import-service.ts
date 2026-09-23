// 导入动作(定稿第 4 轮 2):批次目录隔离 + 解包安全 + 校验 + 原子落 pending。
// current 指针与它指向的批次目录在导入全程一个字节不动;取消 / 失败 / 崩溃只清本次 staging。
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  PackageReject,
  REJECT_REASONS,
  MAX_PACKAGE_ENTRY_BYTES,
  MAX_PACKAGE_TOTAL_BYTES,
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
import { configFaultCore } from '../ai-access/config-write-fault'
import type { TrustContext } from './trust'
import type { Platform } from '../precheck/software-platform'

// N-18 同一套 fs 错误码判据(⛔ 另起宽泛体系)。tunnel-service 那份是同款;本文件被它引用,
// 判据放一处会成环,各留一份并互指。
const LOCAL_WRITE_FAULT_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'EIO'])
// 甲-6返工(④):读客户选的配置包的判据按「读」的语义收窄——读不进来只有找不到/没权限/IO 出错;
// EROFS/ENOSPC 是写侧的病,读失败冒充它们同样跑偏。其余码交外层,归因不变。
const LOCAL_READ_FAULT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO'])

export type ImportOutcome =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'rejected'; readonly code: RejectCode | 'TUNNEL_LOCAL_WRITE_FAILED' | 'TUNNEL_LOCAL_READ_FAILED'; readonly message: string }
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

function storedPackageDigest(deps: Omit<ImportDeps, 'picker'>, current: NonNullable<ReturnType<typeof readCurrentManifest>>): string | undefined {
  try {
    const entries = readPackageEntries(layout.batchDir(deps.dataDir, current.batchId)).filter((entry) => entry.path !== 'import-meta.json')
    const expiresAt = Date.parse(current.expiresAt)
    return validatePackage(entries, { now: Number.isFinite(expiresAt) ? Math.min(deps.now(), expiresAt - 1) : deps.now(), currentVersion: undefined, currentAuthorizationId: current.authorizationId,
      trust: deps.trust, runtimePlatform: deps.runtimePlatform }).packageDigest
  } catch { return undefined }
}

// 读包:目录或 .lxtpack(ustar)。解包前逐项拒绝越界 / 绝对路径 / 符号链接逃逸 / 重名。
// 甲-8:读取前按 lstat 的 size 设闸——⛔ 无界 readFileSync 进主进程再同步解包 + 逐项 sha256
// (界面卡死时长随文件大小线性涨的根因)。超限抛受控 PackageReject(PACKAGE_TOO_LARGE),
// 文案说「太大」;⛔ 被甲-6 返工的读失败 catch 认领(它只认 fs 错误码,PackageReject 原样放行)。
// 存量复查(tunnel-service validateStored / storedPackageDigest)走同一道闸,合法包 KB 级不误伤。
export function readPackageEntries(packagePath: string): PackageEntry[] {
  const stat = lstatSync(packagePath)
  if (stat.isDirectory()) {
    return readDirectoryEntries(packagePath)
  }
  // 单文件形态 = 整包,按总量上限闸。
  if (stat.size > MAX_PACKAGE_TOTAL_BYTES) {
    throw new PackageReject('PACKAGE_TOO_LARGE')
  }
  return parseTarEntries(readFileSync(packagePath))
}

function readDirectoryEntries(root: string): PackageEntry[] {
  const resolvedRoot = realpathSync(resolve(root))
  const entries: PackageEntry[] = []
  let totalSize = 0
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
      // 甲-8:单文件与累计总量都在读取前核,⛔ 逐文件整读同样无界。
      if (stat.size > MAX_PACKAGE_ENTRY_BYTES || totalSize + stat.size > MAX_PACKAGE_TOTAL_BYTES) {
        throw new PackageReject('PACKAGE_TOO_LARGE')
      }
      totalSize += stat.size
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

// N-22:导入拆两段——选文件(picker)可能耗时多久都行,真正需要互斥的只有解析与提交
// (commitPackage)。tunnel-service 在两段之间抢互斥锁;这个组合函数保留给测试与不需要
// 中间抢锁的调用方,两段各自行为以这里为准。
export async function importConfig(deps: ImportDeps): Promise<ImportOutcome> {
  const picked = await deps.picker()
  if (picked === undefined) {
    return { outcome: 'cancelled' }
  }
  return commitPickedConfig(deps, picked)
}

// 第二段:解析客户选中的包并提交。可独立调用,供调用方在 picker 与提交之间做自己的互斥。
// 依赖里没有 picker:提交段不碰文件框(Omit 由类型把关,⛔ 误把选文件挪进互斥窗口)。
export function commitPickedConfig(deps: Omit<ImportDeps, 'picker'>, picked: string): Promise<ImportOutcome> {
  return commitPackage(deps, () => readPackageEntries(picked))
}

export function importAccountConfig(deps: ImportDeps, archive: Buffer,
  account: { id: string; authorizationId: string; expiresAt: number }, beforeCommit: () => void): Promise<ImportOutcome> {
  return commitPackage(deps, () => parseTarEntries(archive), account, beforeCommit)
}

async function commitPackage(deps: Omit<ImportDeps, 'picker'>, readEntries: () => PackageEntry[],
  account?: { id: string; authorizationId: string; expiresAt: number }, beforeCommit?: () => void): Promise<ImportOutcome> {
  const batchId = generateBatchId(deps.now)
  const stagingDir = layout.stagingDir(deps.dataDir, batchId)

  try {
    sweepOrphanBatches(deps.dataDir)
    let entries: PackageEntry[]
    try {
      entries = readEntries()
    } catch (error) {
      // 甲-6返工(④):读客户选的配置包与写工具箱数据目录分开归因。包被移走/没有读取权限,
      // 对症说「请重新选择」;⛔ 让读失败冒充写入失败、指使客户去清磁盘。PackageReject/
      // UnsafePackageEntry 与其余错误原样交外层 catch,归因与甲-6 一字不变。
      const faultCode = configFaultCore(error).code
      if (faultCode !== undefined && LOCAL_READ_FAULT_CODES.has(faultCode)) {
        rmSync(stagingDir, { recursive: true, force: true })
        return { outcome: 'rejected', code: 'TUNNEL_LOCAL_READ_FAILED',
          message: '读不到你选的配置包（可能已被移动或没有读取权限），请重新选择' }
      }
      throw error
    }
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
    // 甲-6:本地故障(磁盘满/目录不可写/rename 失败)如实说,⛔ 原样上抛让桥层兜底成
    // 「重新导入配置包」——照做无用。码与文案与 N-18 同表同句(账号同步路径经这里时
    // 拿到的码/文案与从前一致);程序错误(无 fs 码)照旧上抛,由兜底留证,⛔ 冒充写入失败。
    const faultCode = configFaultCore(error).code
    if (faultCode !== undefined && LOCAL_WRITE_FAULT_CODES.has(faultCode)) {
      return { outcome: 'rejected', code: 'TUNNEL_LOCAL_WRITE_FAILED',
        message: '工具箱写入本地数据失败（磁盘已满或目录不可写），请清理磁盘空间或检查数据目录后重试' }
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

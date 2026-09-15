/**
 * 首批 Mac 客户使用回执（API-04）：仅 macOS 在本机按固定上限记录模型接入五个固定阶段的
 * 结果，客户在「模型 API」页手动生成、预览后复制或保存，再自行发送给支持方。
 * 三条硬边界：字段逐项白名单（⛔ 任何自由文本、账号、Key、模型、配置、路径、日志、网络信息）；
 * 只在本机（⛔ 自动上传、webhook、任何网络请求，⛔ 复用网络诊断的载荷与上传器）；
 * 记录或导出失败绝不影响配置、探测、调用、解除或恢复。
 * 保存严格绑定预览：generate 在主进程留存短期快照（随机标识），save 只认标识取回**那一份**
 * 文本；预览之后的新事件、渲染层伪造的标识都改变不了客户已预览并保存的内容。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AiAccessShell } from './service'
import { apiFailureMessages } from '../../shared/api-service-types'
import type { AiGatewayUsageEvent } from './gateway'

export const usageReceiptStages = ['config-target', 'probe', 'config-write', 'client-call', 'codex-desktop'] as const
export type UsageReceiptStage = typeof usageReceiptStages[number]

export const usageReceiptOutcomes = ['success', 'failure', 'unverified'] as const
export type UsageReceiptOutcome = typeof usageReceiptOutcomes[number]

/** 每条记录只允许这些字段，一个都不能多。 */
export interface UsageReceiptEntry {
  readonly version: string
  readonly osVersion: string
  readonly client: AiAccessShell
  /** 客户端自身版本；读不到如实记固定值 unknown（FR-26「客户端名称及版本」）。 */
  readonly clientVersion: string
  readonly at: string
  readonly stage: UsageReceiptStage
  readonly outcome: UsageReceiptOutcome
  readonly code?: string
}

export interface UsageReceiptEvent {
  readonly shell: AiAccessShell
  readonly stage: UsageReceiptStage
  readonly outcome: UsageReceiptOutcome
  /** 只认既有固定错误分类或错误代码，⛔ 自由文本。 */
  readonly code?: string
  /** 测试注入；产品调用缺省为当前时间。 */
  readonly at?: string
}

export interface UsageReceiptStore {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
}

export interface UsageReceiptRecorderOptions {
  readonly platform: NodeJS.Platform
  readonly version: string
  readonly osVersion: string
  readonly store: UsageReceiptStore
  /**
   * 客户端版本读取：只从受信任安装位置读；实现方负责超时与异常，读不到返回 unknown。
   * record 的调用方永远不等待它（异步队列内取，按壳缓存）。
   */
  readonly clientVersion?: (shell: AiAccessShell) => Promise<string>
  readonly now?: () => number
  readonly maxEntries?: number
  readonly retentionDays?: number
  /** 预览快照的短期有效期与容量上限；超时/超量即作废，保存须重新生成预览。 */
  readonly snapshotTtlMs?: number
  readonly maxSnapshots?: number
}

export interface UsageReceiptGenerateResult {
  readonly ok: boolean
  readonly reason?: 'unsupported' | 'empty'
  readonly count?: number
  readonly receipt?: string
  /** 主进程预览快照标识：保存时原样回传，⛔ 由渲染层自造。 */
  readonly snapshotId?: string
}

export interface UsageReceiptSaveResult {
  readonly ok: boolean
  readonly reason?: 'unsupported' | 'empty' | 'no-preview' | 'expired' | 'write-failed'
}

export type UsageReceiptSnapshotStatus = 'ok' | 'no-preview' | 'expired'

export interface UsageReceiptRecorder {
  record(event: UsageReceiptEvent): void
  generate(): Promise<UsageReceiptGenerateResult>
  /** 保存只认主进程快照：文本取自客户预览的那一份，⛔ 重新生成。 */
  save(targetPath: string, snapshotId?: string): Promise<UsageReceiptSaveResult>
  /** 保存动作在弹系统对话框前先核对快照，⛔ 让客户白选一次目录。 */
  peekSnapshot(snapshotId?: string): UsageReceiptSnapshotStatus
}

/** 固定阶段名。 */
const stageLabels: Readonly<Record<UsageReceiptStage, string>> = {
  'config-target': '配置目标检查',
  probe: '上游探测',
  'config-write': '配置写入',
  'client-call': '客户端调用观察',
  'codex-desktop': 'Codex Desktop 证明'
}
const outcomeLabels: Readonly<Record<UsageReceiptOutcome, string>> = { success: '成功', failure: '失败', unverified: '未验证' }
const clientLabels: Readonly<Record<AiAccessShell, string>> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }

/** 白名单代码全集 = 既有失败分类 + 配置目标原因 + Codex Desktop 证明原因； ⛔ 自由文本。 */
const usageReceiptCodes = new Set<string>([
  ...Object.keys(apiFailureMessages),
  'project-config-overrides-user', 'project-configuration-ignored', 'managed-configuration',
  'command-line-config-override', 'unreadable-configuration', 'symlinked-configuration', 'unknown-launch-context',
  'verified_socket_bound_desktop', 'awaiting_desktop_request', 'incomplete_answer', 'platform_unsupported',
  'socket_metadata_unavailable', 'socket_owner_not_found', 'socket_owner_ambiguous', 'socket_owner_not_codex_desktop',
  'desktop_signature_unverified', 'socket_binding_unavailable'
])

/** 客户端版本只收版本号形状或固定未知值；⛔ 自由文本借版本字段进回执。 */
export const USAGE_RECEIPT_UNKNOWN_VERSION = 'unknown'
const clientVersionPattern = /^[A-Za-z0-9][A-Za-z0-9.+-_]{0,63}$/

export function normalizeClientVersion(value: unknown): string {
  return typeof value === 'string' && clientVersionPattern.test(value) ? value : USAGE_RECEIPT_UNKNOWN_VERSION
}

export const USAGE_RECEIPT_MAX_ENTRIES = 30
export const USAGE_RECEIPT_RETENTION_DAYS = 14
export const USAGE_RECEIPT_SNAPSHOT_TTL_MS = 10 * 60_000
export const USAGE_RECEIPT_MAX_SNAPSHOTS = 3

interface ReceiptSnapshot {
  readonly text: string
  readonly expiresAt: number
}

/** 客户在模型 API 页手动触发；成功时的文本只由白名单字段渲染而成。 */
export function createUsageReceiptRecorder(options: UsageReceiptRecorderOptions): UsageReceiptRecorder {
  const maxEntries = options.maxEntries ?? USAGE_RECEIPT_MAX_ENTRIES
  const retentionMs = (options.retentionDays ?? USAGE_RECEIPT_RETENTION_DAYS) * 86_400_000
  const snapshotTtlMs = options.snapshotTtlMs ?? USAGE_RECEIPT_SNAPSHOT_TTL_MS
  const maxSnapshots = options.maxSnapshots ?? USAGE_RECEIPT_MAX_SNAPSHOTS
  const now = options.now ?? Date.now
  // 记录永远异步落盘、串行排队：主流程调用这一下就返回，⛔ 让磁盘慢或版本探测拖住配置或探测。
  let queue: Promise<unknown> = Promise.resolve()
  const supported = (): boolean => options.platform === 'darwin'
  // 生成／保存前先排空挂起的写入：客户刚用完就点「生成」也要看到刚发生的事。
  const drain = async (): Promise<void> => { await queue.catch(() => undefined) }
  const trimmed = async (): Promise<UsageReceiptEntry[]> => trimEntries(await readEntries(options.store), now() - retentionMs, maxEntries)
  // 预览快照只活在主进程内存：标识是随机 UUID，渲染层伪造不出有效 id，更传不进任何文本。
  const snapshots = new Map<string, ReceiptSnapshot>()
  const rememberSnapshot = (text: string): string => {
    const id = randomUUID()
    snapshots.set(id, { text, expiresAt: now() + snapshotTtlMs })
    while (snapshots.size > maxSnapshots) {
      const oldest = snapshots.keys().next().value
      if (oldest === undefined) break
      snapshots.delete(oldest)
    }
    return id
  }
  const snapshotStatus = (snapshotId?: string): UsageReceiptSnapshotStatus => {
    if (snapshotId === undefined) return 'no-preview'
    const snapshot = snapshots.get(snapshotId)
    if (snapshot === undefined) return 'no-preview'
    if (now() >= snapshot.expiresAt) {
      snapshots.delete(snapshotId)
      return 'expired'
    }
    return 'ok'
  }
  return {
    record(event) {
      if (!supported()) return
      // 版本读取只发生在异步队列里：record 的调用方（配置/探测/调用主流程）此刻已经返回。
      queue = queue.then(async () => {
        const clientVersion = await resolveClientVersion(options.clientVersion, event.shell)
        const entry = entryFromEvent(event, options.version, options.osVersion, clientVersion, now)
        if (entry === undefined) return
        const entries = [...await readEntries(options.store), entry]
        await options.store.write(trimEntries(entries, Date.now() - retentionMs, maxEntries))
      }).catch(() => undefined)
    },
    async generate() {
      if (!supported()) return { ok: false, reason: 'unsupported' }
      await drain()
      const entries = await trimmed()
      if (entries.length === 0) return { ok: false, reason: 'empty' }
      const receipt = receiptText(entries)
      return { ok: true, count: entries.length, receipt, snapshotId: rememberSnapshot(receipt) }
    },
    peekSnapshot(snapshotId) {
      return snapshotStatus(snapshotId)
    },
    async save(targetPath, snapshotId) {
      if (!supported()) return { ok: false, reason: 'unsupported' }
      const status = snapshotStatus(snapshotId)
      // 保存只写客户预览过的那一份；⛔ 重新生成（预览后新事件会悄悄改掉落盘内容）。
      if (status !== 'ok') return { ok: false, reason: status }
      const snapshot = snapshots.get(snapshotId!)
      try {
        await writeFile(targetPath, `${snapshot!.text}\n`, { encoding: 'utf8', mode: 0o600 })
        return { ok: true }
      } catch {
        return { ok: false, reason: 'write-failed' }
      }
    }
  }
}

/** 版本读取失败/超时/形状不对都归一为固定未知值，⛔ 拖慢或打断记录。 */
async function resolveClientVersion(reader: ((shell: AiAccessShell) => Promise<string>) | undefined, shell: AiAccessShell): Promise<string> {
  if (reader === undefined) return USAGE_RECEIPT_UNKNOWN_VERSION
  try {
    return normalizeClientVersion(await reader(shell))
  } catch {
    return USAGE_RECEIPT_UNKNOWN_VERSION
  }
}

/** 网关的调用观察/桌面证明事件 → 白名单回执事件；映射固定，⛔ 夹带其他字段。 */
export function gatewayUsageEventToReceipt(event: AiGatewayUsageEvent): UsageReceiptEvent {
  if (event.kind === 'client-accepted') return { shell: event.shell, stage: 'client-call', outcome: 'success', at: event.at }
  return {
    shell: event.shell, stage: 'codex-desktop',
    outcome: event.verified ? 'success' : 'unverified',
    ...(event.verified ? {} : { code: event.reason }),
    at: event.at
  }
}

/** 本机回执文件：内容按构造不含敏感数据，普通 JSON 即可，客户自己也能打开看。 */
export function createUsageReceiptFileStore(root: string, name = 'usage-receipt.json'): UsageReceiptStore {
  const path = join(root, name)
  return {
    async read() {
      const raw = await readFile(path, 'utf8')
      return JSON.parse(raw) as unknown
    },
    async write(value) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const temporary = join(root, `usage-receipt-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    }
  }
}

/** 去掉 14 天以前与上限之外的记录，保留最新；输入顺序保持发生时间顺序。 */
function trimEntries(entries: readonly UsageReceiptEntry[], cut: number, maxEntries: number): UsageReceiptEntry[] {
  const current = entries.filter(entry => Date.parse(entry.at) >= cut)
  return current.slice(Math.max(0, current.length - maxEntries))
}

function entryFromEvent(event: UsageReceiptEvent, version: string, osVersion: string, clientVersion: string, now: () => number): UsageReceiptEntry | undefined {
  const at = event.at ?? new Date(now()).toISOString()
  const candidate: UsageReceiptEntry = {
    version, osVersion, client: event.shell, clientVersion, at,
    stage: event.stage, outcome: event.outcome,
    ...(event.code === undefined ? {} : { code: event.code })
  }
  return validUsageReceiptEntry(candidate) ? candidate : undefined
}

/** 逐字段校验：字段集合必须恰好等于白名单；多一个字段、错一个枚举值都整条拒收。 */
export function validUsageReceiptEntry(value: unknown): value is UsageReceiptEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const allowed = new Set<string>(['version', 'osVersion', 'client', 'clientVersion', 'at', 'stage', 'outcome', ...(entry.code === undefined ? [] : ['code'])])
  if (Object.keys(entry).some(key => !allowed.has(key))) return false
  const text = (key: string): boolean => typeof entry[key] === 'string' && (entry[key] as string).length > 0 && (entry[key] as string).length <= 64
  return text('version') && text('osVersion') && typeof entry.client === 'string' && entry.client in clientLabels &&
    typeof entry.clientVersion === 'string' && (entry.clientVersion === USAGE_RECEIPT_UNKNOWN_VERSION || clientVersionPattern.test(entry.clientVersion)) &&
    typeof entry.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.at) && Number.isFinite(Date.parse(entry.at)) &&
    typeof entry.stage === 'string' && usageReceiptStages.includes(entry.stage as UsageReceiptStage) &&
    typeof entry.outcome === 'string' && usageReceiptOutcomes.includes(entry.outcome as UsageReceiptOutcome) &&
    (entry.code === undefined || (typeof entry.code === 'string' && usageReceiptCodes.has(entry.code)))
}

async function readEntries(store: UsageReceiptStore): Promise<UsageReceiptEntry[]> {
  try {
    const value: unknown = await store.read()
    if (!Array.isArray(value)) return []
    return value.filter(item => validUsageReceiptEntry(item))
  } catch {
    return []
  }
}

/** 导出文本只从白名单字段逐项渲染；⛔ JSON.stringify 整条记录（会把未知字段带出去）。 */
function receiptText(entries: readonly UsageReceiptEntry[]): string {
  const lines: string[] = [`来信AI工具箱 Mac 使用回执（共 ${String(entries.length)} 条）`, '']
  entries.forEach((entry, index) => {
    lines.push(`${String(index + 1)}. 发生时间：${entry.at}`,
      `   客户端：${clientLabels[entry.client]}`,
      `   客户端版本：${entry.clientVersion}`,
      `   阶段：${stageLabels[entry.stage]}`,
      `   结果：${outcomeLabels[entry.outcome]}${entry.code === undefined ? '' : `（${entry.code}）`}`,
      `   工具箱版本：${entry.version}`,
      `   macOS 版本：${entry.osVersion}`,
      '')
  })
  lines.push('本回执只包含上述白名单字段，不含账号、设备标识、Key、令牌、模型、服务商、提示词、回答、配置内容、路径、日志、网络信息或任何自由文本。',
    '请你自行复制或保存并发送给支持方；工具箱不会自动发送，也不表示支持方已收到。')
  return lines.join('\n')
}

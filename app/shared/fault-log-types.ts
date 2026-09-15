import { apiFailureMessage, apiRemedyActions, apiFailureMessages, type ApiFailure, type ApiRemedyAction, type ApiRemedyOutcome, type ApiShell, type ModelProviderId } from './api-service-types'
import { modelProviderIds } from './model-providers'

/**
 * 一条故障经过。字段全部是枚举或短文本，**⛔ Key、令牌、提示词与回复正文**——
 * 记录是给客服看的「什么时候、哪个软件、哪一类问题、试过什么、结果如何」，不是日志转储。
 */
export interface FaultRecord {
  /** ISO 时间。 */
  readonly at: string
  /** 工具箱版本。 */
  readonly version: string
  readonly shell?: ApiShell
  readonly provider?: ModelProviderId
  /** C5 判类。 */
  readonly code?: ApiFailure
  /** C7 处理动作。 */
  readonly action?: ApiRemedyAction
  /** C7 复验结果。 */
  readonly outcome?: ApiRemedyOutcome
  /** D1 网络检查结论码，形如 AI_DIAG_*。 */
  readonly network?: string
  /** 短说明**只能是模板 id**，⛔ 自由文本——上游错误体、提示词、回复正文都进不来。 */
  readonly note?: FaultNoteId
  /** 模板里的参数，最多 3 个、每个 ≤15 字符（比 Key 的最短长度还短，装不下凭据）。 */
  readonly noteParams?: readonly string[]
}

/**
 * 说明模板表。记录里只存 id 与少量枚举/数字参数，渲染时才拼成人话。
 * 这样无论谁调用、传进来什么，落盘的都只会是这张表里的话。
 */
export const faultNotes = {
  configuration_modified: '这个 AI 的配置被工具箱以外的程序改过了',
  configuration_missing: '这个 AI 里工具箱写的那段配置不见了',
  shell_version_incompatible: '这个 AI 当前安装的版本与第三方模型接口不兼容',
  recovery_port_changed: '本机 API 服务端口被占用，已换到 {0} 并回写各 AI 的配置',
  recovery_service_down: '本机 API 服务没能启动',
  recovery_config_broken: '配置已不是工具箱写的那份，需要重新写入',
  recovery_state_unavailable: '本机保存的接入状态读不到或写不进',
  stream_interrupted: '通道中断时打断了 {0} 条回答',
  network_repair_recovered: '用户发起网络修复，本机代理与通道出口已重新验证通过；未验证 AI 账号或对话',
  network_repair_unresolved: '用户发起网络修复，未确认恢复；没有强制接管第三方设置，请结合本次诊断继续排查'
} as const
export type FaultNoteId = keyof typeof faultNotes
/** 参数只收短枚举与版本号一类；⛔ 放行任何能装下 Key（≥16 位）的串。 */
const noteParamPattern = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,14}$/
const FAULT_NOTE_PARAM_LIMIT = 3

export const faultShells: readonly ApiShell[] = ['codex', 'claude', 'hermes']
export const faultOutcomes: readonly ApiRemedyOutcome[] = ['recovered', 'still_failing', 'unknown']
const networkCodePattern = /^AI_DIAG_[A-Z0-9_]{1,48}$/
/** 与 Key 校验同形的长串（⩾16 位）一律拒收；⛔ 带 g 标志，test() 会留 lastIndex 状态。 */
const secretLike = /[A-Za-z0-9._-]{16,}/
export const FAULT_NOTE_LIMIT = 200

/** 清洗一条记录：字段不在清单内就丢掉该字段，说明抹掉长串并截断。整条不可用返回 undefined。 */
export function sanitizeFaultRecord(value: unknown): FaultRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? raw.at : undefined
  if (at === undefined) return undefined
  const version = typeof raw.version === 'string' ? raw.version.slice(0, 32) : ''
  const shell = faultShells.includes(raw.shell as ApiShell) ? raw.shell as ApiShell : undefined
  const provider = modelProviderIds.includes(raw.provider as ModelProviderId) ? raw.provider as ModelProviderId : undefined
  const code = typeof raw.code === 'string' && Object.hasOwn(apiFailureMessages, raw.code) ? raw.code as ApiFailure : undefined
  const action = apiRemedyActions.includes(raw.action as ApiRemedyAction) ? raw.action as ApiRemedyAction : undefined
  const outcome = faultOutcomes.includes(raw.outcome as ApiRemedyOutcome) ? raw.outcome as ApiRemedyOutcome : undefined
  const network = typeof raw.network === 'string' && networkCodePattern.test(raw.network) ? raw.network : undefined
  const note = typeof raw.note === 'string' && Object.hasOwn(faultNotes, raw.note) ? raw.note as FaultNoteId : undefined
  const noteParams = note === undefined ? undefined : sanitizeFaultNoteParams(raw.noteParams)
  return { at, version, ...(shell ? { shell } : {}), ...(provider ? { provider } : {}), ...(code ? { code } : {}),
    ...(action ? { action } : {}), ...(outcome ? { outcome } : {}), ...(network ? { network } : {}), ...(note ? { note } : {}),
    ...(noteParams?.length ? { noteParams } : {}) }
}

export function sanitizeFaultNoteParams(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  // 三道：只收字符串、长度与字符集受限、再过一次凭据形状。任一不合格就丢掉这个参数。
  const kept = value.filter((item): item is string => typeof item === 'string' && noteParamPattern.test(item) && !secretLike.test(item))
    .slice(0, FAULT_NOTE_PARAM_LIMIT)
  return kept.length ? kept : undefined
}

/** 把模板与参数拼成人话；记录里从来只有 id 与参数。 */
export function faultNoteText(note: FaultNoteId, params: readonly string[] = []): string {
  return faultNotes[note].replace(/\{(\d)\}/g, (_match, index: string) => params[Number(index)] ?? '—').slice(0, FAULT_NOTE_LIMIT)
}

const shellNames: Record<ApiShell, string> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }
const outcomeNames: Record<ApiRemedyOutcome, string> = { recovered: '已恢复', still_failing: '仍有问题', unknown: '不能确认' }
const actionNames: Record<ApiRemedyAction, string> = {
  retest: '重新测试', reapply: '重新写入配置', restartGateway: '重启本机 API 服务', useOfficial: '恢复官方配置', openConsole: '打开官方控制台'
}

/** 一条故障的分列视图：时间 / 软件 / 类别 / 试过什么 / 结果，另附一句补充说明。 */
export interface FaultColumns {
  /** 原始 ISO 时间，供 `<time datetime>` 与排序用。 */
  readonly at: string
  readonly when: string
  readonly software: string
  readonly category: string
  /** 没试过就是空串；占位符留给界面决定，⛔ 在数据里塞「—」。 */
  readonly tried: string
  readonly outcome: string
  readonly note: string
}

/**
 * 分列的**唯一出处**：客服摘要与界面都从这里取。
 * ⛔ 谁再去拆已经渲染好的句子——那是拿展示当数据源。
 */
export function faultColumns(record: FaultRecord): FaultColumns {
  const what = record.code ? apiFailureMessage(record.code, record.provider) : record.network ? `网络检查 ${record.network}` : '未记录原因'
  return {
    at: record.at,
    when: new Date(record.at).toLocaleString('zh-CN'),
    software: `${record.shell ? shellNames[record.shell] : '工具箱'}${record.provider ? `/${record.provider}` : ''}`,
    category: `${record.code ?? record.network ?? '-'}：${what}`,
    tried: record.action ? actionNames[record.action] : '',
    outcome: record.outcome ? outcomeNames[record.outcome] : '',
    note: record.note ? faultNoteText(record.note, record.noteParams) : ''
  }
}

/** 客服摘要里的一行：与界面分列同一份数据拼出来，⛔ 各写一套。 */
export function faultLine(record: FaultRecord): string {
  const columns = faultColumns(record)
  const tried = columns.tried ? ` · 试过「${columns.tried}」${columns.outcome ? `→ ${columns.outcome}` : ''}` : ''
  return `${columns.when} · ${columns.software} · ${columns.category}${tried}${columns.note ? ` · ${columns.note}` : ''}`
}

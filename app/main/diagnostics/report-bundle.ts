// 一键上报的打包：客户点一下，这里决定**哪些字段**装进包。
//
// 取值一律走白名单（pickRedacted / 显式挑字段），⛔ 把上游对象整个塞进去——
// state.json 里就带着 sessionToken 与 intentToken，账本里带着系统设置原值，
// 「先全拿进来再过滤」等于把过滤当唯一防线。
//
// ⛔ 进包的三类（任务包硬要求）：
//  1. 凭据：VLESS uuid/publicKey/shortId、账号令牌、模型 Key —— 白名单不取 + 字段名闸 + 形状闸 + 整包复扫；
//  2. 账本**原值内容**（originalValue / writtenValue）—— 只出条目的类别、项目、状态与时刻；
//  3. 客户的浏览记录、请求网址、报文 —— 守护本来就不记（log.access = none），这里也不去别处捞。
import { credentialFindings, pickRedacted, redactText, redactValue } from './report-redact'
import { basename } from 'node:path'
import type { FaultRecord } from '../../shared/fault-log-types'
import { REPORT_MAX_BYTES } from '../../report-types'
import { supportDiagnosticAttemptLimit, type DiagnosticSoftware } from '../../network-diagnostics-types'
import type { SupportDiagnosis } from './support-snapshot'
import { normalizeLocalEgressEvidence } from '../../shared/local-egress-evidence'
import { sanitizeFunnelAttempt, type FunnelAttempt } from '../../../sidecar/shared/connection-funnel.mjs'
import { readRestoreObservation } from '../../../sidecar/shared/restore-observation.mjs'
import { connectionAttemptKeyOf } from '../../connection-attempt-types'

/** 通道状态里能出去的字段。⛔ authorization：它是句固定说明，没有诊断价值，反而会被字段名闸抹成问号。 */
const tunnelStatusFields = ['state', 'message', 'source', 'backend', 'nodeLabel', 'observedNodeLabel', 'exitIp', 'pathSource',
  'lastVerifiedAt', 'configVersion', 'expiresAt', 'pendingAvailable', 'currentConfig', 'pendingConfig',
  'canApplyPending', 'unrestored', 'componentMissing', 'sshBinary', 'traffic', 'recoveryDetail'] as const
const repairFields = ['running', 'startedAt', 'finishedAt', 'phase', 'outcome', 'code', 'message'] as const
/** state.json：⛔ sessionToken / intentToken，它们是真令牌。 */
const daemonStateFields = ['state', 'code', 'message', 'connectStage', 'exitIp', 'lastVerifiedAt', 'bridgePort', 'note', 'updatedAt', 'runId', 'reusedProxy'] as const
/** 账本条目：⛔ id（里面嵌着会话令牌）、originalValue、writtenValue、sessionToken。 */
const ledgerEntryFields = ['kind', 'service', 'item', 'status', 'time', 'note'] as const
/** 系统代理读数：`resolved` 是各目标地址会走到哪，`env` 是命令行 AI 认的那几个环境变量。
 * 这两段都是自由取值（地址里可能带账号密码），所以不走字段白名单、整段过形状闸。 */
const systemProxySections = ['resolved', 'env'] as const

const errorCodePattern = /^[A-Z][A-Z0-9_]{2,63}$/
const MAX_LOG_LINES = 300
const MAX_LEDGER_ENTRIES = 60
const MAX_FAULTS = 20
const MAX_ERROR_CODES = 20
/** 漏斗阶段行/尝试行的字段白名单(与 sidecar connection-funnel 落盘口径一致)。 */
const funnelStageFields = ['name', 'durationMs', 'outcome', 'code', 'at', 'phase'] as const
const MAX_FUNNEL_ATTEMPTS = 10
const availabilityStatuses = new Set(['examining', 'reusing', 'taking-over', 'reclaiming', 'recovering', 'recovered', 'limited'])
const availabilityActions = new Set(['inspect', 'reuse', 'takeover', 'reclaim', 'restore'])
const MAX_OBSERVED_CODES = 20

export interface ReportSources {
  /** 客户刚才在界面看到并可复制的那一次诊断；上报不得重新跑一遍替换它。 */
  readonly diagnosis?: SupportDiagnosis
  /** 诊断失败时，客户这次选择检查的软件；不附带任何假造的五项结论。 */
  readonly diagnosisUnavailableSoftware?: DiagnosticSoftware
  /** 其余机器读数可以稍后采集，但必须单独标时，不能冒充 diagnosis.checkedAt。 */
  readonly supplementalCollectedAt?: string
  /** tunnel.status 的读数（已是白名单视图，这里再挑一遍）。 */
  readonly tunnel?: unknown
  /** tunnel.repairStatus：最近一次网络自助修复。 */
  readonly repair?: unknown
  /** state.json 原文解析结果。 */
  readonly daemonState?: unknown
  /** ledger.json 原文解析结果（数组）。 */
  readonly ledger?: unknown
  /** 未恢复的系统设置条目。 */
  readonly unrestored?: unknown
  /** 系统代理读数：这一刻电脑上的代理设置长什么样。 */
  readonly systemProxy?: unknown
  /** 连接与复验记录。 */
  readonly connection?: unknown
  /** N-79 连接漏斗台账(守护白名单落盘;这里再过一遍验形)。 */
  readonly connectionFunnel?: unknown
  /** 守护日志：取自最后若干行；没生成就给 undefined，包里如实写「未生成」。 */
  readonly daemonLog?: { readonly source: string; readonly lines: readonly string[] }
  /** 日志没进包时，是「确实没生成」还是「读不出来」。⛔ 两种都写成「未生成」——
   * 那等于告诉客服「这台机器一切正常只是没日志」，而真相可能是磁盘或权限有毛病。 */
  readonly daemonLogAbsence?: 'not-generated' | 'unreadable'
  /** 最近的故障留痕（写入时已清洗过一道）。 */
  readonly faults?: readonly FaultRecord[]
  /** 最近的错误码。 */
  readonly errorCodes?: readonly string[]
  /** 读不到的项：读失败要写进包，⛔ 悄悄少一段让客服以为一切正常。 */
  readonly notes?: readonly string[]
}

export interface ReportBody extends Record<string, unknown> {
  readonly diagnosis: Record<string, unknown>
  readonly supplemental: Record<string, unknown>
  readonly network: Record<string, unknown>
  readonly daemonState: Record<string, unknown>
  /** 仅供内部优化使用的跨证据摘要；不改变客户可见文案。 */
  readonly optimization: Record<string, unknown>
  readonly ledger: Record<string, unknown>
  readonly systemProxy: Record<string, unknown>
  readonly connection: Record<string, unknown>
  readonly daemonLog: Record<string, unknown>
  readonly faults: readonly unknown[]
  readonly errorCodes: readonly string[]
  readonly notes: readonly string[]
  /** 整包复扫抹掉了几处凭据形状。正常是 0；非 0 说明上游多塞了字段，要去补白名单。 */
  readonly filtered: number
}

function diagnosisSection(diagnosis: SupportDiagnosis | undefined, unavailableSoftware: DiagnosticSoftware | undefined): Record<string, unknown> {
  if (!diagnosis) return { available: false, status: '未完成', ...(unavailableSoftware ? { software: unavailableSoftware } : {}) }
  const report = diagnosis.report
  const conclusion = report?.conclusion
  const localEgress = normalizeLocalEgressEvidence(diagnosis.localEgress)
  return {
    available: true,
    ...pickRedacted(diagnosis, ['id']),
    ...pickRedacted(report, ['software', 'checkedAt', 'validUntil']),
    target: pickRedacted(report?.target, ['label', 'route']),
    pathMatrix: report?.pathMatrix === undefined ? undefined : {
      ...pickRedacted(report.pathMatrix, ['checkedAt', 'valid']),
      entries: report.pathMatrix.entries.slice(0, 3).map((entry) =>
        pickRedacted(entry, ['path', 'state', 'phase', 'elapsedMs', 'message']))
    },
    ...(localEgress ? { localEgress } : {}),
    conclusion: {
      ...pickRedacted(conclusion, ['status', 'scope', 'ruleId', 'title', 'summary', 'nextStep']),
      evidence: Array.isArray(conclusion?.evidence)
        ? conclusion.evidence.slice(0, 5).map((item) => pickRedacted(item, ['checkId', 'code', 'statement'])) : []
    },
    checks: Array.isArray(report?.checks)
      ? report.checks.slice(0, 5).map((check) => pickRedacted(check, ['id', 'label', 'state', 'code', 'message', 'phase', 'elapsedMs'])) : [],
    attempts: Array.isArray(diagnosis.attempts)
      ? diagnosis.attempts.slice(0, supportDiagnosticAttemptLimit).map((attempt) => pickRedacted(attempt, ['at', 'software', 'action', 'outcome', 'detail'])) : [],
    attemptsTotal: Number.isSafeInteger(diagnosis.attemptsTotal) && diagnosis.attemptsTotal >= diagnosis.attempts.length
      ? diagnosis.attemptsTotal : diagnosis.attempts.length,
    attemptsComplete: diagnosis.attemptsComplete === true
  }
}

/** 账本摘要：条数与状态分布 + 每条的类别/项目/状态/时刻。⛔ 原值内容。 */
function ledgerSummary(ledger: unknown, unrestored: unknown): Record<string, unknown> {
  const entries = Array.isArray(ledger) ? ledger : []
  const byStatus: Record<string, number> = {}
  for (const entry of entries) {
    const status = entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).status ?? '未知') : '未知'
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  return {
    total: entries.length,
    byStatus,
    // 新的在前：客服先看最近发生了什么。
    entries: entries.slice(-MAX_LEDGER_ENTRIES).reverse().map((entry) => pickRedacted(entry, [...ledgerEntryFields])),
    unrestored: redactValue(Array.isArray(unrestored) ? unrestored.slice(0, 40).map((entry) => pickRedacted(entry, ['service', 'item', 'status', 'note'])) : [])
  }
}

function daemonLogSection(log: ReportSources['daemonLog'], absence: ReportSources['daemonLogAbsence']): Record<string, unknown> {
  const source = log ? redactText(basename(log.source.replaceAll('\\', '/'))) : ''
  if (!log || log.lines.length === 0) {
    const note = log ? `${source || '守护日志'}：文件在但没有内容`
      : absence === 'unreadable' ? '守护日志读不出来（文件在，但打不开或读失败）——这台机器另有毛病，⛔ 当成「没日志」放过'
      : '守护日志未生成（常驻守护未接入或本次由主进程带起）'
    return { available: false, reason: log ? 'empty' : absence ?? 'not-generated', note }
  }
  return { available: true, source: source || 'tunnel-daemon.log', lines: log.lines.slice(-MAX_LOG_LINES).map((line) => redactValue(line, { maxStringLength: 500 })) }
}

/**
 * 打包。返回**已封包**的 body：白名单取值 → 字段名与形状闸 → 整包复扫。
 * `filtered` 是复扫又抹掉的处数，正常为 0。
 */
/** 漏斗台账进包:逐条过 sidecar 验形(被改写的行整条丢弃),再按白名单挑字段。
 *  台账本体只有阶段码/毫秒/受控码,这里二次验形是双保险——⛔ 把未验形的自由文本带进包。 */
function sanitizedFunnelAttempts(source: unknown): FunnelAttempt[] | undefined {
  if (!Array.isArray((source as { attempts?: unknown } | undefined)?.attempts)) return undefined
  const attempts = (source as { attempts: readonly unknown[] }).attempts
    .map((row) => sanitizeFunnelAttempt(row))
    .filter((row): row is FunnelAttempt => row !== undefined)
    .slice(-MAX_FUNNEL_ATTEMPTS)
  return attempts.length === 0 ? undefined : attempts
}

function connectionFunnelSummary(source: unknown): unknown {
  const attempts = sanitizedFunnelAttempts(source)
  if (attempts === undefined) return undefined
  return attempts.map((attempt) => {
    const attemptKey = connectionAttemptKeyOf(attempt)
    return {
      trigger: attempt.trigger,
      startedAt: attempt.startedAt,
      ...(attemptKey === undefined ? {} : { attemptKey }),
      outcome: attempt.outcome,
      endedAt: attempt.endedAt,
      ...(attempt.code !== undefined ? { code: attempt.code } : {}),
      stages: attempt.stages.map((stage) => pickRedacted(stage, [...funnelStageFields]))
    }
  })
}

function safeDaemonState(source: unknown): Record<string, unknown> {
  const state = pickRedacted(source, [...daemonStateFields])
  if (!source || typeof source !== 'object' || Array.isArray(source)) return state
  const value = source as Record<string, unknown>
  const restoration = readRestoreObservation(value.restoration)
  if (restoration !== undefined) state.restoration = restoration
  const availability = value.availability
  if (availability && typeof availability === 'object' && !Array.isArray(availability)) {
    const candidate = availability as Record<string, unknown>
    const status = typeof candidate.status === 'string' && availabilityStatuses.has(candidate.status) ? candidate.status : undefined
    const action = typeof candidate.action === 'string' && availabilityActions.has(candidate.action) ? candidate.action : undefined
    const intentGeneration = Number.isSafeInteger(candidate.intentGeneration) && (candidate.intentGeneration as number) >= 0
      ? candidate.intentGeneration : undefined
    const code = typeof candidate.code === 'string' && errorCodePattern.test(candidate.code) ? candidate.code : undefined
    const active = typeof candidate.active === 'boolean' ? candidate.active : undefined
    if (status !== undefined || action !== undefined || intentGeneration !== undefined || code !== undefined || active !== undefined) {
      state.availability = { ...(active === undefined ? {} : { active }), ...(status === undefined ? {} : { status }),
        ...(action === undefined ? {} : { action }), ...(code === undefined ? {} : { code }),
        ...(intentGeneration === undefined ? {} : { intentGeneration }) }
    }
  }
  const recovery = value.recovery
  if (recovery && typeof recovery === 'object' && !Array.isArray(recovery)) {
    const candidate = recovery as Record<string, unknown>
    const id = Number.isSafeInteger(candidate.id) && (candidate.id as number) >= 0 ? candidate.id : undefined
    const attempts = Number.isSafeInteger(candidate.attempts) && (candidate.attempts as number) >= 0 ? candidate.attempts : undefined
    const outageMs = Number.isSafeInteger(candidate.outageMs) && (candidate.outageMs as number) >= 0 ? candidate.outageMs : undefined
    if (id !== undefined && attempts !== undefined && outageMs !== undefined) state.recovery = { id, attempts, outageMs }
  }
  return state
}

function optimizationSummary(input: {
  readonly daemonState: unknown
  readonly repair: unknown
  readonly connectionFunnel: unknown
  readonly faults: readonly FaultRecord[] | undefined
  readonly errorCodes: readonly string[] | undefined
}): Record<string, unknown> {
  const attempts = sanitizedFunnelAttempts(input.connectionFunnel) ?? []
  const terminal = attempts.filter((attempt) => attempt.outcome !== 'in-progress' && attempt.outcome !== 'stopped' && attempt.outcome !== 'superseded')
  const outcomes = new Map<string, number>()
  for (const attempt of terminal) outcomes.set(attempt.outcome, (outcomes.get(attempt.outcome) ?? 0) + 1)
  const latest = terminal.at(-1)
  const daemon = safeDaemonState(input.daemonState)
  const repair = input.repair && typeof input.repair === 'object' && !Array.isArray(input.repair) ? input.repair as Record<string, unknown> : undefined
  const observedCodes = [...new Set([
    daemon.code,
    (daemon.restoration as { lastFailureCode?: unknown } | undefined)?.lastFailureCode,
    (daemon.availability as { code?: unknown } | undefined)?.code,
    repair?.code,
    ...(input.errorCodes ?? []),
    ...(input.faults ?? []).flatMap((fault) => [fault.code, fault.network])
  ].filter((code): code is string => typeof code === 'string' && errorCodePattern.test(code)))].slice(0, MAX_OBSERVED_CODES)
  const evidenceSources = [
    daemon.code !== undefined || daemon.restoration !== undefined || daemon.availability !== undefined ? 'daemon-state' : undefined,
    typeof repair?.code === 'string' ? 'repair' : undefined,
    attempts.length > 0 ? 'connection-funnel' : undefined,
    (input.errorCodes?.length ?? 0) > 0 ? 'error-codes' : undefined,
    (input.faults?.length ?? 0) > 0 ? 'fault-log' : undefined
  ].filter((source): source is string => source !== undefined)
  return {
    connectionAttempts: {
      total: attempts.length,
      terminal: terminal.length,
      successful: (outcomes.get('connected') ?? 0) + (outcomes.get('reused') ?? 0),
      failed: (outcomes.get('failed') ?? 0) + (outcomes.get('fatal') ?? 0),
      abandoned: outcomes.get('abandoned') ?? 0,
      ...(latest === undefined ? {} : {
        latestAttemptKey: connectionAttemptKeyOf(latest),
        latestOutcome: latest.outcome
      })
    },
    lifecycle: {
      ...(daemon.restoration === undefined ? {} : { restoration: daemon.restoration }),
      ...(daemon.availability === undefined ? {} : { availability: daemon.availability }),
      ...(daemon.recovery === undefined ? {} : { recovery: daemon.recovery })
    },
    attribution: {
      unknown: observedCodes.includes('UNKNOWN'),
      evidenceSources,
      observedCodes
    }
  }
}

export function buildReportBody(sources: ReportSources): ReportBody {
  const notes = [...(sources.notes ?? [])]
  const draft = {
    diagnosis: diagnosisSection(sources.diagnosis, sources.diagnosisUnavailableSoftware),
    supplemental: pickRedacted({ collectedAt: sources.supplementalCollectedAt }, ['collectedAt']),
    network: {
      status: pickRedacted(sources.tunnel, [...tunnelStatusFields]),
      repair: pickRedacted(sources.repair, [...repairFields])
    },
    daemonState: safeDaemonState(sources.daemonState),
    ledger: ledgerSummary(sources.ledger, sources.unrestored),
    systemProxy: pickRedacted(sources.systemProxy, [...systemProxySections]),
    connection: redactValue(sources.connection ?? {}) as Record<string, unknown>,
    connectionFunnel: connectionFunnelSummary(sources.connectionFunnel),
    optimization: optimizationSummary({ daemonState: sources.daemonState, repair: sources.repair,
      connectionFunnel: sources.connectionFunnel, faults: sources.faults, errorCodes: sources.errorCodes }),
    daemonLog: daemonLogSection(sources.daemonLog, sources.daemonLogAbsence),
    faults: (sources.faults ?? []).slice(0, MAX_FAULTS).map((fault) => redactValue(fault)),
    errorCodes: [...new Set((sources.errorCodes ?? []).filter((code) => errorCodePattern.test(code)))].slice(0, MAX_ERROR_CODES),
    notes
  }
  const { body, filtered } = seal(draft)
  return trim({ ...body, filtered } as ReportBody)
}

/**
 * 最后一道闸：把整包序列化后再扫一遍凭据形状，扫出来就地抹掉。
 * 在序列化文本上抹是安全的——所有形状规则的字符集都不含引号，命中片段不可能跨越 JSON 字符串边界。
 */
export function seal(draft: Record<string, unknown>): { body: Record<string, unknown>; filtered: number } {
  const json = JSON.stringify(draft)
  const findings = credentialFindings(json)
  if (findings.length === 0) return { body: draft, filtered: 0 }
  return { body: JSON.parse(redactText(json)) as Record<string, unknown>, filtered: findings.length }
}

/** 超过上限就从最旧的日志行开始裁，再不够裁账本条目；裁了必须在包里说一句，⛔ 悄悄少一段。 */
function trim(body: ReportBody): ReportBody {
  const size = (value: ReportBody): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
  let current = body
  const noted = new Set<string>()
  const note = (text: string): void => { if (!noted.has(text)) { noted.add(text); current = { ...current, notes: [...current.notes, text] } } }
  const logLines = (value: ReportBody): readonly unknown[] => {
    const section = value.daemonLog as { available?: boolean; lines?: unknown }
    return section.available === true && Array.isArray(section.lines) ? section.lines : []
  }
  while (size(current) > REPORT_MAX_BYTES && logLines(current).length > 20) {
    const lines = logLines(current)
    note('守护日志过长，只保留了最近的部分')
    current = { ...current, daemonLog: { ...current.daemonLog, lines: lines.slice(Math.ceil(lines.length / 2)) } }
  }
  const ledgerEntries = (value: ReportBody): readonly unknown[] => {
    const entries = (value.ledger as { entries?: unknown }).entries
    return Array.isArray(entries) ? entries : []
  }
  while (size(current) > REPORT_MAX_BYTES && ledgerEntries(current).length > 5) {
    const entries = ledgerEntries(current)
    note('账本条目过多，只保留了最近的部分')
    current = { ...current, ledger: { ...current.ledger, entries: entries.slice(0, Math.ceil(entries.length / 2)) } }
  }
  return current
}

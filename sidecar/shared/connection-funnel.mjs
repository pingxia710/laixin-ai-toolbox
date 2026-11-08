// N-79 连接漏斗台账:守护每次连接尝试一条记录——触发源、各阶段名/耗时/结局、总结局。
// 只落阶段码、毫秒数与白名单受控码;⛔ 目标地址、凭据、令牌、报文一律不入(与诊断包
// 白名单口径一致)。环形保留最近 FUNNEL_LEDGER_LIMIT 条,原子落盘 connection-funnel.json。
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isNetworkPhase } from './net-phase.mjs'

export const FUNNEL_LEDGER_LIMIT = 10

/** 受控码形状:大写字母/数字/下划线/中文,≤64 字符(与诊断事件 failureCategory 同口径)。不匹配的一律不落。 */
const CODE_PATTERN = /^[A-Z0-9_\u4e00-\u9fff]{1,64}$/
const STAGE_NAME_PATTERN = /^[a-z0-9-]{1,48}$/
const TRIGGER_PATTERN = /^[a-z0-9-]{1,32}$/
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const FUNNEL_STAGE_OUTCOMES = ['ok', 'timeout', 'error']
export const FUNNEL_ATTEMPT_OUTCOMES = ['in-progress', 'connected', 'reused', 'failed', 'fatal', 'stopped', 'superseded', 'abandoned']

export function sanitizeFunnelCode(code) {
  return typeof code === 'string' && CODE_PATTERN.test(code) ? code : undefined
}

export function blankFunnelAttempt(trigger, startedAt) {
  return { trigger, startedAt, stages: [], outcome: 'in-progress', endedAt: null }
}

export function setFunnelLeg(attempt, nodeId, legRole) {
  if (!attempt || typeof attempt !== 'object') return
  if (typeof nodeId === 'string' && NODE_ID_PATTERN.test(nodeId)) attempt.nodeId = nodeId
  if (legRole === 'primary' || legRole === 'secondary') attempt.legRole = legRole
}

export function funnelStageRow(name, durationMs, outcome, code, now, phase) {
  if (!STAGE_NAME_PATTERN.test(String(name))) return undefined
  if (!FUNNEL_STAGE_OUTCOMES.includes(outcome)) return undefined
  const safeCode = sanitizeFunnelCode(code)
  return {
    name: String(name),
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    outcome,
    ...(safeCode !== undefined ? { code: safeCode } : {}),
    ...(Number.isFinite(now) ? { at: Math.round(now) } : {}),
    // N-81:失败/超时阶段的网络相位(证据制);ok 行不带。
    ...(outcome !== 'ok' && isNetworkPhase(phase) ? { phase } : {})
  }
}

/** 读回时逐行验形:任何一行不合形,整条尝试丢弃——⛔ 让被改写/损坏的文件污染诊断。 */
export function sanitizeFunnelAttempt(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  if (typeof row.trigger !== 'string' || !TRIGGER_PATTERN.test(row.trigger)) return undefined
  if (!Number.isFinite(row.startedAt)) return undefined
  if (!FUNNEL_ATTEMPT_OUTCOMES.includes(row.outcome)) return undefined
  if (row.endedAt !== null && !Number.isFinite(row.endedAt)) return undefined
  if (!Array.isArray(row.stages)) return undefined
  if (row.nodeId !== undefined && (typeof row.nodeId !== 'string' || !NODE_ID_PATTERN.test(row.nodeId))) return undefined
  if (row.legRole !== undefined && row.legRole !== 'primary' && row.legRole !== 'secondary') return undefined
  const stages = []
  for (const stage of row.stages) {
    if (stage === null || typeof stage !== 'object') return undefined
    const rebuilt = funnelStageRow(stage.name, stage.durationMs, stage.outcome, stage.code, stage.at, stage.phase)
    if (rebuilt === undefined) return undefined
    stages.push(rebuilt)
  }
  if (stages.length > 12) return undefined
  return {
    trigger: row.trigger,
    startedAt: Math.round(row.startedAt),
    stages,
    outcome: row.outcome,
    endedAt: row.endedAt === null ? null : Math.round(row.endedAt),
    ...(row.nodeId !== undefined ? { nodeId: row.nodeId } : {}),
    ...(row.legRole !== undefined ? { legRole: row.legRole } : {}),
    ...(sanitizeFunnelCode(row.code) !== undefined ? { code: sanitizeFunnelCode(row.code) } : {})
  }
}

/** 追加一条并裁到环形上限;返回新数组(纯函数,调用方负责落盘)。 */
export function appendFunnelAttempt(attempts, attempt, limit = FUNNEL_LEDGER_LIMIT) {
  const next = [...attempts, attempt]
  return next.length > limit ? next.slice(next.length - limit) : next
}

export function writeFunnelAttempts(path, attempts) {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify({ attempts })}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

/** 读回并逐条验形;文件缺失/损坏返回空数组(守护从空台账继续,⛔ 因台账问题拦连接)。 */
export function readFunnelAttempts(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  let parsed
  try { parsed = JSON.parse(text) } catch { return [] }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.attempts)) return []
  const attempts = []
  for (const row of parsed.attempts) {
    const sanitized = sanitizeFunnelAttempt(row)
    if (sanitized !== undefined) attempts.push(sanitized)
  }
  return attempts
}

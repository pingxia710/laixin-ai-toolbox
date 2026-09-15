/**
 * 套餐用量：只调官方客户端自己在用的那两个接口。
 * - 智谱 GLM Coding Plan：`/api/monitor/usage/quota/limit`（ZCode 应用包内证实在用）。
 * - Kimi Code 会员：`/coding/v1/usages`（Kimi Code CLI 二进制内证实在用）。
 * DeepSeek 官方没有套餐用量接口，它按 API 用量计费，余额走 balance.ts。
 */
import { createHash } from 'node:crypto'
import type { PlanQuota, PlanQuotaWindow, PlanUsageStatus } from '../../shared/plan-usage-types'

export type PlanQuotaSource = 'zhipu' | 'kimi'

export interface PlanQuotaResult {
  readonly source: PlanQuotaSource
  readonly quota: PlanQuota | null
  readonly status: Extract<PlanUsageStatus, 'plan' | 'key-missing' | 'key-rejected' | 'network-error' | 'invalid-reply'>
}

const endpoints: Readonly<Record<PlanQuotaSource, string>> = {
  zhipu: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  kimi: 'https://api.kimi.com/coding/v1/usages'
}

export async function readPlanQuota(source: PlanQuotaSource, key: string | undefined, fetchImpl: typeof fetch = fetch): Promise<PlanQuotaResult> {
  if (!key) return { source, quota: null, status: 'key-missing' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    return source === 'zhipu'
      ? await readZhipuQuota(key, fetchImpl, controller.signal)
      : await readKimiQuota(key, fetchImpl, controller.signal)
  } catch {
    return { source, quota: null, status: 'network-error' }
  } finally { clearTimeout(timer) }
}

/**
 * 智谱这个接口两种 Authorization 写法都在野外出现过（裸 token 与 Bearer）。
 * 先按 ZCode 自己的写法发裸 token，被拒了再补一次 Bearer，⛔ 把认证写法差异报成「Key 不对」。
 */
async function readZhipuQuota(key: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<PlanQuotaResult> {
  const plain = await callZhipu(key, fetchImpl, signal)
  return plain.status === 'key-rejected' ? callZhipu(`Bearer ${key}`, fetchImpl, signal) : plain
}

async function callZhipu(authorization: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<PlanQuotaResult> {
  const response = await fetchImpl(endpoints.zhipu, { headers: { Authorization: authorization, Accept: 'application/json' }, signal, redirect: 'error' })
  if (response.status === 401 || response.status === 403) return { source: 'zhipu', quota: null, status: 'key-rejected' }
  if (!response.ok) return { source: 'zhipu', quota: null, status: 'invalid-reply' }
  const data = await readJsonBody(response, signal)
  if (!data) return { source: 'zhipu', quota: null, status: 'invalid-reply' }
  // 2026-09-12 实测：Key 不对时它回 HTTP 200，认证失败写在 body 的 code 里。只看状态码会把「Key 被拒」错报成「格式看不懂」。
  // 上线检查又测出：**用 API Key 写错时回的是 `code:1000 / 身份验证失败。`**，不是 401——
  // 401 是 ZCode 那套 JWT 过期的形状，拿 API Key 复现不出来。只认 401 的话，本机有 ZCode 记录时
  // 错 Key 会被本机估算整个盖掉，客户看不到「Key 不对」这件事。
  const code = typeof data.code === 'number' ? data.code : null
  const message = typeof data.msg === 'string' ? data.msg : ''
  if (code === 401 || code === 403 || code === 1000 || message.includes('身份验证失败')) {
    return { source: 'zhipu', quota: null, status: 'key-rejected' }
  }
  // ZCode 自己的判法：code 不在 {0,200} 或 success===false 一律当失败。
  if ((code !== null && code !== 200 && code !== 0) || data.success === false) {
    return { source: 'zhipu', quota: null, status: 'invalid-reply' }
  }
  const quota = parseZhipu(data)
  return quota ? { source: 'zhipu', quota, status: 'plan' } : { source: 'zhipu', quota: null, status: 'invalid-reply' }
}

async function readKimiQuota(key: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<PlanQuotaResult> {
  const response = await fetchImpl(endpoints.kimi, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal, redirect: 'error' })
  if (response.status === 401 || response.status === 403) return { source: 'kimi', quota: null, status: 'key-rejected' }
  if (!response.ok) return { source: 'kimi', quota: null, status: 'invalid-reply' }
  const data = await readJsonBody(response, signal)
  const quota = data && parseKimi(data)
  return quota ? { source: 'kimi', quota, status: 'plan' } : { source: 'kimi', quota: null, status: 'invalid-reply' }
}

/**
 * 响应体解析失败是「服务商回了看不懂的东西」（网关、风控常把 JSON 换成 HTML 页），
 * ⛔ 报成「连不上服务商」——那会把客户支去查网络，查不出名堂。
 * 真被超时掐断的仍然抛出去，由外层记成网络错误。
 */
async function readJsonBody(response: Response, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    return record(await response.json())
  } catch (error) {
    if (signal.aborted) throw error
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function count(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : null
}

function percent(value: unknown): number | null {
  const number = count(value)
  return number === null ? null : Math.min(100, Math.round(number * 10) / 10)
}

function text(value: unknown, max = 60): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

/** 两家给的重置时间有秒也有毫秒，按量级判：小于 1e11 当秒。 */
function moment(value: unknown): number | null {
  const number = count(value)
  if (number === null || number <= 0) return null
  const ms = number < 100_000_000_000 ? number * 1_000 : number
  return ms <= 8_640_000_000_000 ? Math.round(ms) : null
}

function isoMoment(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function usedPercentOf(used: number | null, limit: number | null, given: number | null): number | null {
  if (given !== null) return given
  if (used === null || limit === null || limit <= 0) return null
  return Math.min(100, Math.round((used / limit) * 1_000) / 10)
}

function window(id: string, name: string, used: number | null, limit: number | null, given: number | null, resetsAt: number | null): PlanQuotaWindow {
  const usedPercent = usedPercentOf(used, limit, given)
  return { id, name, usedPercent, remainingPercent: usedPercent === null ? null : Math.round((100 - usedPercent) * 10) / 10, used, limit, resetsAt }
}

/**
 * 智谱的额度类型。2026-09-12 真 Key 实测拿到的是 `CREDIT_LIMIT`（点数），文档里没有；
 * ZCode 自己把 `TOKENS_LIMIT` 与 `CREDIT_LIMIT` 当同一类看（`new Set(['TOKENS_LIMIT','CREDIT_LIMIT'])`），这里照它。
 */
const zhipuTypeNames: Readonly<Record<string, string>> = {
  TIME_LIMIT: '按时长额度', TOKENS_LIMIT: '额度', CREDIT_LIMIT: '额度'
}

/**
 * 窗口长度写在 `unit` + `number` 里，⛔ 靠猜。
 * 依据 ZCode 自己的取数：`DF(limits,'TOKENS_LIMIT',3,5)` 配 5 小时那档、`DF(limits,'TOKENS_LIMIT',6)` 配 `resetType:'WEEK'` 那档，
 * 与官方「每 5 小时和每周」两档对得上。没实证过的 unit ⛔ 编名字，退回按类型命名。
 */
const zhipuUnits: Readonly<Record<number, string>> = { 3: '小时', 6: '周' }

function zhipuWindowName(limit: Record<string, unknown>, type: string): string | null {
  const unit = count(limit.unit)
  const span = count(limit.number)
  const name = unit === null ? undefined : zhipuUnits[unit]
  if (name === undefined) return null
  if (name === '周') return span === null || span === 1 ? '每周额度' : `${String(span)} 周额度`
  return span === null || span <= 0 ? null : `${String(span)} ${name}额度${type === 'TIME_LIMIT' ? '（时长）' : ''}`
}

/** ZCode 把套餐等级显示成 `GLM Coding Lite` 这种形状，跟着它，⛔ 把原始的 `lite` 甩给客户。 */
function zhipuLevelName(value: unknown): string | null {
  const level = text(value, 40)
  return level === null ? null : `GLM Coding ${level.charAt(0).toUpperCase()}${level.slice(1).toLowerCase()}`
}

function parseZhipu(data: Record<string, unknown>): PlanQuota | null {
  const body = record(data.data)
  const limits = body ? body.limits : undefined
  if (!Array.isArray(limits)) return null
  const seen = new Map<string, number>()
  const windows = limits.flatMap((item, index): PlanQuotaWindow[] => {
    const limit = record(item)
    const type = text(limit?.type, 40)
    if (!limit || type === null) return []
    const named = zhipuWindowName(limit, type)
    const base = named ?? zhipuTypeNames[type] ?? type
    const repeat = (seen.get(base) ?? 0) + 1
    seen.set(base, repeat)
    return [window(`${type}-${String(index)}`, repeat > 1 ? `${base} ${String(repeat)}` : base,
      count(limit.currentValue), count(limit.usage), percent(limit.percentage), moment(limit.nextResetTime))]
  })
  return windows.length === 0 ? null : { level: zhipuLevelName(body?.level), windows }
}

const kimiUnits: Readonly<Record<string, { readonly label: string; readonly minutes: number }>> = {
  TIME_UNIT_MINUTE: { label: '分钟', minutes: 1 },
  TIME_UNIT_HOUR: { label: '小时', minutes: 60 },
  TIME_UNIT_DAY: { label: '天', minutes: 1_440 },
  TIME_UNIT_WEEK: { label: '周', minutes: 10_080 }
}

/** Kimi 把 5 小时窗口写成 300 分钟，按官方客户端的做法折成小时再显示。 */
function kimiWindowName(value: unknown): string | null {
  const shape = record(value)
  const duration = count(shape?.duration)
  const unit = typeof shape?.timeUnit === 'string' ? kimiUnits[shape.timeUnit] : undefined
  if (duration === null || duration <= 0 || !unit) return null
  const minutes = duration * unit.minutes
  if (minutes % 10_080 === 0) return minutes === 10_080 ? '每周额度' : `${String(minutes / 10_080)} 周额度`
  if (minutes % 1_440 === 0) return minutes === 1_440 ? '每天额度' : `${String(minutes / 1_440)} 天额度`
  if (minutes % 60 === 0) return `${String(minutes / 60)} 小时额度`
  return `${String(minutes)} 分钟额度`
}

function kimiRow(id: string, name: string, value: unknown): PlanQuotaWindow | null {
  const detail = record(value)
  if (!detail) return null
  const limit = count(detail.limit)
  const remaining = count(detail.remaining)
  // 2026-09-12 真实返回：5 小时那档只给 limit 与 remaining、**不给 used**。
  // 算得出来就算，⛔ 在客户屏幕上写「剩余额度未知」。数字是字符串形式（"100"），count 已按字符串收。
  const used = count(detail.used) ?? (limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null)
  if (used === null && limit === null) return null
  return window(id, text(detail.name, 40) ?? name, used, limit, null, isoMoment(detail.resetTime))
}

/**
 * 会员等级在 `user.membership.level`，形如 `LEVEL_ADVANCED`。
 * Kimi Code CLI 自己不显示它，也就没有官方中文名可抄——只做去前缀这种机械转换，⛔ 编中文档位名。
 */
function kimiLevelName(data: Record<string, unknown>): string | null {
  const level = text(record(record(data.user)?.membership)?.level, 40)
  const bare = level === null ? '' : level.replace(/^LEVEL_/, '').trim()
  return bare === '' ? null : `${bare.charAt(0).toUpperCase()}${bare.slice(1).toLowerCase()}`
}

function parseKimi(data: Record<string, unknown>): PlanQuota | null {
  // 汇总行没带 window：官方客户端默认按「1 周」算，跟着它。
  const summary = kimiRow('usage', '周额度', data.usage)
  const limits = Array.isArray(data.limits) ? data.limits : []
  const rows = limits.flatMap((item, index): PlanQuotaWindow[] => {
    const entry = record(item)
    if (!entry) return []
    const row = kimiRow(`limit-${String(index)}`, kimiWindowName(entry.window) ?? `额度 ${String(index + 1)}`, entry.detail)
    return row ? [row] : []
  })
  const windows = [...(summary ? [summary] : []), ...rows]
  return windows.length === 0 ? null : { level: kimiLevelName(data), windows }
}

interface CacheEntry {
  readonly at: number
  readonly result: PlanQuotaResult
}

/**
 * 按「来源 + Key 摘要」缓存 60 秒并合并在途请求：
 * 用量页每秒重绘一次，⛔ 让每次重绘都打一次服务商。
 */
export function createPlanQuotaCache(read = readPlanQuota, now = Date.now, ttlMs = 60_000) {
  const done = new Map<string, CacheEntry>()
  const flying = new Map<string, Promise<PlanQuotaResult>>()
  return {
    read(source: PlanQuotaSource, key: string | undefined, fetchImpl?: typeof fetch): Promise<PlanQuotaResult> {
      const id = `${source}:${key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'none'}`
      const cached = done.get(id)
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.result)
      const inFlight = flying.get(id)
      if (inFlight) return inFlight
      const pending = read(source, key, fetchImpl).then((result) => {
        done.set(id, { at: now(), result })
        return result
      }).finally(() => { flying.delete(id) })
      flying.set(id, pending)
      return pending
    },
    clear(): void { done.clear() }
  }
}

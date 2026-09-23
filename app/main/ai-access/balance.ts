// 服务商余额：只查官方给了余额接口的（DeepSeek、Kimi 开放平台）；其余显示「以控制台为准」。
import type { ModelProviderId } from '../../shared/api-service-types'

export interface ProviderBalance {
  readonly provider: ModelProviderId
  readonly supported: boolean
  /** 读到的余额（服务商货币单位），未读到为 null。 */
  readonly total: number | null
  readonly currency: string
  readonly at: string
  /**
   * 判类三分(Phase 2 ③):provider_busy(429/5xx,服务商限流或故障,客户能做的等一会再刷)、
   * network_error(超时/DNS,客户能做的查本机网络)、invalid_reply(格式问题,稍后重试)——
   * ⛔ 把 429/5xx 折进 invalid_reply,让限流的客户对着「返回看不懂」无所适从。
   */
  readonly error?: 'key_missing' | 'key_rejected' | 'provider_busy' | 'network_error' | 'invalid_reply' | 'unsupported'
}

const endpoints: Partial<Record<ModelProviderId, string>> = {
  deepseek: 'https://api.deepseek.com/user/balance',
  moonshot: 'https://api.moonshot.cn/v1/users/me/balance'
}

export async function readProviderBalance(provider: ModelProviderId, key: string | undefined, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<ProviderBalance> {
  const at = now.toISOString()
  const endpoint = endpoints[provider]
  if (!endpoint) return { provider, supported: false, total: null, currency: '', at, error: 'unsupported' }
  if (!key) return { provider, supported: true, total: null, currency: '', at, error: 'key_missing' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' })
    if (response.status === 401 || response.status === 403) return { provider, supported: true, total: null, currency: '', at, error: 'key_rejected' }
    if (response.status === 429 || response.status >= 500) return { provider, supported: true, total: null, currency: '', at, error: 'provider_busy' }
    if (!response.ok) return { provider, supported: true, total: null, currency: '', at, error: 'invalid_reply' }
    const data = await readJsonBody(response, controller.signal)
    const parsed = data && (provider === 'deepseek' ? parseDeepSeek(data) : parseMoonshot(data))
    return parsed ? { provider, supported: true, total: parsed.total, currency: parsed.currency, at } : { provider, supported: true, total: null, currency: '', at, error: 'invalid_reply' }
  } catch {
    return { provider, supported: true, total: null, currency: '', at, error: 'network_error' }
  } finally { clearTimeout(timer) }
}

/**
 * 响应体解析失败是格式问题（网关/风控换成 HTML 页），⛔ 混进网络错误里报给客户。
 * 真被超时掐断的仍然抛出去，由外层记成网络错误。
 */
async function readJsonBody(response: Response, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await response.json()
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null
  } catch (error) {
    if (signal.aborted) throw error
    return null
  }
}

function money(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null
}

function parseDeepSeek(data: Record<string, unknown>): { total: number; currency: string } | null {
  const infos = data.balance_infos
  if (!Array.isArray(infos)) return null
  const cny = infos.find((info) => info && typeof info === 'object' && (info as Record<string, unknown>).currency === 'CNY') ?? infos[0]
  if (!cny || typeof cny !== 'object') return null
  const total = money((cny as Record<string, unknown>).total_balance)
  return total === null ? null : { total, currency: String((cny as Record<string, unknown>).currency ?? 'CNY') }
}

function parseMoonshot(data: Record<string, unknown>): { total: number; currency: string } | null {
  const inner = data.data
  if (!inner || typeof inner !== 'object') return null
  const total = money((inner as Record<string, unknown>).available_balance)
  return total === null ? null : { total, currency: 'CNY' }
}

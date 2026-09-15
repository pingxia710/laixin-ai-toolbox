import type { ModelProviderId as ProviderId, ModelProviderShell } from './model-providers'

export type ApiShell = ModelProviderShell
export type ModelProviderId = ProviderId
export type ApiFailure =
  | 'key_rejected' | 'key_product_mismatch' | 'balance_or_access' | 'rate_limited' | 'model_unavailable'
  | 'membership_model_unavailable' | 'membership_benefits_unavailable' | 'membership_quota_exhausted'
  | 'membership_concurrency_limited' | 'membership_rate_limited'
  | 'coding_plan_expired' | 'coding_plan_quota_exhausted' | 'coding_plan_model_unavailable' | 'coding_plan_key_product_mismatch'
  | 'request_invalid' | 'content_too_long' | 'provider_outage' | 'upstream_error' | 'network_error'
  | 'client_aborted' | 'timeout' | 'invalid_reply' | 'tool_call_failed' | 'response_truncated' | 'configuration_failed'
  | 'configuration_rollback_failed' | 'configuration_interrupted' | 'port_unavailable' | 'local_service_down' | 'local_service_busy'
  | 'not_configured' | 'key_missing' | 'shell_version_incompatible' | 'unknown'
export interface ApiCheck {
  readonly shell: ApiShell
  readonly provider: ModelProviderId
  readonly at: string
  readonly ok: boolean
  readonly code?: ApiFailure
  /** 与 code 配套的具体说明（如版本闸门给出的版本与建议）。 */
  readonly notice?: string
  /** 同一把 Key 已由主进程复验可用于的姐妹产品；不含 Key 或上游原文。 */
  readonly suggestedProvider?: ModelProviderId
}
export type ApiLatency = { readonly ok: true; readonly latencyMs: number } | { readonly ok: false; readonly latencyMs: null; readonly code: ApiFailure }
export interface ApiRequestRecord {
  readonly at: string
  readonly shell: ApiShell
  readonly provider: ModelProviderId
  readonly model: string
  readonly source: 'test' | 'client'
  readonly ok: boolean
  readonly code?: ApiFailure
  readonly status: number
  readonly durationMs: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}
/**
 * 这个壳的配置此刻是不是还是工具箱写的那份。
 * `not-managed` 用官方或没配过 · `ok` 没被动过 · `modified-externally` 被别的工具改了
 * · `missing` 托管段没了 · `unknown` 这次读不出来。**⛔ 自动覆盖客户的改动。**
 */
export type ConfigurationState = 'not-managed' | 'ok' | 'modified-externally' | 'missing' | 'unknown'
export const configurationMessages: Readonly<Record<ConfigurationState, string>> = {
  'not-managed': '这个 AI 没有使用工具箱的模型 API，无需核对。',
  ok: '配置仍是工具箱写的那份。',
  'modified-externally': '这个 AI 的配置被工具箱以外的程序改过了。工具箱不会自动覆盖你的改动；要回到工具箱的接入，请重新写入配置。',
  missing: '这个 AI 里工具箱写的那段配置不见了。要恢复接入，请重新写入配置。',
  unknown: '这次没能读出这个 AI 的配置，无法判断是否被改动。'
}

/** 重开 / 唤醒 / 断网恢复后的接入核对结果。 */
export interface AccessRecovery {
  readonly reason: 'startup' | 'wake' | 'periodic' | 'manual'
  readonly at: string
  /** `ok` 本来就好 · `repaired` 本次修好了 · `still_failing` 没修好 · `not-managed` 没在用模型 API。 */
  readonly outcome: 'ok' | 'repaired' | 'still_failing' | 'not-managed'
  readonly code?: ApiFailure
  readonly message: string
  /** 端口被占换号后，配置被回写过的壳。 */
  readonly rewroteShells?: readonly ApiShell[]
  readonly configurations: Readonly<Record<ApiShell, ConfigurationState>>
}

/** 「配置写了」与「软件真的在走这条路」是三件事，分开记时间，判不出就是 null。 */
export interface ApiUsageStage {
  readonly shell: ApiShell
  /** 当前选的服务商；选了官方或没选时为 null。 */
  readonly provider: ModelProviderId | null
  /** 最近一次探测（回复 + 工具调用 + 流式）通过的时间。 */
  readonly tested: string | null
  /** 配置写入并回读通过的时间。 */
  readonly configured: string | null
  /** 首次观察到这个 AI 自己发出的请求成功的时间；重开工具箱或换渠道后归零。 */
  readonly observedClientCall: string | null
  /**
   * Codex CLI 与 Codex Desktop 走同一份配置，普通客户端调用不能证明桌面版真的命中本机网关。
   * 此字段只在 Codex 当前受工具箱接管时给出；它从本机进程与同一 TCP socket 的核对产生，
   * 不接受 User-Agent、时间窗口或人工声明。
   */
  readonly codexDesktopRoute?: CodexDesktopRouteVerification
  /** 最近一次核对时，这个壳的配置是不是还是工具箱写的那份。 */
  readonly configuration: ConfigurationState
}

export type CodexDesktopRouteReason =
  | 'verified_socket_bound_desktop'
  | 'awaiting_desktop_request'
  | 'incomplete_answer'
  | 'platform_unsupported'
  | 'socket_metadata_unavailable'
  | 'socket_owner_not_found'
  | 'socket_owner_ambiguous'
  | 'socket_owner_not_codex_desktop'
  | 'desktop_signature_unverified'
  | 'socket_binding_unavailable'

/** A deliberately small proof result. Process details, local paths, socket tuples and request data never leave main. */
export interface CodexDesktopRouteVerification {
  readonly status: 'verified' | 'unverified'
  readonly at: string | null
  readonly reason: CodexDesktopRouteReason
}
export interface ApiServiceSnapshot {
  readonly running: boolean
  readonly baseUrl: string | null
  readonly startupError?: ApiFailure
  readonly startedAt: string | null
  readonly requests: readonly ApiRequestRecord[]
  readonly checks: readonly ApiCheck[]
  readonly usage: readonly ApiUsageStage[]
  readonly routes: readonly { shell: ApiShell; provider: ModelProviderId; model: string; baseUrl: string; upstream: string }[]
}
export const apiFailureMessages: Record<ApiFailure, string> = {
  key_rejected: 'Key 未通过认证，请确认复制完整，并来自当前入口。',
  key_product_mismatch: '这把 Key 不能用于当前产品入口。请确认 Key 来自对应产品的官方控制台，不能与姐妹产品混用。',
  balance_or_access: '服务商拒绝访问，请检查余额、会员权益或模型权限。',
  rate_limited: '服务商限流或额度暂不可用，请稍后重试。',
  model_unavailable: '当前 Key 无权使用配置的模型，或服务商尚未开放此接口。',
  membership_model_unavailable: 'Kimi Code 会员套餐不包含当前模型、上下文长度或高速档位。请改用套餐可用模型，或升级套餐后再试。',
  membership_benefits_unavailable: 'Kimi Code 暂时无法核验会员权益。请确认会员仍有效，稍后重试；持续失败可在 Kimi Code 控制台联系支持。',
  membership_quota_exhausted: 'Kimi Code 的当前会员额度已用完。请等待额度窗口重置，或在会员页购买额外额度、升级套餐。',
  membership_concurrency_limited: 'Kimi Code 当前账号的并发请求已达上限。请等待正在进行的请求结束后再试。',
  membership_rate_limited: 'Kimi Code 当前请求过多或推理服务繁忙。请稍候重试，避免连续快速发送请求。',
  coding_plan_expired: 'GLM Coding Plan 套餐已到期。请在智谱官方页面续订后再试。',
  coding_plan_quota_exhausted: 'GLM Coding Plan 的周或月套餐额度已用完。请等待重置时间，或在官方套餐页处理。',
  coding_plan_model_unavailable: '当前 GLM Coding Plan 套餐未开放这个模型。请换用套餐可用模型或调整套餐。',
  coding_plan_key_product_mismatch: '这个 Key 仅限企业编程套餐场景，不能用于当前产品。请在智谱官方页面确认并更换对应产品的 Key。',
  request_invalid: '服务商不接受这次请求的格式或参数，多半是这个 AI 的版本与当前接口不匹配，可先重新写入配置，再考虑更新软件。',
  content_too_long: '这次发送的内容超过了模型能接收的长度，请新开一个对话或减少内容后重试。',
  provider_outage: '服务商一侧连续返回异常或长时间没有回复，多半是对方暂时故障，请稍后重试。',
  upstream_error: '服务商返回异常，请稍后重试。',
  network_error: '未连接到服务商，请检查网络后重试。',
  client_aborted: '这次请求在收到回复前被取消了，多半是在 AI 里按了停止或关掉了窗口。',
  timeout: '等待服务商回复超时，请重试。',
  invalid_reply: '接口没有返回有效模型回复，不能算接入成功。',
  response_truncated: '回答太长，被模型的输出上限截断了（不是服务商故障）。请在 AI 里重新提问、缩小问题范围，或让模型分段输出；不需要改工具箱的配置。',
  tool_call_failed: '模型的工具调用检查未通过，暂不启用到 AI。',
  configuration_failed: '本机配置未完成或无法读取。请检查安装状态、磁盘权限或被手动修改的配置。',
  configuration_rollback_failed: '配置保存和恢复均未完成，此 AI 的 API 路由已暂停。请检查磁盘与文件权限，再重新启用或恢复官方。',
  configuration_interrupted: '有 AI 的上次配置未完成，对应路由保持暂停。请检查磁盘与文件权限，再重新启用该 AI 或恢复官方。',
  port_unavailable: '本机 API 服务端口被占用，请关闭占用程序后重试。',
  local_service_down: '工具箱的本机 API 服务没有在运行，AI 现在连不上，请重启本机 API 服务。',
  local_service_busy: '工具箱本机同时处理的请求较多，请稍候重试',
  not_configured: '尚未启用本机 API 路由，请先在模型 API 中启用。',
  key_missing: '请先添加这个入口对应的 Key。',
  shell_version_incompatible: '这个 AI 当前安装的版本与第三方模型接口不兼容，暂不启用。',
  unknown: '这次没能判断出失败原因，请重试一次；仍然失败就把诊断结果复制给客服。'
}

/** 同一失败码在少数服务商有可操作的补充说明；未明确的服务商不套用别家的规则。 */
export function apiFailureMessage(code: ApiFailure, provider?: ModelProviderId): string {
  if (code === 'key_product_mismatch' && provider === 'kimi') {
    return '这把 Key 不能用于 Kimi Code 会员入口。Kimi Code 会员 Key 与 Kimi 开放平台 API Key 不能混用；请改用 Kimi Code 控制台创建的 Key，或切换到 Kimi 开放平台 API。'
  }
  if (code === 'key_product_mismatch' && provider === 'moonshot') {
    return '这把 Key 不能用于 Kimi 开放平台 API。Kimi 开放平台 API Key 与 Kimi Code 会员 Key 不能混用；请改用开放平台控制台创建的 Key，或切换到 Kimi Code。'
  }
  if (code === 'rate_limited' && provider === 'deepseek') {
    return 'DeepSeek 请求过于频繁或并发已到上限，请稍后重试。限额按账号计算，增加同账号的 Key 不会提高并发；可在 DeepSeek 开放平台提交扩容工单，不额外收费。'
  }
  return apiFailureMessages[code]
}

const recoveryAbsoluteFields = ['reset_at', 'resetAt', 'next_reset_at', 'nextResetAt', 'quota_reset_at', 'quotaResetAt', 'retry_at', 'retryAt', 'available_at', 'availableAt', 'next_flush_time', 'nextFlushTime'] as const
const recoveryDelayFields = ['retry_after', 'retryAfter', 'retry_after_seconds', 'retryAfterSeconds'] as const
const recoveryDelayMsFields = ['retry_after_ms', 'retryAfterMs'] as const
const maximumRecoveryDelayMs = 31 * 24 * 60 * 60 * 1_000
const maximumRecoveryDateMs = 366 * 24 * 60 * 60 * 1_000

/**
 * 从上游的受控重置字段生成一句可给客户看的恢复提示。
 *
 * 只认固定字段名里的 ISO / epoch / 秒数，以及明确写出的套餐窗口；原始错误文字、Key 和任意
 * 业务字段都不会进入返回值。`now` 仅为回归测试注入时间，产品调用不传它。
 */
export function providerRecoveryNotice(status: number, body: string, code: ApiFailure, provider?: ModelProviderId, retryAfter?: string | null, now = Date.now()): string | undefined {
  if (!mayHaveRecoveryNotice(status, code)) return undefined
  const resetAt = recoveryResetAt(body, retryAfter, now)
  if (resetAt !== undefined) return `服务商预计于 ${formatChinaTime(resetAt)}恢复`
  const fields = failureFields(body)
  const window = namedRecoveryWindow(code, provider, fields)
  if (window !== undefined) return window
  return '服务商未给出可核验的恢复时间，请稍后重试'
}

function mayHaveRecoveryNotice(status: number, code: ApiFailure): boolean {
  return status === 429 || status === 529 || [
    'balance_or_access', 'rate_limited', 'membership_benefits_unavailable', 'membership_quota_exhausted',
    'membership_concurrency_limited', 'membership_rate_limited', 'coding_plan_quota_exhausted'
  ].includes(code)
}

/** 固定信封内的固定字段即可；不遍历任意嵌套错误对象。 */
function recoveryEnvelopes(body: string): readonly Record<string, unknown>[] {
  const text = body.slice(0, 4096)
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const root = value as Record<string, unknown>
    const envelopes: Record<string, unknown>[] = [root]
    for (const key of ['error', 'data', 'meta', 'metadata', 'details']) {
      const nested = root[key]
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) envelopes.push(nested as Record<string, unknown>)
    }
    return envelopes
  } catch { return [] }
}

function recoveryResetAt(body: string, retryAfter: string | null | undefined, now: number): number | undefined {
  const envelopes = recoveryEnvelopes(body)
  for (const envelope of envelopes) {
    for (const field of recoveryAbsoluteFields) {
      const at = absoluteRecoveryTime(envelope[field], now)
      if (at !== undefined) return at
    }
    for (const field of recoveryDelayFields) {
      const at = relativeRecoveryTime(envelope[field], 1_000, now)
      if (at !== undefined) return at
    }
    for (const field of recoveryDelayMsFields) {
      const at = relativeRecoveryTime(envelope[field], 1, now)
      if (at !== undefined) return at
    }
  }
  return relativeRecoveryTime(retryAfter, 1_000, now)
}

function absoluteRecoveryTime(value: unknown, now: number): number | undefined {
  let at: number | undefined
  if (typeof value === 'number' && Number.isFinite(value)) at = value >= 1_000_000_000_000 ? value : value >= 1_000_000_000 ? value * 1_000 : undefined
  if (typeof value === 'string') {
    if (/^\d{10}$/.test(value)) at = Number(value) * 1_000
    else if (/^\d{13}$/.test(value)) at = Number(value)
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) at = Date.parse(value)
  }
  return at !== undefined && Number.isFinite(at) && at >= now - 60_000 && at <= now + maximumRecoveryDateMs ? at : undefined
}

function relativeRecoveryTime(value: unknown, multiplier: number, now: number): number | undefined {
  const amount = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,8}$/.test(value) ? Number(value) : undefined
  if (amount === undefined || !Number.isSafeInteger(amount) || amount < 1) return undefined
  const delay = amount * multiplier
  return delay <= maximumRecoveryDelayMs ? now + delay : undefined
}

function namedRecoveryWindow(code: ApiFailure, provider: ModelProviderId | undefined, fields: string): string | undefined {
  if (provider === 'kimi' && ['membership_quota_exhausted', 'membership_rate_limited', 'rate_limited'].includes(code)) {
    if (/(?:\b5\s*(?:-| )?hours?\b|5\s*小时)/i.test(fields)) return 'Kimi Code 当前 5 小时额度窗口已用完，窗口重置后可继续使用'
    if (/(?:\bweekly\b|每周|周(?:度)?(?:使用)?(?:上限|额度))/i.test(fields)) return 'Kimi Code 当前周额度窗口已用完，请等待套餐周额度重置'
    if (/(?:\bmonthly\b|每月|月(?:度)?(?:使用)?(?:上限|额度))/i.test(fields)) return 'Kimi Code 当前月额度窗口已用完，请等待套餐月额度重置'
  }
  if (code === 'coding_plan_quota_exhausted' && provider === 'zhipu') {
    if (/(?:\bweekly\b|每周|周(?:度)?(?:使用)?(?:上限|额度))/i.test(fields)) return 'GLM Coding Plan 当前周额度窗口已用完，请等待套餐周额度重置'
    if (/(?:\bmonthly\b|每月|月(?:度)?(?:使用)?(?:上限|额度))/i.test(fields)) return 'GLM Coding Plan 当前月额度窗口已用完，请等待套餐月额度重置'
  }
  return undefined
}

function formatChinaTime(at: number): string {
  const china = new Date(at + 8 * 60 * 60 * 1_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())} ${pad(china.getUTCHours())}:${pad(china.getUTCMinutes())}（中国标准时间）`
}

/** 客户点得到的处理动作；每个动作做完都要复验，⛔ 把「命令执行完」当修好。 */
export type ApiRemedyAction = 'retest' | 'reapply' | 'restartGateway' | 'useOfficial' | 'openConsole'
export type ApiRemedyOutcome = 'recovered' | 'still_failing' | 'unknown'
export const apiRemedyActions: readonly ApiRemedyAction[] = ['retest', 'reapply', 'restartGateway', 'useOfficial', 'openConsole']
export const apiRemedyLabels: Readonly<Record<ApiRemedyAction, string>> = {
  retest: '重新测试', reapply: '重新写入配置', restartGateway: '重启本机 API 服务', useOfficial: '恢复官方配置', openConsole: '打开官方控制台'
}
export interface ApiRemedyResult {
  readonly shell: ApiShell
  readonly provider: ModelProviderId | null
  readonly action: ApiRemedyAction
  readonly at: string
  readonly outcome: ApiRemedyOutcome
  /** 复验后的判类；已恢复时不带。 */
  readonly code?: ApiFailure
  /** 客户看得懂的一句话。 */
  readonly message: string
  /** 还没好时建议的下一个动作；没有可自动执行的动作时不带。 */
  readonly next?: ApiRemedyAction
}

/** 每个失败类的默认建议动作；null = 没有能自动执行的动作，只能按文案自己处理。 */
export const apiFailureRemedy: Readonly<Record<ApiFailure, ApiRemedyAction | null>> = {
  key_rejected: 'openConsole',
  key_product_mismatch: 'openConsole',
  balance_or_access: 'openConsole',
  rate_limited: 'retest',
  model_unavailable: 'openConsole',
  membership_model_unavailable: 'openConsole',
  membership_benefits_unavailable: 'retest',
  membership_quota_exhausted: 'openConsole',
  membership_concurrency_limited: 'retest',
  membership_rate_limited: 'retest',
  coding_plan_expired: 'openConsole',
  coding_plan_quota_exhausted: 'openConsole',
  coding_plan_model_unavailable: 'openConsole',
  coding_plan_key_product_mismatch: 'openConsole',
  request_invalid: 'reapply',
  content_too_long: null,
  provider_outage: 'retest',
  upstream_error: 'retest',
  network_error: null,
  // 客户自己停下的，没有要处理的事。
  client_aborted: null,
  timeout: 'retest',
  invalid_reply: 'retest',
  response_truncated: 'retest',
  tool_call_failed: 'retest',
  configuration_failed: 'reapply',
  configuration_rollback_failed: 'useOfficial',
  configuration_interrupted: 'reapply',
  port_unavailable: 'restartGateway',
  local_service_down: 'restartGateway',
  local_service_busy: 'retest',
  not_configured: 'reapply',
  key_missing: 'openConsole',
  shell_version_incompatible: 'useOfficial',
  unknown: 'retest'
}

/**
 * 上游错误体里的类型/代码/文案关键字。只读出一个判类，原文 ⛔ 进记录、界面或客服摘要。
 * 覆盖两套兼容协议的既有命名：Anthropic 的 error.type（invalid_request_error / authentication_error /
 * permission_error / not_found_error / request_too_large / rate_limit_error / api_error / overloaded_error）
 * 与 OpenAI 式 error.code（context_length_exceeded / model_not_found / invalid_api_key / insufficient_quota /
 * rate_limit_exceeded），外加 DeepSeek 文档写明的「Insufficient Balance」「Model Not Exist」。
 */
const failureHints: readonly (readonly [RegExp, ApiFailure])[] = [
  [/context[_ -]?length|maximum context|request_too_large|string_above_max_length|payload too large|too many tokens/i, 'content_too_long'],
  [/model[_ ]?not[_ ]?found|model not exist|model\b.{0,60}does not exist|not_found_error|unsupported[_ ]model|unknown[_ ]model/i, 'model_unavailable'],
  [/invalid[_ ]?api[_ ]?key|incorrect api key|authentication_error|invalid authentication|api[_ ]?key\b.{0,30}(invalid|expired|revoked|does not exist|not found)/i, 'key_rejected'],
  [/insufficient|balance|quota|permission_error|no permission|not authorized|arrearage/i, 'balance_or_access'],
  [/rate[_ ]?limit|too many requests|concurrency/i, 'rate_limited'],
  [/overloaded_error|api_error|service unavailable|server is busy|internal server error/i, 'provider_outage'],
  [/invalid_request_error|invalid[_ ]parameter|missing required|failed to deserialize|malformed/i, 'request_invalid']
]

function failureFields(body: string): string {
  const text = body.slice(0, 4096)
  if (!text.trim()) return ''
  let fields = text
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      const top = parsed as Record<string, unknown>
      const error = top.error && typeof top.error === 'object' ? top.error as Record<string, unknown> : top
      fields = [typeof top.error === 'string' ? top.error : undefined, error.type, error.code, error.message, top.code, top.msg, top.message]
        .filter((value) => typeof value === 'string' || typeof value === 'number').join(' ')
      if (!fields.trim()) fields = text
    }
  } catch { /* 非 JSON（网关 HTML 错误页等）就按原文匹配关键字，同样只取判类。 */ }
  return fields
}

function failureHint(body: string): ApiFailure | undefined {
  const fields = failureFields(body)
  return failureHints.find(([pattern]) => pattern.test(fields))?.[1]
}

/** 智谱把套餐状态放在 JSON 业务码里；只读数字，不保留上游原文。 */
function businessCode(body: string): string | undefined {
  const text = body.slice(0, 4096)
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      const top = parsed as Record<string, unknown>
      const error = top.error && typeof top.error === 'object' ? top.error as Record<string, unknown> : undefined
      for (const value of [error?.code, top.code]) {
        if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
        if (typeof value === 'string' && /^[0-9]{4,5}$/.test(value)) return value
      }
    }
  } catch { /* 有些兼容层把业务码包进普通文本；下方仅认已知的四个套餐码。 */ }
  return /(?:\[|\b)(1309|1310|1311|1315)(?:\]|\b)/.exec(text)?.[1]
}

function productFailure(status: number, body: string, provider: ModelProviderId | undefined): ApiFailure | undefined {
  if (provider === 'zhipu') {
    switch (businessCode(body)) {
      case '1309': return 'coding_plan_expired'
      case '1310': return 'coding_plan_quota_exhausted'
      case '1311': return 'coding_plan_model_unavailable'
      case '1315': return 'coding_plan_key_product_mismatch'
    }
  }
  if ((provider === 'kimi' || provider === 'moonshot') && status === 200) {
    // Some compatibility layers put an authentication error in a successful HTTP envelope. The
    // shared invalid_token/product_mismatch spelling still cannot prove which sister issued the
    // Key, so the service may only upgrade this after the sister endpoint accepts it.
    const fields = failureFields(body)
    if (/(?:invalid|expired)[_. -]?(?:token|credential)|(?:api[_ -]?)?key[_ -]?product[_ -]?mismatch|product[_ -]?mismatch/i.test(fields)) {
      return 'key_rejected'
    }
  }
  if (provider !== 'kimi') return undefined
  const fields = failureFields(body)
  // 部分兼容层会用 HTTP 200 包 Kimi Code 的业务失败。只认明确的套餐/并发/限流措辞，
  // ⛔ 把模糊的 quota 一概猜成套餐额度耗尽。
  if (status === 200) {
    if (/(?:\b5\s*(?:-| )?hours?\s+usage\s+limit\b|\b(?:weekly|monthly)\s+usage\s+limit\b|\b(?:usage|quota)[_. -]?(?:limit|exhausted|exceeded)\b|5\s*小时(?:使用)?(?:上限|额度)|(?:每周|每月)(?:使用)?(?:上限|额度))/i.test(fields)) return 'membership_quota_exhausted'
    if (/concurrent request limit|concurrency/i.test(fields)) return 'membership_concurrency_limited'
    if (/rate[_ ]?limit|too many requests|engine is currently overloaded/i.test(fields)) return 'membership_rate_limited'
  }
  if (status === 401 && /model id does not exist.*recognized as other/i.test(fields)) return 'request_invalid'
  if (status === 401 && /current subscription does not have access|current plan supports only|subscription tier|highspeed.*access/i.test(fields)) {
    return 'membership_model_unavailable'
  }
  if (status === 402) return 'membership_benefits_unavailable'
  if (status === 403) return /concurrent request limit|concurrency/i.test(fields) ? 'membership_concurrency_limited' : 'membership_quota_exhausted'
  if (status === 429) return 'membership_rate_limited'
  return undefined
}

/**
 * 按状态码 + 上游错误体判类。DeepSeek 官方表：400 请求格式错、401 认证失败、402 余额不足、
 * 422 参数错误、429 速率上限、500 服务器故障、503 服务器繁忙；400 与 404 ⛔ 再一起当「模型不可用」。
 */
export function classifyProviderFailure(status: number, body = '', provider?: ModelProviderId): ApiFailure {
  const product = productFailure(status, body, provider)
  if (product !== undefined) return product
  const hint = failureHint(body)
  switch (status) {
    case 401: return 'key_rejected'
    case 402: return 'balance_or_access'
    case 403: return hint === 'key_rejected' ? 'key_rejected' : 'balance_or_access'
    case 404: return 'model_unavailable'
    case 408: return 'timeout'
    case 413: return 'content_too_long'
    case 429: return hint === 'balance_or_access' ? 'balance_or_access' : 'rate_limited'
    case 400:
    case 422: return hint ?? 'request_invalid'
    default:
      if (status >= 500 && status <= 599) return 'provider_outage'
      return hint ?? 'unknown'
  }
}

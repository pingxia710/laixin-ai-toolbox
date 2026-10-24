// 上报过滤闸：客户点「上报」的那一刻，这里决定什么能离开他的电脑。
//
// 三层，⛔ 只留一层：
//  ① 打包侧**按字段白名单取值**（report-bundle.ts）——凭据字段压根不进包；
//  ② 这里按**字段名**与**取值形状**再抹一遍——白名单漏了、上游多塞了字段，也带不出去；
//  ③ 上传前整包**再扫一次**（credentialFindings）——扫出来还有凭据形状就地抹掉并计数。
// 一层也不能省：白名单会被后来的人加字段绕过，形状匹配抓不住 shortId 这种短值，
// 只有三层叠起来才是「凭据一个都出不去」。
//
// 形状判据全部取自本仓真实定义，⛔ 凭印象写：
//  - VLESS uuid / publicKey(43 位 base64url) / shortId(2–16 位十六进制) → sidecar/*/vless-settings.mjs
//  - 来信账号令牌 43 位 base64url                                      → app/main/account/client.ts validSession
//  - 守护会话令牌 sess-<base36>-<8 位十六进制>                          → sidecar/*/ledger.mjs generateSessionToken
//  - 模型 Key sk-…                                                    → 各家开放平台

export const REDACTED = '[已移除]'

/** 字段名里带这些词的，值一律不出去。⛔ 用「看着像不像敏感」临时判断——名单在这里，改它要连用例一起改。 */
const sensitiveKeyParts: readonly string[] = [
  'token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'cookie',
  'authorization', 'bearer', 'signature', 'key', 'shortid', 'uuid', 'session',
  'originalvalue', 'writtenvalue'
]

export function sensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase()
  return sensitiveKeyParts.some((part) => lowered.includes(part))
}

interface CredentialRule {
  readonly name: string
  readonly pattern: RegExp
  /** 命中但确定不是凭据时留着（如全大写下划线的错误码）。 */
  readonly keep?: (match: string) => boolean
}

// 每条规则都带 g，用前一律重置 lastIndex——共享的正则带状态，⛔ 直接复用。
const rules: readonly CredentialRule[] = [
  // 带账号密码的地址：vless:// ss:// trojan:// socks5:// 以及任何 user:pass@host
  { name: 'uri-userinfo', pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*@[^\s"'<>]*/g },
  // VLESS 的 uuid（Xray 里的用户 id）
  { name: 'uuid', pattern: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g },
  // 各家模型 Key
  { name: 'api-key', pattern: /sk-[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi },
  // 守护会话令牌
  { name: 'session-token', pattern: /sess-[0-9a-z]{4,}-[0-9a-f]{8}/g },
  // 32 位以上十六进制：主机指纹、裸密钥。前后有 _ 或字母数字的不算，
  // 于是 acct_<32位>、device_<32位> 这类客服要用来对人的编号留得住。
  { name: 'hex', pattern: /(?<![0-9A-Za-z_-])[0-9a-fA-F]{32,}(?![0-9A-Za-z_-])/g },
  // 40 位以上 base64url：来信账号令牌与 VLESS 公钥都是 43 位。
  // 全大写下划线的是错误码（客服要看的就是它），留着。
  { name: 'base64url', pattern: /(?<![0-9A-Za-z_-])[A-Za-z0-9_-]{40,}(?![0-9A-Za-z_-])/g,
    keep: (match) => /^[A-Z0-9_]+$/.test(match) }
]

/** 扫出文本里所有像凭据的片段。上传前的最后一道闸与用例都用它，⛔ 各写一套判据。 */
export function credentialFindings(text: string): readonly string[] {
  const found: string[] = []
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.keep?.(match[0])) continue
      found.push(match[0])
    }
  }
  return found
}

/** 把文本里的凭据形状就地抹掉。 */
export function redactText(text: string): string {
  let output = text
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    output = output.replace(rule.pattern, (match) => rule.keep?.(match) ? match : REDACTED)
  }
  return output
}

export interface RedactLimits {
  readonly maxDepth?: number
  readonly maxStringLength?: number
  readonly maxArrayLength?: number
  readonly maxKeys?: number
}

const defaults = { maxDepth: 8, maxStringLength: 2_000, maxArrayLength: 200, maxKeys: 80 } as const

/**
 * 深度清洗任意取值：敏感字段名整枝砍掉（⛔ 往下递归，免得换个壳又出去），
 * 字符串过形状闸并截断，超出深度/条数的部分丢弃。函数、Symbol 一类直接不要。
 */
export function redactValue(value: unknown, limits: RedactLimits = {}, depth = 0): unknown {
  const { maxDepth, maxStringLength, maxArrayLength, maxKeys } = { ...defaults, ...limits }
  if (depth > maxDepth) return '[已省略：层级过深]'
  if (value === null) return null
  if (typeof value === 'string') {
    const redacted = redactText(value)
    return redacted.length > maxStringLength ? `${redacted.slice(0, maxStringLength)}…[已截断]` : redacted
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, maxArrayLength).map((item) => redactValue(item, limits, depth + 1))
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, maxKeys)) {
      // 原型链上的键不进包（可序列化规则要堵原型链）。
      if (!Object.hasOwn(value as object, key)) continue
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      output[key] = sensitiveKey(key) ? REDACTED : redactValue(item, limits, depth + 1)
    }
    return output
  }
  return undefined
}

/** 只保留白名单里的字段，再逐个清洗。打包侧取值一律走这里，⛔ 整个对象直接塞进去。 */
export function pickRedacted(source: unknown, allowed: readonly string[], limits?: RedactLimits): Record<string, unknown> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const record = source as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) continue
    if (sensitiveKey(key)) continue
    const value = redactValue(record[key], limits)
    if (value !== undefined) output[key] = value
  }
  return output
}

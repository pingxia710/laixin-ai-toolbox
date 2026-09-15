// 网关按供应商改写请求：三款软件（Codex / Claude Code / Hermes）发出的请求，在打到国产接口之前
// 按「供应商 × 协议」改成对方认得的形状。同类工具（Claude Code Router 的 transformer、CLIProxyAPI 的
// payload 规则）都有这一层，我们的网关此前只是透传，客户看到的是「软件版本不兼容，请重新写入配置」——
// 怎么点都修不好，因为要改的根本不是配置。
//
// 三条硬规矩：
// 1. 纯函数、无 I/O、⛔ 记录任何请求内容——这条路上跑的是客户的对话正文。
// 2. 规则可序列化、词汇封闭（四种匹配 + 五种操作 + 受限路径语法），将来由签名配方下发，⛔ 任意表达式。
// 3. ⛔ 动 model / authorization / x-api-key；未命中任何规则时返回**原对象引用**，⛔ 复制（网关热路径）。
import type { ApiShell } from '../../shared/api-service-types'

export type Json = Record<string, unknown>

/** 协议由壳决定，⛔ 由客户端 URL 或请求体猜。 */
export const protocolForShell: Readonly<Record<ApiShell, RewriteProtocol>> = { codex: 'responses', claude: 'messages', hermes: 'chat' }
export type RewriteProtocol = 'chat' | 'messages' | 'responses'

/**
 * 路径语法（封闭，⛔ 表达式）：点号分段，段名后可跟选择器。
 * - `[]` 数组每一项 · `[0]` / `[-1]` 下标（负数从尾部数）
 * - `[role=system]` 字段等于字面量 · `[tool_calls]` 字段存在且非 null
 * 同一段上的多个选择器顺序叠加（`messages[role=assistant][tool_calls]` = 带 tool_calls 的 assistant 消息）。
 * **末段 ⛔ 带选择器**——操作永远落在「某个对象的某个键」上，不做数组增删。
 */
export type RewritePath = string

export type RewriteOpKind = 'set' | 'delete' | 'default' | 'rename' | 'append'

export interface RewriteOp {
  readonly op: RewriteOpKind
  /** 改请求体还是改请求头；缺省为 body。请求头路径只能是单段小写头名。 */
  readonly target?: 'body' | 'headers'
  readonly path: RewritePath
  /** set / default / append 的字面量值；append 只接受字符串。 */
  readonly value?: unknown
  /** rename 的新键名（单个键名，⛔ 路径）。 */
  readonly to?: string
}

export interface RewriteWhen {
  /** 这些路径上至少有一处有值。 */
  readonly exists?: readonly RewritePath[]
  /** 这些路径上一处值都没有。 */
  readonly missing?: readonly RewritePath[]
  /** 路径上至少有一处的值等于字面量。 */
  readonly equals?: readonly (readonly [RewritePath, unknown])[]
  /** 路径下所有字符串叶子都不含这段文字（不分大小写）；一处都没有也算成立。 */
  readonly noneContains?: readonly (readonly [RewritePath, string])[]
}

export interface RewriteRule {
  readonly id: string
  /** 服务商 id，`*` 表示全部。 */
  readonly provider: string
  readonly protocol: RewriteProtocol | '*'
  /** 限定模型（精确匹配本次路由的模型名）；缺省为全部模型。厂商按模型的差异（thinking 之类）用它。 */
  readonly models?: readonly string[]
  readonly when?: RewriteWhen
  readonly ops: readonly RewriteOp[]
}

export interface RewriteInput {
  readonly shell: ApiShell
  readonly provider: string
  readonly model: string
  readonly body: Json
  readonly headers: Record<string, string>
}

export interface RewriteResult {
  readonly body: Json
  readonly headers: Record<string, string>
  /** 真正改动了东西的规则 id；只命中不改动的 ⛔ 记。 */
  readonly applied: readonly string[]
}

/** ⛔ 让规则碰这些：模型由路由决定，鉴权由网关自己加。 */
const protectedBodyKeys = new Set(['model'])
const protectedHeaders = new Set(['authorization', 'x-api-key', 'proxy-authorization'])
/**
 * 原型污染：`{ op: 'set', path: '__proto__.polluted' }` 这种规则如果放过去，写的是 Object.prototype，
 * 整个进程里每个对象都会多出这个属性。配方虽然要签名，但**签名管的是来源、不是内容**，
 * 一份被写坏的配方不该能改掉运行时。所以这三个名字在路径段、选择器字段名、rename 目标、
 * 请求头名、字面量值的键名上一律不认；取值一律走 Object.hasOwn，⛔ 落到原型链上。
 */
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
/** 只取自有属性：`{}` 上的 toString / constructor ⛔ 被当成「这个字段存在」。 */
function own(container: Json, key: string): unknown { return Object.hasOwn(container, key) ? container[key] : undefined }

// ── 内置规则 ───────────────────────────────────────────────────────────────
// 每条都带 2026-09-13 用真实 Key 对三家三协议逐字段探测的结果（见 docs/provider-capabilities.md）。
// 探测结论：今天只有 DeepSeek 的 chat 协议有两处会 400，其余三家 × 三协议（含未知字段、beta 头）全通。
export const builtinRewriteRules: readonly RewriteRule[] = [
  // R1 证据：DeepSeek chat + response_format.type=json_schema → 400
  // 「This response_format type is unavailable now」；换成 json_object 同一请求通过。
  // 客户可见症状：Hermes 每开一次会话固定报一条 400（起标题用的就是 json_schema）。
  {
    id: 'deepseek.chat.json-schema-to-json-object',
    provider: 'deepseek', protocol: 'chat',
    when: { equals: [['response_format.type', 'json_schema']] },
    ops: [{ op: 'set', path: 'response_format', value: { type: 'json_object' } }]
  },
  // R1 后半 证据：只降级还不够。DeepSeek 对「json_object + 提示词里没有 json 字样」同样回 400：
  // 「Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'.」
  // Hermes 起标题的系统提示正好没有这个词——所以这条规则是把那次 400 变成 200 的另一半，⛔ 可选项。
  // 原本就发 json_object 的请求同样适用。首条 system 消息在前，没有 system 消息时退到最后一条消息
  // （两条规则互斥：有 system 消息就不会走下一条）。
  {
    id: 'deepseek.chat.json-hint-system',
    provider: 'deepseek', protocol: 'chat',
    when: { equals: [['response_format.type', 'json_object']], noneContains: [['messages[].content', 'json']] },
    ops: [{ op: 'append', path: 'messages[role=system][0].content', value: '\n\nRespond in JSON.' }]
  },
  {
    id: 'deepseek.chat.json-hint-fallback',
    provider: 'deepseek', protocol: 'chat',
    when: {
      equals: [['response_format.type', 'json_object']],
      noneContains: [['messages[].content', 'json']],
      missing: ['messages[role=system][0].content']
    },
    ops: [{ op: 'append', path: 'messages[-1].content', value: '\n\nRespond in JSON.' }]
  },
  // R3 证据：降级成 json_object、400 没了，但 DeepSeek 的思考模型会把 max_tokens 全花在思考上——
  // 同一条起标题请求 max_tokens=40：默认思考 → content 空串、finish_reason=length、思考吃掉 40 token；
  // 带 `thinking: { type: 'disabled' }` → 直接回 {"title": "Casual Greeting"}、finish=stop、只用 9 token。
  // 客户那头的表现是「标题空白但不报错」。用 default 而不是 set：客户端自己显式传了 thinking 就 ⛔ 动。
  // （派工窗口 09-13 定：⛔ 抬 max_tokens——那是花客户的钱；关思考一分钱不多花。）
  {
    id: 'deepseek.chat.json-object-disable-thinking',
    provider: 'deepseek', protocol: 'chat',
    when: { equals: [['response_format.type', 'json_object']] },
    ops: [{ op: 'default', path: 'thinking', value: { type: 'disabled' } }]
  },
  // R2 证据：DeepSeek chat，历史消息里 role=assistant 且带 tool_calls 但没有 reasoning_content → 400
  // 「must be passed back」；补 `reasoning_content: ""` 同一请求通过（09-13 实测）。
  // 客户可见症状：任何用工具的对话，第二轮起必 400。
  {
    id: 'deepseek.chat.assistant-tool-calls-reasoning-content',
    provider: 'deepseek', protocol: 'chat',
    ops: [{ op: 'default', path: 'messages[role=assistant][tool_calls].reasoning_content', value: '' }]
  }
]

/**
 * 生效规则 = 配方规则在前、内置在后；同 id 的配方规则**替换**内置那条。
 * 顺序有意义：先降级 response_format，后面的提示词规则才看得到降级后的值。
 */
export function activeRewriteRules(recipeRules?: readonly RewriteRule[]): readonly RewriteRule[] {
  if (!recipeRules?.length) return builtinRewriteRules
  const overridden = new Set(recipeRules.map(rule => rule.id))
  return [...recipeRules, ...builtinRewriteRules.filter(rule => !overridden.has(rule.id))]
}

/**
 * 按规则改写一次上行请求。未命中任何规则时 `body` / `headers` 返回**传进来的同一个对象**，
 * 命中时才复制一份改（网关每个请求都会走这里，⛔ 无谓复制整个对话）。
 */
export function rewriteUpstreamRequest(input: RewriteInput, rules: readonly RewriteRule[] = builtinRewriteRules): RewriteResult {
  const protocol = protocolForShell[input.shell]
  let body = input.body
  let headers = input.headers
  let bodyCopied = false
  let headersCopied = false
  const applied: string[] = []
  for (const rule of rules) {
    if (rule.provider !== '*' && rule.provider !== input.provider) continue
    if (rule.protocol !== '*' && rule.protocol !== protocol) continue
    if (rule.models && !rule.models.includes(input.model)) continue
    if (!whenHolds(rule.when, body)) continue
    let changed = false
    for (const op of rule.ops) {
      if (op.target === 'headers') {
        if (!runHeaderOp(headers, op, false)) continue
        if (!headersCopied) { headers = { ...input.headers }; headersCopied = true }
        runHeaderOp(headers, op, true)
      } else {
        if (!runBodyOp(body, op, false)) continue
        if (!bodyCopied) { body = structuredClone(input.body); bodyCopied = true }
        runBodyOp(body, op, true)
      }
      changed = true
    }
    if (changed) applied.push(rule.id)
  }
  return { body, headers, applied }
}

// ── 路径 ───────────────────────────────────────────────────────────────────
type Selector = { readonly kind: 'all' } | { readonly kind: 'index'; readonly at: number }
  | { readonly kind: 'equals'; readonly field: string; readonly value: string } | { readonly kind: 'has'; readonly field: string }
interface Segment { readonly key: string; readonly selectors: readonly Selector[] }

const keyPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/
const selectorPattern = /\[[^[\]]*\]/g
const maxPathLength = 200
const maxSegments = 12
const maxSelectors = 4

/** 解析并校验路径；不合法返回 null（校验与执行共用这一个入口，⛔ 两套规则各写一遍）。 */
export function parseRewritePath(path: string): Segment[] | null {
  if (typeof path !== 'string' || !path || path.length > maxPathLength) return null
  const parts = path.split('.')
  if (!parts.length || parts.length > maxSegments) return null
  const segments: Segment[] = []
  for (const part of parts) {
    const head = part.indexOf('[')
    const key = head < 0 ? part : part.slice(0, head)
    if (!keyPattern.test(key) || forbiddenKeys.has(key)) return null
    const tail = head < 0 ? '' : part.slice(head)
    const selectors: Selector[] = []
    if (tail) {
      const found = tail.match(selectorPattern)
      if (!found || found.join('') !== tail || found.length > maxSelectors) return null
      for (const raw of found) {
        const inner = raw.slice(1, -1)
        if (!inner) { selectors.push({ kind: 'all' }); continue }
        if (/^-?\d{1,4}$/.test(inner)) { selectors.push({ kind: 'index', at: Number(inner) }); continue }
        const eq = inner.indexOf('=')
        if (eq < 0) { if (!keyPattern.test(inner) || forbiddenKeys.has(inner)) return null; selectors.push({ kind: 'has', field: inner }); continue }
        const field = inner.slice(0, eq), value = inner.slice(eq + 1)
        if (!keyPattern.test(field) || forbiddenKeys.has(field) || value.length > 80 || !/^[A-Za-z0-9_.:@ /-]*$/.test(value)) return null
        selectors.push({ kind: 'equals', field, value })
      }
    }
    segments.push({ key, selectors })
  }
  // 末段带选择器就意味着操作要落在数组元素上——⛔ 支持，操作永远是「对象的某个键」。
  if (segments[segments.length - 1]?.selectors.length) return null
  return segments
}

interface Site { readonly parent: Json; readonly key: string }

function isJson(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value) }

function select(items: readonly unknown[], selector: Selector): unknown[] {
  if (selector.kind === 'all') return [...items]
  if (selector.kind === 'index') {
    const at = selector.at < 0 ? items.length + selector.at : selector.at
    return at >= 0 && at < items.length ? [items[at]] : []
  }
  if (selector.kind === 'equals') return items.filter(item => isJson(item) && own(item, selector.field) === selector.value)
  return items.filter(item => isJson(item) && own(item, selector.field) !== undefined && own(item, selector.field) !== null)
}

/** 把路径解成一组「父对象 + 键」；解不到就是空数组（对应「这条规则这次不命中」）。 */
function sites(root: Json, segments: readonly Segment[]): Site[] {
  let containers: Json[] = [root]
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]
    if (!segment) return []
    const next: Json[] = []
    for (const container of containers) {
      const value = own(container, segment.key)
      if (!segment.selectors.length) { if (isJson(value)) next.push(value); continue }
      if (!Array.isArray(value)) continue
      let items: unknown[] = value
      for (const selector of segment.selectors) items = select(items, selector)
      for (const item of items) if (isJson(item)) next.push(item)
    }
    containers = next
    if (!containers.length) return []
  }
  const last = segments[segments.length - 1]
  return last ? containers.map(parent => ({ parent, key: last.key })) : []
}

function bodySites(root: Json, path: string): Site[] {
  const segments = parseRewritePath(path)
  return segments ? sites(root, segments) : []
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

function containsText(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 8) return false
  if (typeof value === 'string') return value.toLowerCase().includes(needle)
  if (Array.isArray(value)) return value.some(item => containsText(item, needle, depth + 1))
  if (isJson(value)) return Object.values(value).some(item => containsText(item, needle, depth + 1))
  return false
}

// ── 匹配 ───────────────────────────────────────────────────────────────────
function whenHolds(when: RewriteWhen | undefined, body: Json): boolean {
  if (!when) return true
  for (const path of when.exists ?? []) if (!bodySites(body, path).some(site => own(site.parent, site.key) !== undefined)) return false
  for (const path of when.missing ?? []) if (bodySites(body, path).some(site => own(site.parent, site.key) !== undefined)) return false
  for (const [path, value] of when.equals ?? []) if (!bodySites(body, path).some(site => sameValue(own(site.parent, site.key), value))) return false
  for (const [path, text] of when.noneContains ?? []) {
    const needle = text.toLowerCase()
    if (bodySites(body, path).some(site => containsText(own(site.parent, site.key), needle))) return false
  }
  return true
}

// ── 执行 ───────────────────────────────────────────────────────────────────
/** 跑一个请求体操作；`mutate=false` 时只回答「会不会改动」，⛔ 写。返回是否（将要）改动。 */
function runBodyOp(root: Json, op: RewriteOp, mutate: boolean): boolean {
  const segments = parseRewritePath(op.path)
  if (!segments) return false
  const last = segments[segments.length - 1]
  if (!last || protectedBodyKeys.has(last.key)) return false
  if (op.op === 'rename' && (typeof op.to !== 'string' || !keyPattern.test(op.to) || protectedBodyKeys.has(op.to) || forbiddenKeys.has(op.to))) return false
  let changed = false
  for (const { parent, key } of sites(root, segments)) {
    const current = own(parent, key)
    if (op.op === 'delete') {
      if (!Object.hasOwn(parent, key)) continue
      changed = true
      if (mutate) delete parent[key]
      continue
    }
    if (op.op === 'rename') {
      const to = op.to as string
      if (!Object.hasOwn(parent, key) || Object.hasOwn(parent, to)) continue
      changed = true
      if (mutate) { parent[to] = current; delete parent[key] }
      continue
    }
    if (op.op === 'append') {
      if (typeof op.value !== 'string' || !op.value) continue
      if (typeof current === 'string') {
        changed = true
        if (mutate) parent[key] = current + op.value
        continue
      }
      // OpenAI 风格的分块内容：`content: [{ type: 'text', text: '…' }]`，追加到最后一块文字上。
      const lastPart = Array.isArray(current) ? current[current.length - 1] : undefined
      if (isJson(lastPart) && typeof lastPart.text === 'string') {
        changed = true
        if (mutate) lastPart.text += op.value
      }
      continue
    }
    // default 只补「没有」和「null」两种情况——DeepSeek 报的就是这个字段没回传。
    if (op.op === 'default' && current !== undefined && current !== null) continue
    if (sameValue(current, op.value)) continue
    changed = true
    if (mutate) parent[key] = op.value === undefined ? null : structuredClone(op.value)
  }
  return changed
}

/** 请求头：单段小写头名，按大小写不敏感找实际那个键。 */
function runHeaderOp(headers: Record<string, string>, op: RewriteOp, mutate: boolean): boolean {
  const name = typeof op.path === 'string' ? op.path.toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || protectedHeaders.has(name) || forbiddenKeys.has(name)) return false
  const to = op.op === 'rename' ? (typeof op.to === 'string' ? op.to.toLowerCase() : '') : ''
  if (op.op === 'rename' && (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(to) || protectedHeaders.has(to) || forbiddenKeys.has(to))) return false
  const actual = Object.keys(headers).find(key => key.toLowerCase() === name)
  const current = actual === undefined ? undefined : headers[actual]
  if (op.op === 'delete') {
    if (actual === undefined) return false
    if (mutate) delete headers[actual]
    return true
  }
  if (op.op === 'rename') {
    if (actual === undefined || Object.keys(headers).some(key => key.toLowerCase() === to)) return false
    if (mutate) { headers[to] = current as string; delete headers[actual] }
    return true
  }
  if (op.op === 'append') {
    if (typeof op.value !== 'string' || !op.value || typeof current !== 'string') return false
    if (mutate) headers[actual as string] = current + op.value
    return true
  }
  if (typeof op.value !== 'string') return false
  if (op.op === 'default' && current !== undefined) return false
  if (current === op.value) return false
  if (mutate) headers[actual ?? name] = op.value
  return true
}

// ── 校验（配方下发的规则走这里，⛔ 相信下发内容的形状）────────────────────────
const idPattern = /^[a-z0-9][a-z0-9._-]*$/
const providerPattern = /^[a-z0-9][a-z0-9-]*$/
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const protocols = new Set(['chat', 'messages', 'responses', '*'])
const opKinds = new Set(['set', 'delete', 'default', 'rename', 'append'])
const whenKeys = new Set(['exists', 'missing', 'equals', 'noneContains'])
const opKeys = new Set(['op', 'target', 'path', 'value', 'to'])
const ruleKeys = new Set(['id', 'provider', 'protocol', 'models', 'when', 'ops'])
const maxRules = 200
const maxOps = 20
const maxPredicates = 20
const maxValueBytes = 4096
const maxRulesBytes = 64 * 1024

const str = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const onlyKeys = (value: Json, allowed: ReadonlySet<string>): boolean => Object.keys(value).every(key => allowed.has(key))

/** 字面量值：能 JSON 化、深度和体积都有上限，⛔ 函数 / undefined / 循环引用。 */
function validValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 64 && value.every(item => validValue(item, depth + 1))
  if (isJson(value)) {
    const keys = Object.keys(value)
    return keys.length <= 64 && !keys.some(key => forbiddenKeys.has(key)) && Object.values(value).every(item => validValue(item, depth + 1))
  }
  return false
}

function validBodyPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const segments = parseRewritePath(path)
  const last = segments?.[segments.length - 1]
  return !!last && !protectedBodyKeys.has(last.key)
}

function validHeaderPath(path: unknown): boolean {
  return typeof path === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(path) && !protectedHeaders.has(path) && !forbiddenKeys.has(path)
}

function validOp(value: unknown): boolean {
  if (!isJson(value) || !onlyKeys(value, opKeys)) return false
  if (typeof value.op !== 'string' || !opKinds.has(value.op)) return false
  if (value.target !== undefined && value.target !== 'body' && value.target !== 'headers') return false
  const header = value.target === 'headers'
  if (!(header ? validHeaderPath(value.path) : validBodyPath(value.path))) return false
  if (value.op === 'rename') {
    if (value.value !== undefined) return false
    if (!str(value.to, 64)) return false
    return header ? validHeaderPath(value.to) : keyPattern.test(value.to) && !protectedBodyKeys.has(value.to) && !forbiddenKeys.has(value.to)
  }
  if (value.to !== undefined) return false
  if (value.op === 'delete') return value.value === undefined
  if (value.op === 'append') return str(value.value, 2000)
  if (header) return str(value.value, 2000)
  if (!validValue(value.value)) return false
  return Buffer.byteLength(JSON.stringify(value.value)) <= maxValueBytes
}

function validWhen(value: unknown): boolean {
  if (!isJson(value) || !onlyKeys(value, whenKeys)) return false
  for (const field of ['exists', 'missing'] as const) {
    if (value[field] === undefined) continue
    const list = value[field]
    if (!Array.isArray(list) || !list.length || list.length > maxPredicates || !list.every(validBodyPath)) return false
  }
  for (const field of ['equals', 'noneContains'] as const) {
    if (value[field] === undefined) continue
    const list = value[field]
    if (!Array.isArray(list) || !list.length || list.length > maxPredicates) return false
    for (const entry of list) {
      if (!Array.isArray(entry) || entry.length !== 2 || !validBodyPath(entry[0])) return false
      if (field === 'noneContains') { if (!str(entry[1], 200)) return false } else if (!validValue(entry[1])) return false
    }
  }
  return true
}

/** 照 recipes.ts 的 validRecipes 风格：长度、类型、路径字符集全部限死，任何一处不对整份作废。 */
export function validateRewriteRules(value: unknown): value is RewriteRule[] {
  if (!Array.isArray(value) || value.length > maxRules) return false
  try { if (Buffer.byteLength(JSON.stringify(value)) > maxRulesBytes) return false } catch { return false }
  const ids = new Set<string>()
  for (const rule of value) {
    if (!isJson(rule) || !onlyKeys(rule, ruleKeys)) return false
    if (!str(rule.id, 80) || !idPattern.test(rule.id) || ids.has(rule.id)) return false
    ids.add(rule.id)
    if (!str(rule.provider, 40) || (rule.provider !== '*' && !providerPattern.test(rule.provider))) return false
    if (typeof rule.protocol !== 'string' || !protocols.has(rule.protocol)) return false
    if (rule.models !== undefined) {
      if (!Array.isArray(rule.models) || !rule.models.length || rule.models.length > 32) return false
      if (!rule.models.every(model => str(model, 120) && modelPattern.test(model))) return false
    }
    if (rule.when !== undefined && !validWhen(rule.when)) return false
    if (!Array.isArray(rule.ops) || !rule.ops.length || rule.ops.length > maxOps || !rule.ops.every(validOp)) return false
  }
  return true
}

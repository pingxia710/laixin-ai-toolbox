// 配方：可由来信后台签名下发的接入数据（服务商接口/模型、六壳最新版本与安装方式、壳版本兼容闸门、高峰时段）。
// 客户端内置一份默认值；下发的配方必须由发布公钥签名，与更新清单同一套信任根。
import { verify } from 'node:crypto'
import type { ModelProviderId } from '../../shared/api-service-types'
import { modelIdPattern, modelProviderIds } from '../../shared/model-providers'

export const shellIds = ['codex', 'claude-code', 'hermes', 'deepseek-harness', 'zcode', 'kimi-code'] as const
export type ShellId = typeof shellIds[number]
export type AccessShell = 'codex' | 'claude' | 'hermes'

export interface ShellRecipe {
  readonly label: string
  /** 最新版本；空串表示后台尚未提供，客户端可自行查注册表。 */
  readonly latest: string
  /** npm 包名（有则可从 npm 注册表查最新版并用 npm 安装）。 */
  readonly npmPackage?: string
  /** 检测命令名（PATH 中的可执行文件）。 */
  readonly command?: string
  /** macOS 应用包名候选。 */
  readonly macApps?: readonly string[]
  /** 各系统的官方安装命令；数组即 argv，第一个元素为程序。 */
  readonly install?: Readonly<Partial<Record<'darwin' | 'win32', readonly string[]>>>
  /** 安装脚本回退来源（多源）：按顺序尝试。 */
  readonly installSources?: readonly string[]
  readonly officialPage: string
}

export interface Incompatibility {
  readonly shell: AccessShell
  /** 精确版本号列表。 */
  readonly versions: readonly string[]
  /** 受影响的服务商；缺省为全部。 */
  readonly providers?: readonly ModelProviderId[]
  readonly message: string
}

export interface PeakHours {
  readonly timezone: string
  /** 0=周日 … 6=周六 */
  readonly weekdays: readonly number[]
  /** 每段 [起, 止)，24 小时制 "HH:MM"。 */
  readonly ranges: readonly (readonly [string, string])[]
  readonly peakLabel: string
  readonly offPeakLabel: string
}

export interface ProviderOverride {
  readonly endpoints?: Readonly<Partial<Record<AccessShell, string>>>
  readonly models?: Readonly<Partial<Record<AccessShell, string>>>
  /**
   * 这家服务商给客户的**标准默认模型**：客户填了 Key 但没自己选模型时用它。
   * 与按壳覆盖的 `models` 分开——`models[shell]` 更具体、优先级更高；
   * 都没有就回落到客户端内置值（线上 v2 配方没有这个字段，照常工作）。
   * ⛔ 覆盖客户已经显式选过的模型。
   */
  readonly defaultModel?: string
}

/**
 * 这个壳这家服务商该用的地址与模型：**按壳覆盖 > 这家的标准默认模型 > 客户端内置**。
 * 客户自己显式选过的模型在 AiAccessService.route 里比这三者都优先，配方更新 ⛔ 覆盖它。
 * 线上 v2 配方没有 defaultModel，走到第三档，行为与升级前一致。
 */
export function resolveProviderRoute(recipes: Recipes, shell: AccessShell, provider: ModelProviderId,
  builtin: { readonly endpoint: string; readonly model: string }): { endpoint: string; model: string } {
  const override = recipes.providers[provider]
  return {
    endpoint: override?.endpoints?.[shell] ?? builtin.endpoint,
    model: override?.models?.[shell] ?? override?.defaultModel ?? builtin.model
  }
}

export interface Recipes {
  readonly version: number
  readonly updatedAt: string
  readonly shells: Readonly<Record<ShellId, ShellRecipe>>
  readonly incompatibilities: readonly Incompatibility[]
  readonly peakHours: Readonly<Partial<Record<ModelProviderId, PeakHours>>>
  readonly providers: Readonly<Partial<Record<ModelProviderId, ProviderOverride>>>
}

export const defaultRecipes: Recipes = {
  version: 4,
  updatedAt: '2026-09-13',
  shells: {
    codex: { label: 'Codex', latest: '', npmPackage: '@openai/codex', command: 'codex', macApps: ['Codex.app', 'ChatGPT.app'],
      install: { darwin: ['npm', 'install', '-g', '@openai/codex'], win32: ['npm', 'install', '-g', '@openai/codex'] },
      officialPage: 'https://chatgpt.com/download/' },
    'claude-code': { label: 'Claude Code', latest: '', npmPackage: '@anthropic-ai/claude-code', command: 'claude',
      install: { darwin: ['bash', '-lc', 'curl -fsSL https://claude.ai/install.sh | bash'], win32: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] },
      officialPage: 'https://claude.com/download?utm_source=claude_code&utm_medium=docs' },
    hermes: { label: 'Hermes', latest: '', command: 'hermes', macApps: ['Hermes.app'],
      officialPage: 'https://hermes-agent.nousresearch.com/desktop' },
    'deepseek-harness': { label: 'DeepSeek Harness', latest: '', npmPackage: '@deepseek-ai/dsh', command: 'dsh',
      install: { darwin: ['npm', 'install', '-g', '@deepseek-ai/dsh'], win32: ['npm', 'install', '-g', '@deepseek-ai/dsh'] },
      officialPage: 'https://www.deepseek.com/harness/' },
    zcode: { label: '智谱 ZCode', latest: '', macApps: ['ZCode.app', 'Zcode.app'], officialPage: 'https://zcode.z.ai/cn/docs/install' },
    'kimi-code': { label: 'Kimi Code', latest: '', command: 'kimi', officialPage: 'https://www.kimi.com/code/docs/' }
  },
  incompatibilities: [
    // 2026-09 实证：Claude Code 2.1.154 把系统提示以 system 角色放进 messages，Anthropic 兼容层（DeepSeek/智谱/Kimi）返回 400。
    { shell: 'claude', versions: ['2.1.154'], message: '这个版本的 Claude Code 与第三方模型接口不兼容（会报 400）。请暂勿启用第三方模型接口，等待官方修复版本或联系来信客服协助。' }
  ],
  peakHours: {
    deepseek: { timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], ranges: [['09:00', '12:00'], ['14:00', '18:00']],
      peakLabel: '现在是高峰时段，按全价计费', offPeakLabel: '现在是空闲时段，按半价计费' }
  },
  // 标准默认模型必须与产品契约一致；客户显式选过的模型永远优先于这里。
  providers: {
    // `deepseek-flash` is DeepSeek V4.1 Flash. Older local V4 spelling is normalized on read.
    deepseek: { defaultModel: 'deepseek-flash' },
    'zhipu-api': { defaultModel: 'glm-5.3-flash' },
    zhipu: { defaultModel: 'glm-5.3-flash' },
    moonshot: { defaultModel: 'kimi-k3' },
    kimi: { defaultModel: 'kimi-for-coding' }
  }
}

const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'] as const
export const npmRegistries = NPM_REGISTRIES

const accessShells = new Set<string>(['codex', 'claude', 'hermes'])
const providerSet = new Set<string>(modelProviderIds)
const text = (value: unknown, max = 400): value is string => typeof value === 'string' && value.length <= max
const argv = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((part) => text(part, 2000))

export function validRecipes(value: unknown): value is Recipes {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (!Number.isSafeInteger(r.version) || (r.version as number) < 1 || !text(r.updatedAt, 40)) return false
  if (!r.shells || typeof r.shells !== 'object') return false
  for (const id of shellIds) {
    const s = (r.shells as Record<string, unknown>)[id] as Record<string, unknown> | undefined
    if (!s || !text(s.label, 40) || !text(s.latest, 40) || !text(s.officialPage, 400) || !/^https:\/\//.test(s.officialPage as string)) return false
    if (s.npmPackage !== undefined && !text(s.npmPackage, 120)) return false
    if (s.command !== undefined && !(text(s.command, 40) && /^[a-z0-9._-]+$/i.test(s.command as string))) return false
    if (s.macApps !== undefined && !argv(s.macApps)) return false
    if (s.installSources !== undefined && !argv(s.installSources)) return false
    if (s.install !== undefined) {
      if (!s.install || typeof s.install !== 'object') return false
      for (const [platform, command] of Object.entries(s.install as Record<string, unknown>)) if (!['darwin', 'win32'].includes(platform) || !argv(command)) return false
    }
  }
  if (!Array.isArray(r.incompatibilities) || r.incompatibilities.length > 200) return false
  for (const item of r.incompatibilities as Record<string, unknown>[]) {
    if (!item || !accessShells.has(item.shell as string) || !argv(item.versions) || !text(item.message, 400)) return false
    if (item.providers !== undefined && !(Array.isArray(item.providers) && item.providers.every((p) => providerSet.has(p as string)))) return false
  }
  if (!r.peakHours || typeof r.peakHours !== 'object' || !r.providers || typeof r.providers !== 'object') return false
  for (const [provider, hours] of Object.entries(r.peakHours as Record<string, unknown>)) {
    const h = hours as Record<string, unknown>
    if (!providerSet.has(provider) || !h || !text(h.timezone, 60) || !Array.isArray(h.weekdays) || !Array.isArray(h.ranges) || !text(h.peakLabel, 80) || !text(h.offPeakLabel, 80)) return false
    if (!h.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return false
    if (!h.ranges.every((range) => Array.isArray(range) && range.length === 2 && range.every((edge) => typeof edge === 'string' && /^\d{2}:\d{2}$/.test(edge)))) return false
  }
  for (const [provider, override] of Object.entries(r.providers as Record<string, unknown>)) {
    const o = override as Record<string, unknown>
    if (!providerSet.has(provider) || !o || typeof o !== 'object') return false
    for (const field of ['endpoints', 'models'] as const) {
      if (o[field] === undefined) continue
      if (!o[field] || typeof o[field] !== 'object') return false
      for (const [shell, entry] of Object.entries(o[field] as Record<string, unknown>)) {
        if (!accessShells.has(shell) || !text(entry, 400)) return false
        if (field === 'endpoints' && !/^https:\/\//.test(entry as string)) return false
      }
    }
    // 模型 ID 会进客户端配置文件，按同一条规则校验，⛔ 让引号换行之类的东西下发进去。
    if (o.defaultModel !== undefined && (typeof o.defaultModel !== 'string' || !modelIdPattern.test(o.defaultModel))) return false
  }
  return true
}

/** 与更新清单同一信封格式：{ payload: base64(json), signature: base64(ed25519) }。 */
export function readRecipeManifest(body: string, publicKey: string): Recipes {
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error('RECIPES_INVALID')
  const envelope = JSON.parse(body) as { payload?: unknown; signature?: unknown }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('RECIPES_INVALID')
  const payload = Buffer.from(envelope.payload, 'base64')
  if (!verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('RECIPES_SIGNATURE_INVALID')
  const recipes = JSON.parse(payload.toString('utf8')) as unknown
  if (!validRecipes(recipes)) throw new Error('RECIPES_INVALID')
  return recipes
}

export function findIncompatibility(recipes: Recipes, shell: AccessShell, version: string, provider?: ModelProviderId): Incompatibility | undefined {
  const normalized = version.trim().replace(/^v/i, '')
  if (!normalized) return undefined
  return recipes.incompatibilities.find((item) => item.shell === shell && item.versions.includes(normalized) &&
    (provider === undefined || item.providers === undefined || item.providers.includes(provider)))
}

export interface PeakState { readonly peak: boolean; readonly label: string }
export function peakState(recipes: Recipes, provider: ModelProviderId, now = new Date()): PeakState | null {
  const hours = recipes.peakHours[provider]
  if (!hours) return null
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: hours.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const minutes = Number(get('hour')) % 24 * 60 + Number(get('minute'))
  const toMinutes = (edge: string) => Number(edge.slice(0, 2)) * 60 + Number(edge.slice(3, 5))
  // 跨零点的区间（22:00-06:00）属于**起始**那一天：零点后那半段要按前一天查星期，
  // ⛔ 把周六凌晨当成周六的高峰，也 ⛔ 像原来那样恒判空闲。
  const onDay = (offset: number) => hours.weekdays.includes((weekday + offset + 7) % 7)
  const inRange = weekday >= 0 && hours.ranges.some(([start, end]) => {
    const from = toMinutes(start), to = toMinutes(end)
    if (from <= to) return onDay(0) && minutes >= from && minutes < to
    return (onDay(0) && minutes >= from) || (onDay(-1) && minutes < to)
  })
  return { peak: inRange, label: inRange ? hours.peakLabel : hours.offPeakLabel }
}

interface ParsedVersion {
  readonly release: readonly number[]
  readonly prerelease: readonly string[]
}

/**
 * 版本号拆成「正式段 + 预发布段」。正式段必须全是数字，否则认不出来（返回 null → 比较返回 0）。
 * 原来按 `[.-]` 一起拆，`0.1.5-rc.1` 会拆出 NaN 段而恒判「一样新」。
 */
function parseSemver(value: string): ParsedVersion | null {
  const bare = (value.trim().replace(/^v/i, '').split('+')[0] ?? '')
  const cut = bare.indexOf('-')
  const head = cut < 0 ? bare : bare.slice(0, cut)
  const tail = cut < 0 ? '' : bare.slice(cut + 1)
  const release = head.split('.').map((part) => /^\d+$/.test(part) ? Number(part) : NaN)
  if (!release.length || release.some(Number.isNaN)) return null
  return { release, prerelease: tail ? tail.split('.') : [] }
}

/** semver：带预发布段的排在同号正式版之前；逐段比，数字段比数值、数字段小于文字段、文字段比字典序。 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index], y = b[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) return nx > ny ? 1 : -1
    if (nx !== null) return -1
    if (ny !== null) return 1
    return x > y ? 1 : -1
  }
  return 0
}

/**
 * 版本比较：正式段逐段比数字，相等再按 semver 比预发布段；构建元数据（`+…`）不参与；无法解析时返回 0。
 * 预发布号必须认得出来——npm 上真有拿 `0.1.5-rc.1` 当 latest 的包（`@deepseek-ai/dsh`，2026-09-12 实查），
 * 恒返回 0 会让它永远不提示更新、还被写成「已是最新」。
 */
export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left), b = parseSemver(right)
  if (!a || !b) return 0
  for (let index = 0; index < Math.max(a.release.length, b.release.length); index++) {
    const x = a.release[index] ?? 0, y = b.release[index] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

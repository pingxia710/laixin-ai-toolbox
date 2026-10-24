/**
 * Canonical product facts used by configuration, health checks, and customer-facing cards.
 * A provider ID names the product where the customer obtained the Key. Similar model names
 * are deliberately not a reason to share an ID, a Key, or subscription entitlement.
 */
export const modelProviderIds = ['deepseek', 'zhipu-api', 'zhipu', 'moonshot', 'kimi'] as const
export type ModelProviderId = typeof modelProviderIds[number]

export const modelProviderShells = ['codex', 'claude', 'hermes'] as const
export type ModelProviderShell = typeof modelProviderShells[number]

/** The customer product, rather than the vendor name, decides Key and billing boundaries. */
export type ModelProviderProduct = 'metered-api' | 'coding-plan' | 'membership'
export type ProviderShellProtocol = 'openai-responses' | 'anthropic-messages' | 'openai-chat-completions'
export type ProviderShellStatus = 'supported' | 'pending-verification'

interface StoredProviderShellContractBase {
  readonly protocol: ProviderShellProtocol
  /** Shown directly in the picker so a pending route cannot look selectable. */
  readonly description: string
}

interface SupportedProviderShellContract extends StoredProviderShellContractBase {
  readonly status: 'supported'
  readonly endpoint: string
  readonly defaultModel: string
  /** Exact request IDs for this product and this client protocol. */
  readonly models: readonly string[]
}

interface PendingProviderShellContract extends StoredProviderShellContractBase {
  readonly status: 'pending-verification'
  /** No route or model is available until the native client acceptance completes. */
  readonly models: readonly []
}

export type StoredProviderShellContract = SupportedProviderShellContract | PendingProviderShellContract

/** Renderer-safe view: product facts and the shell contract are returned together. */
export type ProviderShellContract = StoredProviderShellContract & {
  readonly provider: ModelProviderId
  readonly shell: ModelProviderShell
  readonly title: string
  readonly product: ModelProviderProduct
  readonly productDescription: string
}

const supported = (
  protocol: ProviderShellProtocol,
  endpoint: string,
  defaultModel: string,
  models: readonly string[],
  description: string
): SupportedProviderShellContract => ({ status: 'supported', protocol, endpoint, defaultModel, models, description })

/** Documented model choices and client context limits; availability is checked on save. */
export const providerModelWindows: Readonly<Record<ModelProviderId, Readonly<Record<string, number>>>> = {
  // `deepseek-v4-flash` remains only so existing local state can be read and normalized.
  deepseek: { 'deepseek-flash': 1_048_576, 'deepseek-v4-pro': 1_048_576, 'deepseek-v4-flash': 1_048_576 },
  // 智谱普通 API 与 Coding Plan 由不同 Key 和端点承载；两边的原生三壳验收都使用 GLM-5.3-Flash。
  'zhipu-api': { 'glm-5.3-flash': 1_048_576 },
  zhipu: { 'glm-5.3-flash': 1_048_576 },
  // K3's larger window depends on the membership tier; use the common 256K window except its Claude Code 1M selector.
  kimi: { 'kimi-for-coding': 1_048_576, k3: 262_144, 'k3-256k': 262_144, 'k3[1m]': 1_048_576, 'kimi-for-coding-highspeed': 262_144 },
  moonshot: { 'kimi-k3': 1_048_576, 'kimi-k2.7-code': 262_144, 'kimi-k2.7-code-highspeed': 262_144, 'kimi-k2.6': 262_144 }
}

export function providerModelWindow(provider: ModelProviderId, model: string): number | undefined {
  const models = providerModelWindows[provider]
  return Object.hasOwn(models, model) ? models[model] : undefined
}

/** Model IDs reach client config files, so arbitrary quotes, newlines and config syntax remain forbidden. */
export const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,127}$/

/** A previous Z.AI global Key is retained only for local-state migration, never routed. */
export const legacyModelProviderIds = ['zai'] as const
export type LegacyModelProviderId = typeof legacyModelProviderIds[number]

export type ClaudeKeyName = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'

export interface ApiServiceConnection {
  /** A local service base URL or the provider's documented base URL. */
  readonly baseUrl: string
  /** Customer-facing token for the configured endpoint; it is never rendered in UI or logs. */
  readonly apiKey: string
  /** Override only when a service selects an allowed model after a live capability check. */
  readonly model?: string
}

export interface CodexProviderConfig {
  readonly provider: string
  readonly name: string
  readonly baseUrl: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly contextWindow: number
  readonly inputModalities: readonly ('text' | 'image')[]
}

export interface ClaudeProviderConfig {
  readonly baseUrl: string
  readonly keyName: ClaudeKeyName
  readonly model: string
  readonly smallModel: string
  readonly contextWindow: number
  readonly effort: 'high' | 'max'
}

export interface HermesProviderConfig {
  readonly provider: string
  readonly model: string
  readonly env: Readonly<Record<string, string>>
}

export interface ModelProviderDefinition {
  readonly id: ModelProviderId
  readonly title: string
  readonly product: ModelProviderProduct
  /** Short visible boundary that prevents a customer from pasting a Key from a sibling product. */
  readonly productDescription: string
  readonly keyUrl: string
  readonly keySource: string
  readonly billingHint: string
  readonly shells: Readonly<Record<ModelProviderShell, StoredProviderShellContract>>
  /** Compatibility fields. Only call providerShellContract/isProviderShellSupported for new routing. */
  readonly endpoints: Readonly<Record<ModelProviderShell, string>>
  readonly models: Readonly<Record<ModelProviderShell, string>>
  readonly codex: CodexProviderConfig
  readonly claude: ClaudeProviderConfig
  readonly hermes: HermesProviderConfig
}

function defineProvider(definition: Omit<ModelProviderDefinition, 'endpoints' | 'models'>): ModelProviderDefinition {
  const endpoints = {} as Record<ModelProviderShell, string>
  const models = {} as Record<ModelProviderShell, string>
  for (const shell of modelProviderShells) {
    const contract = definition.shells[shell]
    endpoints[shell] = contract.status === 'supported' ? contract.endpoint : ''
    models[shell] = contract.status === 'supported' ? contract.defaultModel : ''
  }
  return { ...definition, endpoints, models }
}

// `deepseek-flash` is the current DeepSeek V4.1 Flash ID. The older `deepseek-v4-flash`
// spelling is normalized below when reading existing local state and is not offered to new routes.
const deepseekModels = ['deepseek-flash', 'deepseek-v4-pro'] as const
const zhipuApiModels = ['glm-5.3-flash'] as const
const zhipuPlanModels = ['glm-5.3-flash'] as const
const kimiCodeModels = ['kimi-for-coding', 'k3', 'k3-256k', 'kimi-for-coding-highspeed'] as const
const kimiOpenModels = ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'] as const

export const modelProviders: Readonly<Record<ModelProviderId, ModelProviderDefinition>> = {
  deepseek: defineProvider({
    id: 'deepseek', title: 'DeepSeek API', product: 'metered-api',
    productDescription: '使用 DeepSeek 开放平台 API Key 按量调用，不使用任何订阅套餐额度。',
    keyUrl: 'https://platform.deepseek.com/api_keys', keySource: 'DeepSeek 开放平台 API Key', billingHint: '按 API 用量计费。',
    shells: {
      codex: supported('openai-responses', 'https://api.deepseek.com/responses', 'deepseek-flash', deepseekModels, 'DeepSeek Responses 接入已支持。'),
      claude: supported('anthropic-messages', 'https://api.deepseek.com/anthropic/v1/messages', 'deepseek-flash', deepseekModels, 'DeepSeek Anthropic 兼容接入已支持。'),
      hermes: supported('openai-chat-completions', 'https://api.deepseek.com/chat/completions', 'deepseek-flash', deepseekModels, 'DeepSeek Chat Completions 接入已支持。')
    },
    codex: {
      provider: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-flash',
      displayName: 'DeepSeek-V4.1-Flash', description: 'DeepSeek frontier agentic coding model', contextWindow: 1_048_576,
      inputModalities: ['text']
    },
    claude: {
      baseUrl: 'https://api.deepseek.com/anthropic', keyName: 'ANTHROPIC_AUTH_TOKEN', model: 'deepseek-flash',
      smallModel: 'deepseek-flash', contextWindow: 1_048_576, effort: 'max'
    },
    hermes: { provider: 'deepseek', model: 'deepseek-flash', env: { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' } }
  }),
  'zhipu-api': defineProvider({
    id: 'zhipu-api', title: '智谱开放平台 API', product: 'metered-api',
    productDescription: '使用智谱开放平台普通 API Key 按量调用；与 GLM Coding Plan 的 Key 和套餐额度完全独立。',
    keyUrl: 'https://open.bigmodel.cn/', keySource: '智谱开放平台普通 API Key（非 GLM Coding Plan Key）',
    billingHint: '按普通 API 用量计费，不扣 GLM Coding Plan 套餐额度。',
    shells: {
      codex: supported('openai-responses', 'https://open.bigmodel.cn/api/v1/responses', 'glm-5.3-flash', zhipuApiModels, '智谱普通 API 的 Codex Responses 原生接入已支持，按普通 API 用量计费。'),
      claude: supported('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic/v1/messages', 'glm-5.3-flash', zhipuApiModels, '智谱普通 API 的 Claude Code Anthropic 接入已支持，按普通 API 用量计费。'),
      hermes: supported('openai-chat-completions', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-5.3-flash', zhipuApiModels, '智谱普通 API 的 Hermes OpenAI 接入已支持，按普通 API 用量计费。')
    },
    codex: {
      provider: 'ZAI', name: '智谱 API', baseUrl: 'https://open.bigmodel.cn/api/v1', model: 'glm-5.3-flash',
      displayName: 'GLM-5.3-Flash', description: '智谱普通 API 的 Codex Responses 模型', contextWindow: 1_048_576, inputModalities: ['text']
    },
    claude: {
      baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyName: 'ANTHROPIC_AUTH_TOKEN', model: 'glm-5.3-flash',
      smallModel: 'glm-5.3-flash', contextWindow: 1_048_576, effort: 'max'
    },
    hermes: { provider: 'openai', model: 'glm-5.3-flash', env: { GLM_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4' } }
  }),
  zhipu: defineProvider({
    id: 'zhipu', title: '智谱 GLM Coding Plan', product: 'coding-plan',
    productDescription: '使用 GLM Coding Plan 套餐 Key 和专属端点；不能替代智谱普通 API Key 或按量资源包。',
    keyUrl: 'https://open.bigmodel.cn/', keySource: '智谱开放平台 GLM Coding Plan Key（个人或团队套餐 Key）',
    billingHint: '使用 GLM Coding Plan 套餐额度。',
    shells: {
      codex: supported('openai-responses', 'https://open.bigmodel.cn/api/v1/responses', 'glm-5.3-flash', zhipuPlanModels, 'GLM Coding Plan 的 Codex Responses 原生接入已支持。'),
      claude: supported('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic/v1/messages', 'glm-5.3-flash', zhipuPlanModels, 'GLM Coding Plan 的 Claude Code Anthropic 接入已支持。'),
      hermes: supported('openai-chat-completions', 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', 'glm-5.3-flash', zhipuPlanModels, 'GLM Coding Plan 的 Hermes OpenAI 接入已支持。')
    },
    codex: {
      provider: 'ZAI', name: 'ZAI', baseUrl: 'https://open.bigmodel.cn/api/v1', model: 'glm-5.3-flash',
      displayName: 'GLM-5.3-Flash', description: 'GLM Coding Plan Codex Responses model', contextWindow: 1_048_576, inputModalities: ['text']
    },
    claude: {
      baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyName: 'ANTHROPIC_AUTH_TOKEN', model: 'glm-5.3-flash',
      smallModel: 'glm-5.3-flash', contextWindow: 1_048_576, effort: 'max'
    },
    hermes: { provider: 'zai', model: 'glm-5.3-flash', env: { GLM_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4' } }
  }),
  kimi: defineProvider({
    id: 'kimi', title: 'Kimi Code 官方套餐', product: 'membership',
    productDescription: '使用 Kimi Code 会员 API Key 和会员权益；与 Kimi 开放平台 API Key、余额和端点独立。',
    keyUrl: 'https://www.kimi.com/code/console', keySource: 'Kimi Code Console 的会员套餐 API Key', billingHint: '按 Kimi Code 会员档位与套餐配额使用。',
    shells: {
      codex: supported('openai-responses', 'https://api.kimi.com/coding/v1/responses', 'kimi-for-coding', kimiCodeModels, 'Kimi Code Responses 接入已支持；会员档位决定可选模型。'),
      claude: supported('anthropic-messages', 'https://api.kimi.com/coding/v1/messages', 'kimi-for-coding', [...kimiCodeModels, 'k3[1m]'], 'Kimi Code Claude Code 接入已支持；k3[1m] 只用于 Claude Code 的 1M 配置。'),
      hermes: supported('openai-chat-completions', 'https://api.kimi.com/coding/v1/chat/completions', 'kimi-for-coding', kimiCodeModels, 'Kimi Code Hermes 接入已支持；手写模型名使用 k3，不使用向导显示前缀。')
    },
    codex: {
      provider: 'kimi', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding',
      displayName: 'Kimi for Coding', description: 'Kimi Code membership default for every plan', contextWindow: 1_048_576, inputModalities: ['text', 'image']
    },
    claude: {
      baseUrl: 'https://api.kimi.com/coding/', keyName: 'ANTHROPIC_API_KEY', model: 'kimi-for-coding',
      smallModel: 'kimi-for-coding', contextWindow: 1_048_576, effort: 'high'
    },
    hermes: { provider: 'kimi-coding', model: 'kimi-for-coding', env: { KIMI_BASE_URL: 'https://api.kimi.com/coding/v1' } }
  }),
  moonshot: defineProvider({
    id: 'moonshot', title: 'Kimi 开放平台 API', product: 'metered-api',
    productDescription: '使用 Kimi 开放平台 API Key 按量调用；不能使用 Kimi Code 会员 Key 或其套餐额度。',
    keyUrl: 'https://platform.kimi.com/console/api-keys', keySource: 'Kimi 开放平台 API Key', billingHint: '按 API 用量计费。',
    shells: {
      codex: supported('openai-responses', 'https://api.moonshot.cn/v1/responses', 'kimi-k3', kimiOpenModels, 'Kimi 开放平台 Responses 接入已支持。'),
      claude: supported('anthropic-messages', 'https://api.moonshot.cn/anthropic/v1/messages', 'kimi-k3', kimiOpenModels, 'Kimi 开放平台 Anthropic 兼容接入已支持。'),
      hermes: supported('openai-chat-completions', 'https://api.moonshot.cn/v1/chat/completions', 'kimi-k3', kimiOpenModels, 'Kimi 开放平台 Chat Completions 接入已支持。')
    },
    codex: {
      provider: 'moonshot', name: 'Kimi API', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3',
      displayName: 'Kimi K3', description: 'Kimi API Platform flagship model', contextWindow: 1_048_576, inputModalities: ['text', 'image']
    },
    claude: {
      baseUrl: 'https://api.moonshot.cn/anthropic', keyName: 'ANTHROPIC_AUTH_TOKEN', model: 'kimi-k3',
      smallModel: 'kimi-k2.7-code', contextWindow: 1_000_000, effort: 'max'
    },
    hermes: { provider: 'custom:kimi-k3-cn', model: 'kimi-k3', env: { KIMI_CN_BASE_URL: 'https://api.moonshot.cn/v1' } }
  })
}

/** Stable picker API: renderer code must use this instead of duplicating hard-coded provider combinations. */
export function providerShellContract(provider: ModelProviderId, shell: ModelProviderShell): ProviderShellContract {
  const definition = modelProviders[provider]
  return { ...definition.shells[shell], provider, shell, title: definition.title, product: definition.product, productDescription: definition.productDescription }
}

export function isProviderShellSupported(provider: ModelProviderId, shell: ModelProviderShell): boolean {
  return modelProviders[provider].shells[shell].status === 'supported'
}

/** Exact product-and-client whitelist. Do not fall back to the broad config-safe regex here. */
export function isProviderModelAllowed(provider: ModelProviderId, shell: ModelProviderShell, model: string): boolean {
  const contract = modelProviders[provider].shells[shell]
  return contract.status === 'supported' && contract.models.includes(model)
}

/**
 * Safe storage compatibility is broader than the current routing whitelist. A prior signed
 * recipe can contain a model that has since been removed; preserving its syntactically safe ID
 * avoids quarantining unrelated local Keys. `route()` still normalizes it or falls back to the
 * current contract, and the next explicit enable persists only that canonical choice.
 */
export function isStoredProviderModelAllowed(provider: ModelProviderId, shell: ModelProviderShell, model: string): boolean {
  return modelIdPattern.test(model) || normalizeProviderModel(provider, shell, model) !== undefined
}

/**
 * Only the old Kimi Code Claude Code spelling is migrated. The Kimi Open Platform is a separate
 * Key product, so no helper is allowed to silently move a customer between those products.
 */
export function normalizeProviderModel(provider: ModelProviderId, shell: ModelProviderShell, model: string): string | undefined {
  const normalized = provider === 'deepseek' && model === 'deepseek-v4-flash' ? 'deepseek-flash'
    : provider === 'moonshot' && shell === 'claude' && model === 'kimi-k3[1m]' ? 'kimi-k3'
    : provider === 'kimi' && shell === 'claude' && model === 'kimi-k3[1m]' ? 'k3[1m]'
    : (provider === 'zhipu' || provider === 'zhipu-api') && (model === 'glm-5.2' || model === 'glm-5.3') ? 'glm-5.3-flash'
      : model
  return isProviderModelAllowed(provider, shell, normalized) ? normalized : undefined
}

export function modelProvider(provider: ModelProviderId): ModelProviderDefinition {
  return modelProviders[provider]
}

import type { SharingChoice, SharingStandardProduct } from './sharing-types'
import { modelProviderIds, modelProviders, providerModelWindows } from './shared/model-providers'

const choice = (value: string | number, label: string): SharingChoice => ({ value: String(value), label })
const software = [choice('codex', 'Codex'), choice('claude', 'Claude Code')]
const deliveryHours = [choice(1, '1 小时内'), choice(6, '6 小时内'), choice(12, '12 小时内'), choice(24, '24 小时内'), choice(48, '48 小时内')]
const apiProviders = modelProviderIds.map((id) => ({
  value: id,
  label: modelProviders[id].title,
  models: Object.keys(providerModelWindows[id]).map((model) => choice(model, model))
}))

export const sharingStandardProducts: readonly SharingStandardProduct[] = [
  {
    id: 'account-rental',
    label: '账号租用',
    description: '按租期使用一套官方套餐账号。',
    termDays: [choice(7, '7 天'), choice(30, '30 天')],
    software,
    accountPlans: [
      { ...choice('chatgpt-plus', 'ChatGPT Plus'), software: 'codex' },
      { ...choice('chatgpt-pro', 'ChatGPT Pro'), software: 'codex' },
      { ...choice('claude-pro', 'Claude Pro'), software: 'claude' },
      { ...choice('claude-max-5x', 'Claude Max 5x'), software: 'claude' },
      { ...choice('claude-max-20x', 'Claude Max 20x'), software: 'claude' }
    ],
    apiProviders: [], quotaUnits: [], usageTiers: [], deliveryHours
  },
  {
    id: 'api-quota',
    label: 'API 租用 · 额度包',
    description: '按固定额度和有效期使用 API。',
    termDays: [choice(30, '30 天有效'), choice(90, '90 天有效'), choice(180, '180 天有效')],
    software, accountPlans: [], apiProviders,
    quotaUnits: [choice('million-tokens', '百万 Tokens'), choice('yuan-credit', '元额度'), choice('request-count', '次请求')],
    usageTiers: [], deliveryHours
  },
  {
    id: 'api-period',
    label: 'API 租用 · 周期包',
    description: '在固定周期内按约定使用强度使用 API。',
    termDays: [choice(7, '7 天'), choice(30, '30 天'), choice(90, '90 天')],
    software, accountPlans: [], apiProviders, quotaUnits: [],
    usageTiers: [choice('light', '日常轻量'), choice('standard', '持续使用'), choice('heavy', '高频使用')],
    deliveryHours
  }
]

export function sharingStandardProduct(id: string): SharingStandardProduct | undefined {
  return sharingStandardProducts.find((product) => product.id === id)
}

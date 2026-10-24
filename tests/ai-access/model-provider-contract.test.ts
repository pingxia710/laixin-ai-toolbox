import { describe, expect, it } from 'vitest'
import {
  isProviderModelAllowed,
  isProviderShellSupported,
  isStoredProviderModelAllowed,
  modelIdPattern,
  modelProviderIds,
  modelProviders,
  normalizeProviderModel,
  providerModelWindow,
  providerShellContract
} from '../../app/shared/model-providers'

describe('模型 API 产品契约', () => {
  it('把普通 API、Coding Plan 与 Kimi Code 会员作为不同产品，不混用 Key 来源或权益', () => {
    expect(modelProviderIds).toEqual(['deepseek', 'zhipu-api', 'zhipu', 'moonshot', 'kimi'])
    expect(modelProviders.deepseek).toMatchObject({
      title: 'DeepSeek API', product: 'metered-api', keySource: 'DeepSeek 开放平台 API Key'
    })
    expect(modelProviders['zhipu-api']).toMatchObject({
      title: '智谱开放平台 API', product: 'metered-api'
    })
    expect(modelProviders['zhipu-api'].keySource).toContain('普通 API')
    expect(modelProviders.zhipu).toMatchObject({
      title: '智谱 GLM Coding Plan', product: 'coding-plan'
    })
    expect(modelProviders.zhipu.keySource).toContain('Coding Plan')
    expect(modelProviders.kimi).toMatchObject({
      title: 'Kimi Code 官方套餐', product: 'membership'
    })
    expect(modelProviders.moonshot).toMatchObject({
      title: 'Kimi 开放平台 API', product: 'metered-api'
    })
  })

  it('每个产品与壳都有可供界面直接使用的支持状态；智谱两个入口的 Codex Responses 已完成原生验收', () => {
    for (const provider of modelProviderIds) {
      for (const shell of ['codex', 'claude', 'hermes'] as const) {
        const contract = providerShellContract(provider, shell)
        expect(contract.description.length).toBeGreaterThan(12)
        if (contract.status === 'supported') {
          expect(contract.endpoint).toMatch(/^https:\/\//)
          expect(contract.defaultModel).toBeTruthy()
          expect(contract.models).toContain(contract.defaultModel)
          expect(isProviderShellSupported(provider, shell)).toBe(true)
        } else {
          expect(contract.models).toEqual([])
          expect(isProviderShellSupported(provider, shell)).toBe(false)
        }
      }
    }

    // 两种智谱 Key 继续分开建模；真实 Codex 0.153.4 已通过 Responses 路径回答。
    expect(providerShellContract('zhipu-api', 'codex')).toMatchObject({
      status: 'supported', protocol: 'openai-responses', endpoint: 'https://open.bigmodel.cn/api/v1/responses', defaultModel: 'glm-5.3-flash'
    })
    expect(providerShellContract('zhipu', 'codex')).toMatchObject({
      status: 'supported', protocol: 'openai-responses', endpoint: 'https://open.bigmodel.cn/api/v1/responses', defaultModel: 'glm-5.3-flash'
    })
    expect(providerShellContract('zhipu-api', 'claude')).toMatchObject({
      status: 'supported', protocol: 'anthropic-messages', endpoint: 'https://open.bigmodel.cn/api/anthropic/v1/messages', defaultModel: 'glm-5.3-flash'
    })
    // 网关转发地址是完整 messages endpoint；写入 Claude Code 的只能是协议 base，避免重复拼 /v1/messages。
    expect(modelProviders['zhipu-api'].claude.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(providerShellContract('zhipu-api', 'hermes')).toMatchObject({
      status: 'supported', protocol: 'openai-chat-completions', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', defaultModel: 'glm-5.3-flash'
    })
    expect(providerShellContract('zhipu', 'claude')).toMatchObject({
      status: 'supported', protocol: 'anthropic-messages', endpoint: 'https://open.bigmodel.cn/api/anthropic/v1/messages', defaultModel: 'glm-5.3-flash'
    })
    expect(providerShellContract('zhipu', 'hermes')).toMatchObject({
      status: 'supported', protocol: 'openai-chat-completions', endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', defaultModel: 'glm-5.3-flash'
    })
  })

  it('只对白名单的产品-壳组合放行 K3 1M 特例；历史方括号 ID 可安全读取但不会扩大新路由', () => {
    expect(modelIdPattern.test('k3[1m]')).toBe(true)
    expect(modelIdPattern.test('kimi-k3[1m]')).toBe(true)
    expect(modelIdPattern.test('k3[1m]"\napi_key=leak')).toBe(false)
    expect(providerShellContract('kimi', 'claude').models).toContain('k3[1m]')
    expect(isProviderModelAllowed('kimi', 'claude', 'k3[1m]')).toBe(true)
    expect(isProviderModelAllowed('kimi', 'codex', 'k3[1m]')).toBe(false)
    expect(isProviderModelAllowed('kimi', 'hermes', 'k3[1m]')).toBe(false)
    expect(isProviderModelAllowed('moonshot', 'claude', 'kimi-k3[1m]')).toBe(false)
    expect(isProviderModelAllowed('kimi', 'claude', 'k3[anything]')).toBe(false)
  })

  it('三壳的 DeepSeek 都默认发布 deepseek-flash；旧 V4 名只在读取历史状态时归一', () => {
    expect(providerShellContract('deepseek', 'codex')).toMatchObject({
      defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro']
    })
    expect(isProviderModelAllowed('deepseek', 'codex', 'deepseek-flash')).toBe(true)
    expect(isProviderModelAllowed('deepseek', 'codex', 'deepseek-v4-flash')).toBe(false)
    expect(normalizeProviderModel('deepseek', 'codex', 'deepseek-v4-flash')).toBe('deepseek-flash')
    expect(isStoredProviderModelAllowed('deepseek', 'codex', 'deepseek-v4-flash')).toBe(true)
    for (const shell of ['claude', 'hermes'] as const) {
      expect(providerShellContract('deepseek', shell).models).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
      expect(normalizeProviderModel('deepseek', shell, 'deepseek-v4-flash')).toBe('deepseek-flash')
    }
  })

  it('只在 Kimi Code 的 Claude Code 旧配置中迁移错误的历史别名，并且重新保存永远写官方 ID', () => {
    expect(normalizeProviderModel('kimi', 'claude', 'kimi-k3[1m]')).toBe('k3[1m]')
    expect(normalizeProviderModel('kimi', 'claude', 'k3[1m]')).toBe('k3[1m]')
    expect(normalizeProviderModel('kimi', 'codex', 'kimi-k3[1m]')).toBeUndefined()
    // Kimi 开放平台旧配置只在同一产品内归一，不能迁到 Kimi Code。
    expect(normalizeProviderModel('moonshot', 'claude', 'kimi-k3[1m]')).toBe('kimi-k3')
    expect(modelProviders.moonshot.claude.model).toBe('kimi-k3')
  })

  it('智谱三壳的新选择都写 glm-5.3-flash；旧 GLM-5.2/5.3 只在读取时归一', () => {
    for (const provider of ['zhipu-api', 'zhipu'] as const) {
      for (const shell of ['codex', 'claude', 'hermes'] as const) {
        expect(normalizeProviderModel(provider, shell, 'glm-5.2')).toBe('glm-5.3-flash')
        expect(normalizeProviderModel(provider, shell, 'glm-5.3')).toBe('glm-5.3-flash')
        expect(normalizeProviderModel(provider, shell, 'glm-5.3-flash')).toBe('glm-5.3-flash')
        expect(providerShellContract(provider, shell).models).toEqual(['glm-5.3-flash'])
      }
    }
    expect(providerModelWindow('zhipu-api', 'glm-5.3-flash')).toBe(1_048_576)
    expect(providerModelWindow('zhipu', 'glm-5.3-flash')).toBe(1_048_576)
    // Historical values remain safe to read so one retired model cannot quarantine other Keys.
    expect(isStoredProviderModelAllowed('zhipu', 'codex', 'glm-5.2')).toBe(true)
    expect(isStoredProviderModelAllowed('zhipu', 'codex', 'glm-5.3')).toBe(true)
    expect(isStoredProviderModelAllowed('zhipu', 'codex', 'glm-5.3-flash')).toBe(true)
  })

  it('历史 Claude 配置中的 Kimi Open Platform 括号别名只归到同一产品的当前模型', () => {
    expect(normalizeProviderModel('moonshot', 'claude', 'kimi-k3[1m]')).toBe('kimi-k3')
    expect(normalizeProviderModel('kimi', 'claude', 'kimi-k3[1m]')).toBe('k3[1m]')
  })
})

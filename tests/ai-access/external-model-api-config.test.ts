import { describe, expect, it } from 'vitest'
import {
  createClaudeDeepSeekConfig,
  createCodexDeepSeekConfig,
  createClaudeModelApiConfig,
  createCodexModelApiConfig,
  type ManagedTextFile
} from '../../app/main/ai-access/deepseek-config'
import {
  createClaudeExternalModelApiConfig,
  createCodexExternalModelApiConfig,
  externalModelApiProviders
} from '../../app/main/ai-access/external-model-api-config'

function files(initial: Readonly<Record<string, string>> = {}) {
  const data = new Map(Object.entries(initial))
  const io: ManagedTextFile = {
    read: async (path) => data.get(path),
    write: async (path, contents) => { data.set(path, contents) },
    remove: async (path) => { data.delete(path) },
    withConfigWriteLock: async (_lockPath, task) => task()
  }
  return { io, contents: (path: string) => data.get(path) }
}

describe('智谱两个产品与两个 Kimi 入口的本机模型 API 配置', () => {
  it('Codex 将智谱普通 API、Coding Plan、Kimi Code 与 Kimi 开放平台写入各自的端点和默认模型', async () => {
    const f = files()
    await createCodexDeepSeekConfig('/customer', f.io).apply('sk-toolbox-fixture-key-1234567890')

    expect(externalModelApiProviders).toEqual(['zhipu-api', 'zhipu', 'kimi', 'moonshot'])
    await createCodexExternalModelApiConfig('zhipu-api', '/customer', f.io).apply('zhipu-api-toolbox-fixture-key-1234567890')
    expect(f.contents('/customer/.codex/config.toml')).toContain('base_url = "https://open.bigmodel.cn/api/v1"')
    expect(f.contents('/customer/.codex/config.toml')).toContain('model = "glm-5.3-flash"')

    await createCodexExternalModelApiConfig('zhipu', '/customer', f.io).apply('zhipu-plan-toolbox-fixture-key-1234567890')
    expect(f.contents('/customer/.codex/config.toml')).toContain('base_url = "https://open.bigmodel.cn/api/v1"')
    expect(f.contents('/customer/.codex/config.toml')).toContain('model = "glm-5.3-flash"')
    expect(f.contents('/customer/.codex/config.toml')).not.toContain('model = "deepseek-flash"')

    await createCodexExternalModelApiConfig('kimi', '/customer', f.io).apply('sk-kimi-toolbox-fixture-key-1234567890')
    expect(f.contents('/customer/.codex/config.toml')).toContain('base_url = "https://api.kimi.com/coding/v1"')
    expect(f.contents('/customer/.codex/config.toml')).toContain('model = "kimi-for-coding"')

    await createCodexExternalModelApiConfig('moonshot', '/customer', f.io).apply('moonshot-toolbox-fixture-key-1234567890')
    expect(f.contents('/customer/.codex/config.toml')).toContain('base_url = "https://api.moonshot.cn/v1"')
    expect(f.contents('/customer/.codex/config.toml')).toContain('model = "kimi-k3"')

    await createCodexDeepSeekConfig('/customer', f.io).apply('sk-toolbox-fixture-key-abcdef1234567890')
    expect(f.contents('/customer/.codex/config.toml')).toContain('model = "deepseek-flash"')
    expect(JSON.parse(f.contents('/customer/.codex/laixin-models.json')!)).toMatchObject({ models: [{ slug: 'deepseek-flash' }] })
  })

  it('Claude Code 将智谱普通 API、Coding Plan、Kimi Code 和 Kimi 开放平台分开写入各自的端点和模型', async () => {
    const f = files()
    await createClaudeDeepSeekConfig('/customer', f.io).apply('sk-toolbox-fixture-key-1234567890')

    await createClaudeExternalModelApiConfig('zhipu-api', '/customer', f.io).apply('zhipu-api-toolbox-fixture-key-1234567890')
    const zhipuApi = f.contents('/customer/.claude/settings.json')!
    expect(zhipuApi).toContain('https://open.bigmodel.cn/api/anthropic')
    expect(zhipuApi).toContain('glm-5.3-flash')
    expect(zhipuApi).toContain('zhipu-api-toolbox-fixture-key-1234567890')

    await createClaudeExternalModelApiConfig('zhipu', '/customer', f.io).apply('zhipu-plan-toolbox-fixture-key-1234567890')
    const zhipuPlan = f.contents('/customer/.claude/settings.json')!
    expect(zhipuPlan).toContain('https://open.bigmodel.cn/api/anthropic')
    expect(zhipuPlan).toContain('glm-5.3-flash')
    expect(zhipuPlan).toContain('zhipu-plan-toolbox-fixture-key-1234567890')

    await createClaudeExternalModelApiConfig('kimi', '/customer', f.io).apply('sk-kimi-toolbox-fixture-key-1234567890')
    const kimi = f.contents('/customer/.claude/settings.json')!
    expect(kimi).toContain('https://api.kimi.com/coding/')
    expect(kimi).toContain('ANTHROPIC_API_KEY')
    expect(kimi).toContain('kimi-for-coding')
    expect(kimi).toContain('1048576')

    await createClaudeExternalModelApiConfig('moonshot', '/customer', f.io).apply('moonshot-toolbox-fixture-key-1234567890')
    const moonshot = f.contents('/customer/.claude/settings.json')!
    expect(moonshot).toContain('https://api.moonshot.cn/anthropic')
    expect(moonshot).toContain('kimi-k3')
    expect(moonshot).toContain('kimi-k2.7-code')
  })

  it('本地 API 服务连接只接受回环地址，并使用该服务的客户令牌而非上游 Key', async () => {
    const f = files()
    const localToken = 'local-toolbox-token-1234567890'
    await createCodexModelApiConfig('moonshot', '/customer', f.io, {
      baseUrl: 'http://127.0.0.1:19361/codex/moonshot/v1', apiKey: localToken, model: 'kimi-k3'
    }).apply('moonshot-upstream-key-that-must-not-be-written')
    expect(f.contents('/customer/.codex/config.toml')).toContain(localToken)
    expect(f.contents('/customer/.codex/config.toml')).not.toContain('moonshot-upstream-key-that-must-not-be-written')

    await createClaudeModelApiConfig('moonshot', '/customer', f.io, {
      baseUrl: 'http://127.0.0.1:19361/claude/moonshot', apiKey: localToken, model: 'kimi-k3'
    }).apply('moonshot-upstream-key-that-must-not-be-written')
    expect(f.contents('/customer/.claude/settings.json')).toContain('http://127.0.0.1:19361/claude/moonshot')
    expect(f.contents('/customer/.claude/settings.json')).toContain(localToken)
  })
})

import { describe, expect, it } from 'vitest'
import {
  createClaudeDeepSeekConfig,
  createCodexDeepSeekConfig,
  createHermesDeepSeekConfig,
  createCodexModelApiConfig,
  createClaudeModelApiConfig,
  type ManagedTextFile
} from '../../app/main/ai-access/deepseek-config'
import { modelProvider } from '../../app/shared/model-providers'

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

describe('DeepSeek 原生配置', () => {
  it('选择较小窗口模型时同步 Codex 模型目录和 Claude 上下文限制，不沿用旧默认模型', async () => {
    const f = files()
    const connection = { baseUrl: 'http://127.0.0.1:19361/codex/kimi/v1', apiKey: 'local-fixture-token-123456789', model: 'k3-256k' }
    await createCodexModelApiConfig('kimi', '/customer', f.io, connection).apply('')
    expect(f.contents('/customer/.codex/config.toml')).toContain('model = "k3-256k"')
    expect(JSON.parse(f.contents('/customer/.codex/laixin-models.json')!)).toMatchObject({ models: [{ slug: 'k3-256k', context_window: 262_144, max_context_window: 262_144 }] })
    await createClaudeModelApiConfig('kimi', '/customer', f.io, { ...connection, baseUrl: 'http://127.0.0.1:19361/claude/kimi' }).apply('')
    expect(JSON.parse(f.contents('/customer/.claude/settings.json')!)).toMatchObject({ env: {
      ANTHROPIC_MODEL: 'k3-256k',
      // Local routing may select an allowed request model, but the explicit small/fast slots
      // are product contracts and must never inherit a gateway-selected model.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelProvider('kimi').claude.smallModel,
      ANTHROPIC_SMALL_FAST_MODEL: modelProvider('kimi').claude.smallModel,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1'
    } })
  })
  it('Codex 使用独立模型目录，保留原有设置和模型目录，并在回官方时逐字恢复', async () => {
    const configPath = '/customer/.codex/config.toml'
    const originalConfig = 'model = "gpt-5.5"\nweb_search = "live"\napproval_policy = "on-request"\n\n[projects."/customer"] # customer overrides\nmodel = "project-model"\n\n[model_providers.customer]\nbase_url = "https://example.test/v1"\n'
    const originalModels = '{"models":[{"slug":"customer-model"}]}\n'
    const f = files({ [configPath]: originalConfig, '/customer/.codex/models.json': originalModels })
    const config = createCodexDeepSeekConfig('/customer', f.io)
    await config.apply('sk-toolbox-fixture-key-1234567890')
    const first = f.contents(configPath)!
    expect(first).toContain('model = "deepseek-flash"')
    expect(first).toContain('base_url = "https://api.deepseek.com/"')
    expect(first).toContain('wire_api = "responses"')
    expect(first).toContain('model_catalog_json = "/customer/.codex/laixin-models.json"')
    expect(first).toContain('web_search = "live"')
    expect(first).toContain('approval_policy = "on-request"')
    expect(first).toContain('[projects."/customer"] # customer overrides\nmodel = "project-model"')
    expect(first).toContain('[model_providers.customer]')
    expect(first.indexOf('approval_policy = "on-request"')).toBeLessThan(first.indexOf('[model_providers.laixin-deepseek]'))
    expect(first).toContain('sk-toolbox-fixture-key-1234567890')
    expect(JSON.parse(f.contents('/customer/.codex/laixin-models.json')!)).toMatchObject({
      models: [{
        slug: 'deepseek-flash', context_window: 1_048_576, supported_in_api: true, support_verbosity: false,
        experimental_supported_tools: [], base_instructions: ''
      }]
    })
    expect(f.contents('/customer/.codex/models.json')).toBe(originalModels)

    await config.apply('sk-toolbox-fixture-key-abcdef1234567890')
    const second = f.contents(configPath)!
    expect(second).toContain('sk-toolbox-fixture-key-abcdef1234567890')
    expect(second).not.toContain('sk-toolbox-fixture-key-1234567890')
    expect(JSON.parse(f.contents('/customer/.codex/laixin-models.json')!)).toMatchObject({ models: [{ slug: 'deepseek-flash' }] })

    await config.restoreOfficial()
    expect(f.contents(configPath)).toBe(originalConfig)
    expect(f.contents('/customer/.codex/models.json')).toBe(originalModels)
    expect(f.contents('/customer/.codex/laixin-models.json')).toBeUndefined()
    expect(f.contents('/customer/.codex/laixin-model-api-backup.json')).toBeUndefined()
  })

  it('Claude Code 只替换自己的环境字段，并在期间有新设置时保留它们', async () => {
    const path = '/customer/.claude/settings.json'
    const original = '{\n  "theme": "dark",\n  "env": {\n    "CUSTOMER_SETTING": "keep",\n    "ANTHROPIC_BASE_URL": "https://official.example",\n    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "customer-model"\n  }\n}\n'
    const f = files({ [path]: original })
    const config = createClaudeDeepSeekConfig('/customer', f.io)
    await config.apply('sk-toolbox-fixture-key-1234567890')
    const current = f.contents(path)!
    expect(current).toContain('ANTHROPIC_BASE_URL')
    expect(current).toContain('https://api.deepseek.com/anthropic')
    expect(current).toContain('ANTHROPIC_MODEL')
    expect(current).toContain('CLAUDE_CODE_SUBAGENT_MODEL')
    expect(current).toContain('"CLAUDE_CODE_EFFORT_LEVEL": "max"')
    expect(current).toContain('sk-toolbox-fixture-key-1234567890')
    expect(current).toContain('CUSTOMER_SETTING')
    expect(current).not.toContain('customer-model')
    const changed = JSON.parse(current) as { env: Record<string, string>; hooks?: unknown }
    changed.env.AFTER_SWITCH = 'keep-too'
    changed.hooks = { SessionStart: [{ command: 'customer-script' }] }
    await f.io.write(path, `${JSON.stringify(changed, null, 2)}\n`)

    await config.restoreOfficial()
    expect(JSON.parse(f.contents(path)!)).toMatchObject({
      theme: 'dark', hooks: { SessionStart: [{ command: 'customer-script' }] },
      env: { CUSTOMER_SETTING: 'keep', AFTER_SWITCH: 'keep-too', ANTHROPIC_BASE_URL: 'https://official.example', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'customer-model' }
    })
    expect(f.contents('/customer/.claude/laixin-model-api-backup.json')).toBeUndefined()
  })

  it('Claude 明确恢复接入前配置时恢复 CC Switch 备份，但不覆盖客户新写的第三方连接', async () => {
    const path = '/customer/.claude/settings.json'
    const backupPath = '/customer/.claude/laixin-model-api-backup.json'
    const original = `${JSON.stringify({
      permissions: { allow: ['Bash'] },
      env: {
        CUSTOMER_SETTING: 'keep',
        ANTHROPIC_BASE_URL: 'https://cc-switch.example/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'fixture-cc-switch-key-1234567890',
        ANTHROPIC_MODEL: 'customer-route-model',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'customer-small-model'
      }
    }, null, 2)}\n`
    const f = files({ [path]: original })
    const config = createClaudeModelApiConfig('deepseek', '/customer', f.io, {
      baseUrl: 'http://127.0.0.1:19361/claude/deepseek', apiKey: 'local-toolbox-token-123456789'
    })

    await config.apply('')
    await config.restorePreviousConnection()
    expect(f.contents(path)).toBe(original)
    expect(f.contents(backupPath)).toBeUndefined()

    const changed = files({ [path]: original })
    const changedConfig = createClaudeModelApiConfig('deepseek', '/customer', changed.io, {
      baseUrl: 'http://127.0.0.1:19361/claude/deepseek', apiKey: 'local-toolbox-token-123456789'
    })
    await changedConfig.apply('')
    const externallyChanged = `${JSON.stringify({ permissions: { allow: ['Bash', 'Read'] }, env: { CUSTOMER_SETTING: 'keep' } }, null, 2)}\n`
    await changed.io.write(path, externallyChanged)

    await expect(changedConfig.restorePreviousConnection()).rejects.toThrow('AI_ACCESS_CONFIG_NOT_MANAGED')
    expect(changed.contents(path)).toBe(externallyChanged)
    expect(changed.contents(backupPath)).toBeDefined()
  })

  it('Claude 接管期间只重排同一份 JSON 键序，仍可恢复明确备份', async () => {
    const path = '/customer/.claude/settings.json'
    const original = `${JSON.stringify({ permissions: { allow: ['Bash'] }, env: {
      CUSTOMER_SETTING: 'keep', SECOND_CUSTOMER_SETTING: 'also-keep',
      ANTHROPIC_BASE_URL: 'https://cc-switch.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'fixture-cc-switch-key-1234567890',
      ANTHROPIC_MODEL: 'customer-route-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'customer-small-model'
    } }, null, 2)}\n`
    const f = files({ [path]: original })
    const config = createClaudeModelApiConfig('deepseek', '/customer', f.io, {
      baseUrl: 'http://127.0.0.1:19361/claude/deepseek', apiKey: 'local-toolbox-token-123456789'
    })
    await config.apply('')
    const applied = JSON.parse(f.contents(path)!) as { permissions: unknown; env: Record<string, string> }
    await f.io.write(path, `${JSON.stringify({
      env: Object.fromEntries(Object.entries(applied.env).reverse()), permissions: applied.permissions
    }, null, 2)}\n`)

    await config.restorePreviousConnection()
    expect(f.contents(path)).toBe(original)
  })

  it('Codex 明确恢复接入前配置时不覆盖客户新写的第三方连接', async () => {
    const path = '/customer/.codex/config.toml'
    const backupPath = '/customer/.codex/laixin-model-api-backup.json'
    const original = `model = "cc-switch-model"
model_provider = "cc-switch"
approval_policy = "on-request"

[model_providers.cc-switch]
base_url = "https://cc-switch.example/v1"
`
    const connection = { baseUrl: 'http://127.0.0.1:19361/codex/deepseek/v1', apiKey: 'local-toolbox-token-123456789', model: 'deepseek-flash' }
    const exact = files({ [path]: original })
    const exactConfig = createCodexModelApiConfig('deepseek', '/customer', exact.io, connection)
    await exactConfig.apply('')
    await exactConfig.restorePreviousConnection()
    expect(exact.contents(path)).toBe(original)

    const changed = files({ [path]: original })
    const changedConfig = createCodexModelApiConfig('deepseek', '/customer', changed.io, connection)
    await changedConfig.apply('')
    const manualConnection = `model = "customer-new-model"
model_provider = "cc-switch"
approval_policy = "on-request"

[model_providers.cc-switch]
base_url = "https://cc-switch.example/v1"
`
    await changed.io.write(path, manualConnection)

    await expect(changedConfig.restorePreviousConnection()).rejects.toThrow('AI_ACCESS_CONFIG_NOT_MANAGED')
    expect(changed.contents(path)).toBe(manualConnection)
    expect(changed.contents(backupPath)).toBeDefined()
  })

  it('已有的 Codex 和 Claude 配置会先保存，回官方后恢复原文', async () => {
    const codexPath = '/customer/.codex/config.toml'
    const claudePath = '/customer/.claude/settings.json'
    const f = files({ [codexPath]: 'model = "someone-else"\n', [claudePath]: '{"env":{"OTHER":"value"}}\n' })

    const codex = createCodexDeepSeekConfig('/customer', f.io)
    const claude = createClaudeDeepSeekConfig('/customer', f.io)
    await codex.apply('sk-toolbox-fixture-key-1234567890')
    await claude.apply('sk-toolbox-fixture-key-1234567890')
    await codex.restoreOfficial()
    await claude.restoreOfficial()

    expect(f.contents(codexPath)).toBe('model = "someone-else"\n')
    expect(f.contents(claudePath)).toBe('{"env":{"OTHER":"value"}}\n')
  })

  it('手动配置的现代 Anthropic 兼容入口不被误判为旧工具箱配置', async () => {
    const path = '/customer/.claude/settings.json'
    const original = `${JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'customer-modern-token-1234567890',
      ANTHROPIC_MODEL: 'glm-5.2', ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.2', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2', CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.2',
      CLAUDE_CODE_EFFORT_LEVEL: 'max'
    } }, null, 2)}\n`
    const f = files({ [path]: original })
    const config = createClaudeDeepSeekConfig('/customer', f.io)
    await config.apply('sk-toolbox-fixture-key-1234567890')
    await config.restoreOfficial()
    expect(f.contents(path)).toBe(original)
  })

  it('会把旧工具箱的 deepseek-v4-flash 配置迁移为当前模型，不触碰旧的公共模型目录', async () => {
    const codexPath = '/customer/.codex/config.toml'
    const legacy = '# Managed by Laixin AI Toolbox: DeepSeek connection\nmodel = "deepseek-v4-flash"\nmodel_provider = "deepseek"\npreferred_auth_method = "apikey"\nforced_login_method = "api"\nmodel_reasoning_effort = "high"\nweb_search = "disabled"\nmodel_catalog_json = "~/.codex/models.json"\n\n[model_providers.deepseek]\nname = "deepseek"\nbase_url = "https://api.deepseek.com/"\nwire_api = "responses"\nexperimental_bearer_token = "sk-toolbox-fixture-key-1234567890"\n'
    const oldCatalog = '{"models":[{"slug":"deepseek-v4-flash"}]}\n'
    const f = files({ [codexPath]: legacy, '/customer/.codex/models.json': oldCatalog })
    const config = createCodexDeepSeekConfig('/customer', f.io)

    await config.apply('sk-toolbox-fixture-key-abcdef1234567890')
    expect(f.contents(codexPath)).toContain('deepseek-flash')
    expect(f.contents('/customer/.codex/models.json')).toBe(oldCatalog)
    await config.restoreOfficial()
    expect(f.contents(codexPath)).toBeUndefined()
    expect(f.contents('/customer/.codex/models.json')).toBe(oldCatalog)
  })

  it('遇到无法安全分段的多行 TOML 字符串时拒绝写入', async () => {
    const configPath = '/customer/.codex/config.toml'
    const original = 'developer_instructions = """\nkeep this untouched\n"""\n'
    const f = files({ [configPath]: original })
    await expect(createCodexDeepSeekConfig('/customer', f.io).apply('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(f.contents(configPath)).toBe(original)
  })

  it('写入失败或读回不一致时回滚，不留下部分配置', async () => {
    const configPath = '/customer/.codex/config.toml'
    const f = files()
    const failing: ManagedTextFile = {
      read: f.io.read,
      write: async (path, contents) => {
        if (path === configPath) throw new Error('disk full')
        await f.io.write(path, contents)
      },
      remove: f.io.remove,
      withConfigWriteLock: f.io.withConfigWriteLock
    }
    await expect(createCodexDeepSeekConfig('/customer', failing).apply('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_CONFIG_TRANSACTION_FAILED')
    expect(f.contents(configPath)).toBeUndefined()
    expect(f.contents('/customer/.codex/laixin-models.json')).toBeUndefined()
    expect(f.contents('/customer/.codex/laixin-model-api-backup.json')).toBeUndefined()

    const readback = files()
    let staleRead = false
    const unreadable: ManagedTextFile = {
      read: async (path) => staleRead && path === configPath ? 'stale readback' : readback.io.read(path),
      write: async (path, contents) => {
        await readback.io.write(path, contents)
        if (path === configPath) staleRead = true
      },
      remove: readback.io.remove,
      withConfigWriteLock: readback.io.withConfigWriteLock
    }
    await expect(createCodexDeepSeekConfig('/customer', unreadable).apply('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_CONFIG_TRANSACTION_FAILED')
    expect(readback.contents('/customer/.codex/laixin-models.json')).toBeUndefined()
    expect(readback.contents('/customer/.codex/laixin-model-api-backup.json')).toBeUndefined()
  })

  it('Hermes 保留不冲突的客户环境变量，只替换自己的连接块', async () => {
    const hermesPath = '/customer/.hermes/.env'
    const hermesFixture = files()
    await createHermesDeepSeekConfig('/customer', hermesFixture.io).apply('sk-toolbox-fixture-key-1234567890')
    const hermesChanged = `${hermesFixture.contents(hermesPath)!}CUSTOMER_SETTING=true\n`
    const customerFiles = files({ [hermesPath]: hermesChanged })

    await createHermesDeepSeekConfig('/customer', customerFiles.io).apply('sk-toolbox-fixture-key-abcdef1234567890')
    expect(customerFiles.contents(hermesPath)).toContain('CUSTOMER_SETTING=true')
    expect(customerFiles.contents(hermesPath)).toContain('sk-toolbox-fixture-key-abcdef1234567890')
    await createHermesDeepSeekConfig('/customer', customerFiles.io).restoreOfficial()

    expect(customerFiles.contents(hermesPath)).toBe('CUSTOMER_SETTING=true')
  })

  it('Hermes 使用它自己的 .env，保留非工具箱文件不动', async () => {
    const f = files()
    const config = createHermesDeepSeekConfig('/customer', f.io)
    await config.apply('sk-toolbox-fixture-key-1234567890')
    const path = '/customer/.hermes/.env'
    expect(f.contents(path)).toContain('DEEPSEEK_API_KEY=sk-toolbox-fixture-key-1234567890')
    expect(f.contents(path)).toContain('DEEPSEEK_BASE_URL=https://api.deepseek.com')

    const existing = files({ [path]: 'DEEPSEEK_API_KEY=another-customer-key\n' })
    await expect(createHermesDeepSeekConfig('/customer', existing.io).apply('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
  })

  it('Hermes 同名标记只有完整工具箱语义时才能替换或删除，不能吞掉 CC Switch 环境块', async () => {
    const path = '/customer/.hermes/.env'
    const external = `CUSTOMER_SETTING=true
# >>> Laixin AI Toolbox managed model connection >>>
DEEPSEEK_API_KEY=external-customer-key-1234567890
DEEPSEEK_BASE_URL=https://cc-switch.example/v1
# <<< Laixin AI Toolbox managed model connection <<<
`
    const f = files({ [path]: external })
    const config = createHermesDeepSeekConfig('/customer', f.io)

    await expect(config.apply('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    await expect(config.deactivateToolboxConnection()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    await expect(config.restorePreviousConnection()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(f.contents(path)).toBe(external)
  })
})

describe('托管段被整段删掉之后（CC Switch 整文件重写、客户手工清理）', () => {
  const connection = { baseUrl: 'http://127.0.0.1:19361/codex/deepseek/v1', apiKey: 'local-fixture-token-123456789' }
  const claudeConnection = { baseUrl: 'http://127.0.0.1:19361/claude/deepseek', apiKey: 'local-fixture-token-123456789' }

  it('Codex：「重新写入配置」要能把托管段重建回去，客户自己的内容原样留着', async () => {
    const f = files()
    const config = createCodexModelApiConfig('deepseek', '/customer', f.io, connection)
    await config.apply('')
    expect(f.contents('/customer/.codex/config.toml')).toContain('Laixin AI Toolbox managed')
    // 托管段被整段删掉，客户自己的设置还在；备份文件也还在。
    f.io.write('/customer/.codex/config.toml', 'approval_policy = "on-request"\n\n[mcp_servers.mine]\ncommand = "x"\n')
    expect(f.contents('/customer/.codex/laixin-model-api-backup.json')).toBeDefined()

    await expect(config.apply('')).resolves.toBeUndefined()
    const rebuilt = f.contents('/customer/.codex/config.toml')!
    expect(rebuilt).toContain('Laixin AI Toolbox managed')
    expect(rebuilt).toContain('[mcp_servers.mine]')
  })

  it('Codex：托管段没了再点「恢复官方」，当已恢复直接完成并清掉附属文件，⛔ 去改客户现在这份配置', async () => {
    const f = files()
    const config = createCodexModelApiConfig('deepseek', '/customer', f.io, connection)
    await config.apply('')
    const untouched = 'approval_policy = "on-request"\n'
    f.io.write('/customer/.codex/config.toml', untouched)

    await expect(config.restoreOfficial()).resolves.toBeUndefined()
    expect(f.contents('/customer/.codex/config.toml')).toBe(untouched)
    expect(f.contents('/customer/.codex/laixin-model-api-backup.json')).toBeUndefined()
    expect(f.contents('/customer/.codex/laixin-models.json')).toBeUndefined()
  })

  it('Claude：同样能重建，也能直接恢复官方', async () => {
    const f = files()
    const config = createClaudeModelApiConfig('deepseek', '/customer', f.io, claudeConnection)
    await config.apply('')
    f.io.write('/customer/.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash'] } }))

    await expect(config.apply('')).resolves.toBeUndefined()
    const rebuilt = JSON.parse(f.contents('/customer/.claude/settings.json')!) as { env?: Record<string, string>; permissions?: unknown }
    expect(rebuilt.env?.ANTHROPIC_BASE_URL).toBe(claudeConnection.baseUrl)
    expect(rebuilt.permissions).toEqual({ allow: ['Bash'] })

    const untouchedClaude = JSON.stringify({ permissions: { allow: ['Bash'] } })
    f.io.write('/customer/.claude/settings.json', untouchedClaude)
    await expect(config.restoreOfficial()).resolves.toBeUndefined()
    expect(f.contents('/customer/.claude/settings.json')).toBe(untouchedClaude)
    expect(f.contents('/customer/.claude/laixin-model-api-backup.json')).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import {
  createClaudeModelApiConfig,
  createCodexModelApiConfig,
  inspectModelApiBackup,
  type ManagedTextFile
} from '../../app/main/ai-access/deepseek-config'
import { parseCodexTomlDocument } from '../../app/main/ai-access/codex-toml-document'

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

const connection = {
  baseUrl: 'http://127.0.0.1:19361/codex/deepseek/v1', apiKey: 'local-fixture-token-123456789', model: 'deepseek-v4-flash'
}

describe('配置修复事务', () => {
  it('CC Switch 整段重写后重新写入只接回工具箱连接，保留新外部表且不产生重复 TOML 表', async () => {
    const path = '/customer/.codex/config.toml'
    const beforeToolbox = `model = "cc-switch-model"
model_provider = "cc-switch"

[model_providers.cc-switch]
base_url = "https://cc-switch.example/v1"
`
    const rewritten = `model = "cc-switch-new-model"
model_provider = "cc-switch"

[model_providers.cc-switch]
base_url = "https://cc-switch-new.example/v1"
`
    const f = files({ [path]: beforeToolbox })
    const config = createCodexModelApiConfig('deepseek', '/customer', f.io, connection)
    await config.apply('')
    await f.io.write(path, rewritten)

    await config.apply('')
    const repaired = f.contents(path)!
    expect(() => parseCodexTomlDocument(repaired)).not.toThrow()
    expect(repaired).toContain('[model_providers.cc-switch]\nbase_url = "https://cc-switch-new.example/v1"')
    expect(repaired.split('[model_providers.laixin-deepseek-local]')).toHaveLength(2)
    expect(JSON.parse(f.contents('/customer/.codex/laixin-model-api-backup.json')!)).toMatchObject({ original: beforeToolbox })
  })

  it('解除 Codex 工具箱接管恢复 CC Switch 顶层键和原始配置，并清理工具箱附属文件', async () => {
    const path = '/customer/.codex/config.toml'
    const ccSwitch = `model = "cc-switch-model"
model_provider = "cc-switch"
model_reasoning_effort = "high"

[model_providers.cc-switch]
base_url = "https://cc-switch.example/v1"

[mcp_servers.customer-tool]
command = "customer-tool"
`
    const f = files({ [path]: ccSwitch })
    const config = createCodexModelApiConfig('deepseek', '/customer', f.io, connection)
    await config.apply('')

    await config.deactivateToolboxConnection()
    expect(f.contents(path)).toBe(ccSwitch)
    expect(f.contents('/customer/.codex/laixin-models.json')).toBeUndefined()
    expect(f.contents('/customer/.codex/laixin-model-api-backup.json')).toBeUndefined()
  })

  it('解除 Claude 工具箱接管恢复 CC Switch 环境字段和原始配置，并清理工具箱附属文件', async () => {
    const path = '/customer/.claude/settings.json'
    const ccSwitch = `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://cc-switch.example/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'fixture-cc-switch-key-1234567890',
        ANTHROPIC_MODEL: 'customer-route-model'
      },
      permissions: { allow: ['Bash(git status:*)'] },
      statusLine: { type: 'command', command: 'customer-status' }
    }, null, 2)}\n`
    const f = files({ [path]: ccSwitch })
    const config = createClaudeModelApiConfig('deepseek', '/customer', f.io, {
      baseUrl: 'http://127.0.0.1:19361/claude/deepseek', apiKey: 'local-fixture-token-123456789', model: 'deepseek-v4-flash'
    })
    await config.apply('')

    await config.deactivateToolboxConnection()
    expect(f.contents(path)).toBe(ccSwitch)
    expect(f.contents('/customer/.claude/laixin-model-api-backup.json')).toBeUndefined()
  })

  it('明确恢复接入前配置仍从有效备份恢复并清理附属文件', async () => {
    const path = '/customer/.codex/config.toml'
    const ccSwitch = `model = "cc-switch-model"
model_provider = "cc-switch"

[model_providers.cc-switch]
base_url = "https://cc-switch.example/v1"
`
    const f = files({ [path]: ccSwitch })
    const config = createCodexModelApiConfig('deepseek', '/customer', f.io, connection)
    await config.apply('')

    await config.restorePreviousConnection()
    expect(f.contents(path)).toBe(ccSwitch)
    expect(f.contents('/customer/.codex/laixin-models.json')).toBeUndefined()
    expect(f.contents('/customer/.codex/laixin-model-api-backup.json')).toBeUndefined()
  })

  it('损坏备份不会被当成缺失备份覆盖；可以安全解除工具箱接管但不能伪造恢复', async () => {
    const path = '/customer/.codex/config.toml'
    const backupPath = '/customer/.codex/laixin-model-api-backup.json'
    const f = files({
      [path]: `model = "deepseek-v4-flash"
model_provider = "laixin-deepseek-local"
forced_login_method = "api"
model_catalog_json = "/customer/.codex/laixin-models.json"

[model_providers.laixin-deepseek-local]
name = "Laixin Local API Service"
base_url = "http://127.0.0.1:19361/codex/deepseek/v1"
wire_api = "responses"
experimental_bearer_token = "local-fixture-token"
`,
      [backupPath]: '{not-json'
    })
    const config = createCodexModelApiConfig('deepseek', '/customer', f.io, connection)

    expect(inspectModelApiBackup(undefined)).toEqual({ kind: 'missing' })
    expect(inspectModelApiBackup('{not-json')).toEqual({ kind: 'corrupt' })
    await expect(config.apply('')).rejects.toThrow('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
    expect(f.contents(backupPath)).toBe('{not-json')
    expect(f.contents(path)).toContain('127.0.0.1:19361')

    await config.deactivateToolboxConnection()
    expect(f.contents(path) ?? '').not.toContain('127.0.0.1:19361')
    expect(f.contents(backupPath)).toBe('{not-json')
    await expect(config.restorePreviousConnection()).rejects.toThrow('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
  })

  it('重复表时事务不写备份、模型目录或配置本体', async () => {
    const path = '/customer/.codex/config.toml'
    const duplicate = `model = "cc-switch"

[model_providers.cc-switch]
base_url = "https://one.example/v1"

[model_providers.cc-switch]
base_url = "https://two.example/v1"
`
    const f = files({ [path]: duplicate })

    await expect(createCodexModelApiConfig('deepseek', '/customer', f.io, connection).apply('')).rejects.toThrow('AI_ACCESS_CONFIG_TOML_INVALID')
    expect(f.contents(path)).toBe(duplicate)
    expect(f.contents('/customer/.codex/laixin-model-api-backup.json')).toBeUndefined()
    expect(f.contents('/customer/.codex/laixin-models.json')).toBeUndefined()
  })

  it('解除工具箱路由不会删除 CC Switch 留下的 auth.json，但会标明仍需 ChatGPT 官方登录', async () => {
    const path = '/customer/.codex/config.toml'
    const authPath = '/customer/.codex/auth.json'
    const auth = JSON.stringify({ OPENAI_API_KEY: 'fixture-third-party-api-key' })
    const f = files({ [authPath]: auth })
    const config = createCodexModelApiConfig('deepseek', '/customer', f.io, connection)

    await config.apply('')
    expect(f.contents(path)).not.toContain('preferred_auth_method')
    expect(f.contents(path)).toContain('forced_login_method = "api"')

    await config.deactivateToolboxConnection()
    expect(f.contents(path) ?? '').not.toContain('forced_login_method')
    expect(f.contents(authPath)).toBe(auth)
    await expect(config.officialAuthenticationStatus!()).resolves.toEqual({ state: 'login-required', reason: 'other-tool-api-key' })
  })
})

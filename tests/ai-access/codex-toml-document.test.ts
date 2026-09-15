import { describe, expect, it } from 'vitest'
import { parseCodexTomlDocument } from '../../app/main/ai-access/codex-toml-document'

const replacement = `# >>> Laixin AI Toolbox managed model connection >>>
# Provider: deepseek
model = "deepseek-v4-flash"
model_provider = "laixin-deepseek-local"
forced_login_method = "api"
model_reasoning_effort = "high"
model_catalog_json = "/customer/.codex/laixin-models.json"

[model_providers.laixin-deepseek-local]
name = "Laixin Local API Service"
base_url = "http://127.0.0.1:19361/codex/deepseek/v1"
wire_api = "responses"
experimental_bearer_token = "local-fixture-token"
# <<< Laixin AI Toolbox managed model connection <<<
`

describe('Codex TOML 安全文档', () => {
  it('无注释的工具箱语义段和引号顶层键会被替换成唯一的受管段', () => {
    const current = `"model" = "old-model"
model_provider = "laixin-deepseek-local"
forced_login_method = "api"
model_catalog_json = "/customer/.codex/laixin-models.json"

[model_providers."laixin-deepseek-local"]
name = "Laixin Local API Service"
base_url = "http://127.0.0.1:19000/codex/deepseek/v1"
wire_api = "responses"
experimental_bearer_token = "old-local-token"

[projects."/customer"]
model = "project-model"
`
    const document = parseCodexTomlDocument(current)

    expect(document.toolboxConnection).toMatchObject({ provider: 'laixin-deepseek-local' })
    const next = document.replaceToolboxConnection(replacement)
    const reparsed = parseCodexTomlDocument(next)

    expect(reparsed.toolboxConnection).toMatchObject({ provider: 'laixin-deepseek-local' })
    expect(next).not.toContain('"model" =')
    expect(next).toContain('model = "deepseek-v4-flash"')
    expect(next.match(/^\s*\[model_providers(?:\.|\.)"?laixin-deepseek-local"?\]/gm)).toHaveLength(1)
    expect(next).toContain('[projects."/customer"]\nmodel = "project-model"')
  })

  it('重复普通表会在写入前被拒绝，不能把无效 TOML 改成半成品', () => {
    const duplicate = `model = "cc-switch"

[model_providers.cc-switch]
base_url = "https://one.example/v1"

[model_providers.cc-switch]
base_url = "https://two.example/v1"
`

    expect(() => parseCodexTomlDocument(duplicate)).toThrow('AI_ACCESS_CONFIG_TOML_INVALID')
  })

  it('同名标记包住的非工具箱连接不会被替换或删除', () => {
    const external = `# >>> Laixin AI Toolbox managed model connection >>>
model = "cc-switch-model"
model_provider = "cc-switch"
forced_login_method = "api"

[model_providers.cc-switch]
base_url = "https://cc-switch.example/v1"
experimental_bearer_token = "external-token"
# <<< Laixin AI Toolbox managed model connection <<<
`
    const document = parseCodexTomlDocument(external)

    expect(document.toolboxConnection).toBeUndefined()
    expect(() => document.removeToolboxConnection()).toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(() => document.replaceToolboxConnection(replacement)).toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(external).toContain('cc-switch.example')
  })
})

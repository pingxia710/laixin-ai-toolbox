import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedTextFile } from '../../app/main/ai-access/file'
import { deactivateCodexWorkspaceProviders, installCodexWorkspaceProviders, readCodexWorkspaceCatalogStatus, type CodexWorkspaceOfficialModel } from '../../app/main/ai-access/codex-workspace-config'
import { modelProviders, providerModelWindow } from '../../app/shared/model-providers'
import { createCodexModelApiConfig, type ManagedTextFile } from '../../app/main/ai-access/deepseek-config'

let root = ''
const multiModel = {
  baseUrl: 'http://127.0.0.1:43210/codex/multi/v1',
  model: 'laixin.deepseek.deepseek-flash',
  models: ['laixin.deepseek.deepseek-flash', 'laixin.zhipu-api.glm-5.3-flash']
}
const officialModels = [officialModel('gpt-6-astra', 'GPT-6-Astra', 'low'), officialModel('gpt-6-sol', 'GPT-6-Sol', 'medium')]
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })

describe('Codex 来信多模型 provider 配置', () => {
  it('真实目录按精确模型沿用接入资料，窗口不统一缩成 64K，图片能力保留', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-catalog-capabilities-'))
    const models = ['laixin.deepseek.deepseek-v4-pro', 'laixin.kimi.k3-256k', 'laixin.moonshot.kimi-k3']
    const options = { codexHome: root, toolboxExecutable: '/toolbox', multiModel: { ...multiModel, model: models[0], models }, officialModels, file: createManagedTextFile() }
    await installCodexWorkspaceProviders(options)
    const path = join(root, 'laixin-multi-models.json')
    const catalog = JSON.parse(await readFile(path, 'utf8')) as { models: Array<Record<string, unknown>> }
    for (const [slug, provider, model] of [
      [models[0], 'deepseek', 'deepseek-v4-pro'], [models[1], 'kimi', 'k3-256k'], [models[2], 'moonshot', 'kimi-k3']
    ] as const) {
      expect(catalog.models.find(entry => entry.slug === slug)).toMatchObject({
        context_window: providerModelWindow(provider, model), max_context_window: providerModelWindow(provider, model),
        input_modalities: modelProviders[provider].codex.inputModalities
      })
    }
    expect(catalog.models.slice(0, officialModels.length)).toEqual(officialModels.map(model => model.catalog))
    expect((await readCodexWorkspaceCatalogStatus(options)).state).toBe('written')
    const stale = catalog.models.find(entry => entry.slug === models[0])!
    stale.context_window = 65536
    stale.max_context_window = 65536
    await writeFile(path, JSON.stringify(catalog))
    expect((await readCodexWorkspaceCatalogStatus(options)).state).toBe('modified')
  })

  it('未知内部模型不能伪造通用能力并写入目录', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-catalog-unknown-'))
    const original = '# customer\nmodel = "gpt-fixture"\n'
    await writeFile(join(root, 'config.toml'), original)
    const models = ['laixin.deepseek.unknown-model']
    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox',
      multiModel: { ...multiModel, model: models[0], models }, officialModels, file: createManagedTextFile() })).rejects.toThrow('CODEX_MULTI_MODEL_CONNECTION_INVALID')
    expect(await readFile(join(root, 'config.toml'), 'utf8')).toBe(original)
  })

  it('只登记一个 laixin-multi provider，且只把本机网关地址与客户端令牌命令写入 Codex', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    await installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/Applications/Toolbox.app/Contents/MacOS/Toolbox', multiModel, officialModels, file: createManagedTextFile() })

    const result = await readFile(join(root, 'config.toml'), 'utf8')
    expect(result).toContain('[model_providers.laixin-multi]')
    expect(result).toContain('base_url = "http://127.0.0.1:43210/codex/multi/v1"')
    expect(result).toContain('args = ["--laixin-codex-provider-key", "multi"]')
    expect(result).toContain('refresh_interval_ms = 0')
    expect(result).toContain('timeout_ms = 20000')
    expect(result).toContain(`model_catalog_json = "${join(root, 'laixin-multi-models.json')}"`)
    await expect(readFile(join(root, 'laixin-multi-models.json'), 'utf8')).resolves.toMatch(/"gpt-6-astra"/)
    await expect(readFile(join(root, 'laixin-multi-models.json'), 'utf8')).resolves.toMatch(/"laixin\.deepseek\.deepseek-flash"/)
    const catalog = JSON.parse(await readFile(join(root, 'laixin-multi-models.json'), 'utf8')) as { models: Array<Record<string, unknown>> }
    expect(catalog.models.find(model => model.slug === 'gpt-6-astra')).toMatchObject({
      display_name: 'GPT-6-Astra', input_modalities: ['text', 'image'], default_reasoning_level: 'low', visibility: 'list'
    })
    expect(result).not.toContain('laixin-workspace-deepseek')
    expect(result).not.toContain('laixin-kimi-api')
    expect(result).not.toMatch(/sk-fixture|experimental_bearer_token/)
  })

  it('保留官方默认和第三方表，重复安装原地更新自有块而不改全局 model_provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    const config = join(root, 'config.toml')
    const original = `model = "gpt-fixture"\nmodel_provider = "openai"\n\n[projects."/customer"]\ntrust_level = "trusted"\n`
    await writeFile(config, original)
    const file = createManagedTextFile()
    await installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/old/toolbox', multiModel, officialModels, file })
    await installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: 'C:\\Program Files\\Laixin\\Toolbox.exe', multiModel: { ...multiModel, model: 'laixin.zhipu-api.glm-5.3-flash', models: ['laixin.zhipu-api.glm-5.3-flash'] }, officialModels, file })

    const result = await readFile(config, 'utf8')
    expect(result).toContain('model = "gpt-fixture"')
    expect(result).toContain('model_provider = "openai"')
    expect(result).toContain('[projects."/customer"]')
    expect(result).toContain('trust_level = "trusted"')
    expect(result.match(/\[model_providers\.laixin-multi\]/g)).toHaveLength(1)
    expect(result).toContain('command = "C:\\\\Program Files\\\\Laixin\\\\Toolbox.exe"')
    expect(result).not.toContain('/old/toolbox')
    expect(result).not.toMatch(/^model_provider\s*=\s*"laixin-multi"$/m)
  })

  it('升级时逐字保留旧固定来源 provider、客户注释和未知字段，官方 auth.json 不动', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-upgrade-'))
    const config = join(root, 'config.toml')
    const auth = join(root, 'auth.json')
    const legacy = `# >>> Laixin AI Toolbox managed Codex workspaces >>>
# Source: DeepSeek API
[model_providers.laixin-workspace-deepseek]
name = "DeepSeek"
base_url = "http://127.0.0.1:41001/v1"
wire_api = "responses"
[model_providers.laixin-workspace-deepseek.auth]
command = "/old/toolbox"
args = ["--laixin-codex-provider-key", "deepseek"]
refresh_interval_ms = 0
timeout_ms = 20000
# Source: Moonshot API
[model_providers.laixin-kimi-api]
name = "Kimi"
base_url = "http://127.0.0.1:41002/v1"
wire_api = "responses"
[model_providers.laixin-kimi-api.auth]
command = "/old/toolbox"
args = ["--laixin-codex-provider-key", "moonshot"]
refresh_interval_ms = 0
timeout_ms = 20000
# Source: Zhipu API
[model_providers.laixin-workspace-zhipu-api]
name = "Zhipu"
base_url = "http://127.0.0.1:41003/v1"
wire_api = "responses"
[model_providers.laixin-workspace-zhipu-api.auth]
command = "/old/toolbox"
args = ["--laixin-codex-provider-key", "zhipu-api"]
refresh_interval_ms = 0
timeout_ms = 20000
# <<< Laixin AI Toolbox managed Codex workspaces <<<`
    const original = `# customer's exact comment\nunknown_root = "keep-me"\n\n${legacy}\n\n[customer.extra]\norder = 7\n`
    const official = Buffer.from('{"tokens":{"access_token":"fixture-oauth"},"plan":"official"}\n')
    await writeFile(config, original)
    await writeFile(auth, official)

    await installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/new/toolbox', multiModel, officialModels, file: createManagedTextFile() })

    const result = await readFile(config, 'utf8')
    expect(result).toContain(legacy)
    expect(result).toContain('# customer\'s exact comment\nunknown_root = "keep-me"')
    expect(result.indexOf('unknown_root')).toBeLessThan(result.indexOf('[model_providers.laixin-workspace-deepseek]'))
    expect(result.indexOf('[model_providers.laixin-workspace-zhipu-api]')).toBeLessThan(result.indexOf('[customer.extra]'))
    expect(result).toContain('[model_providers.laixin-multi]')
    await expect(readFile(auth)).resolves.toEqual(official)
  })

  it('外部同名表、损坏自有标记和非本机地址均拒写并保留原文件', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    const config = join(root, 'config.toml')
    const collision = '[model_providers.laixin-multi]\nname = "customer"\n'
    await writeFile(config, collision)
    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', multiModel, officialModels, file: createManagedTextFile() })).rejects.toThrow()
    await expect(readFile(config, 'utf8')).resolves.toBe(collision)

    const customerCatalog = 'model_catalog_json = "/customer/catalog.json"\n'
    await writeFile(config, customerCatalog)
    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', multiModel, officialModels, file: createManagedTextFile() })).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    await expect(readFile(config, 'utf8')).resolves.toBe(customerCatalog)

    const broken = '# >>> Laixin AI Toolbox managed Codex workspaces >>>\n[model_providers.laixin-multi]\n'
    await writeFile(config, broken)
    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', multiModel, officialModels, file: createManagedTextFile() })).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    await expect(readFile(config, 'utf8')).resolves.toBe(broken)

    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', multiModel: { ...multiModel, baseUrl: 'https://proxy.invalid/v1' }, officialModels, file: createManagedTextFile() })).rejects.toThrow('CODEX_MULTI_MODEL_CONNECTION_INVALID')
    await expect(readFile(config, 'utf8')).resolves.toBe(broken)
  })

  it('单模型先切回官方后才安装多模型目录，官方默认保持独立', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    const file = createManagedTextFile()
    const codexHome = join(root, '.codex')
    await file.write(join(codexHome, 'config.toml'), 'model = "gpt-5.5"\n')
    const single = createCodexModelApiConfig('deepseek', root, file)
    await single.apply('sk-fixture-deepseek-key-1234567890')
    await single.deactivateToolboxConnection()
    await installCodexWorkspaceProviders({ codexHome, toolboxExecutable: '/toolbox', multiModel, officialModels, file })

    const result = await readFile(join(codexHome, 'config.toml'), 'utf8')
    expect(result).toContain('model = "gpt-5.5"')
    expect(result).not.toContain('[model_providers.laixin-deepseek]')
    expect(result).toContain('[model_providers.laixin-multi]')
  })

  it('目录与 provider 配置是同一事务：配置写回读失败会还原目录和 config', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    const config = join(root, 'config.toml')
    const models = join(root, 'laixin-multi-models.json')
    await writeFile(config, 'model = "gpt-fixture"\n')
    await writeFile(models, '{"models":[{"slug":"old-model"}]}\n')
    const disk = createManagedTextFile()
    const file: ManagedTextFile = {
      ...disk,
      write: async (path, contents) => {
        if (path === config && contents !== 'model = "gpt-fixture"\n') throw new Error('fixture config write failure')
        await disk.write(path, contents)
      },
      withConfigWriteLock: async (_path, task) => task()
    }

    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', multiModel, officialModels, file }))
      .rejects.toThrow('AI_ACCESS_CONFIG_TRANSACTION_FAILED')
    await expect(readFile(config, 'utf8')).resolves.toBe('model = "gpt-fixture"\n')
    await expect(readFile(models, 'utf8')).resolves.toBe('{"models":[{"slug":"old-model"}]}\n')
  })

  it('Windows 文件占用夹具：models 首次替换报 EBUSY 时 config/models 都保持原字节', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-win-busy-'))
    const config = join(root, 'config.toml')
    const models = join(root, 'laixin-multi-models.json')
    const originalConfig = '# customer config\n[customer]\nvalue = 1\n'
    const originalModels = '{"models":[{"slug":"old-model"}]}\n'
    await writeFile(config, originalConfig)
    await writeFile(models, originalModels)
    const disk = createManagedTextFile()
    let blocked = false
    const file: ManagedTextFile = {
      ...disk,
      write: async (path, contents) => {
        if (path === models && !blocked) {
          blocked = true
          throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' })
        }
        await disk.write(path, contents)
      },
      withConfigWriteLock: async (_path, task) => task()
    }

    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: 'C:\\Program Files\\Laixin\\Toolbox.exe', multiModel, officialModels, file }))
      .rejects.toThrow('AI_ACCESS_CONFIG_TRANSACTION_FAILED')
    await expect(readFile(config, 'utf8')).resolves.toBe(originalConfig)
    await expect(readFile(models, 'utf8')).resolves.toBe(originalModels)
  })

  it('解除接管只移除多模型块和目录，状态提交失败时两份文件原字节回滚', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-deactivate-'))
    const file = createManagedTextFile()
    const config = join(root, 'config.toml')
    const models = join(root, 'laixin-multi-models.json')
    await writeFile(config, '# customer\n[customer.extra]\nvalue = "keep"\n')
    await installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', multiModel, officialModels, file })
    const beforeConfig = await readFile(config, 'utf8')
    const beforeModels = await readFile(models, 'utf8')

    await expect(deactivateCodexWorkspaceProviders({ codexHome: root, file }, async () => {
      throw new Error('fixture state write failure')
    })).rejects.toThrow('AI_ACCESS_CONFIG_TRANSACTION_FAILED')

    await expect(readFile(config, 'utf8')).resolves.toBe(beforeConfig)
    await expect(readFile(models, 'utf8')).resolves.toBe(beforeModels)

    let committed = false
    await deactivateCodexWorkspaceProviders({ codexHome: root, file }, async () => { committed = true })
    expect(committed).toBe(true)
    const after = await readFile(config, 'utf8')
    expect(after).toContain('# customer')
    expect(after).toContain('[customer.extra]')
    expect(after).not.toContain('laixin-multi')
    await expect(readFile(models, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function officialModel(slug: string, displayName: string, defaultReasoningLevel: string): CodexWorkspaceOfficialModel {
  return {
    slug,
    catalog: {
      slug,
      display_name: displayName,
      description: `${displayName} description`,
      visibility: 'list',
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [
        { effort: 'low', description: 'Low' },
        { effort: 'medium', description: 'Medium' },
        { effort: 'high', description: 'High' }
      ],
      default_reasoning_level: defaultReasoningLevel,
      multi_agent_version: 'v2',
      additional_speed_tiers: ['fast'],
      service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority' }],
      default_service_tier: null,
      context_window: 272_000,
      max_context_window: 872_000,
      shell_type: 'unified_exec',
      web_search_tool_type: 'text_and_image'
    }
  }
}

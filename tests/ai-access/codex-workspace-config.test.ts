import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedTextFile } from '../../app/main/ai-access/file'
import { installCodexWorkspaceProviders } from '../../app/main/ai-access/codex-workspace-config'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })

describe('Codex 四来源工作窗口配置', () => {
  it('只追加三张来源表，保留官方默认和第三方配置，配置里没有 Key', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    const config = join(root, 'config.toml')
    const original = `model = "gpt-fixture"\nmodel_provider = "openai"\n\n[projects."/customer"]\ntrust_level = "trusted"\n`
    await writeFile(config, original)

    await installCodexWorkspaceProviders({
      codexHome: root,
      toolboxExecutable: '/Applications/Toolbox.app/Contents/MacOS/Toolbox',
      file: createManagedTextFile()
    })

    const result = await readFile(config, 'utf8')
    expect(result).toContain(original.trimEnd())
    expect(result).toContain('[model_providers.laixin-deepseek]')
    expect(result).toContain('[model_providers.laixin-kimi-api]')
    expect(result).toContain('[model_providers.laixin-zhipu-api]')
    expect(result).toContain('args = ["--laixin-codex-provider-key", "deepseek"]')
    expect(result).not.toMatch(/experimental_bearer_token|env_key|sk-fixture|API_KEY/)
    expect(result.match(/managed Codex workspaces/g)).toHaveLength(2)
  })

  it('重复安装原地更新自有块，不复制表或改全局 model_provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    const file = createManagedTextFile()
    await installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/old/toolbox', file })
    await installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: 'C:\\Program Files\\Laixin\\Toolbox.exe', file })

    const result = await readFile(join(root, 'config.toml'), 'utf8')
    expect(result.match(/\[model_providers\.laixin-deepseek\]/g)).toHaveLength(1)
    expect(result).toContain('command = "C:\\\\Program Files\\\\Laixin\\\\Toolbox.exe"')
    expect(result).not.toContain('/old/toolbox')
    expect(result).not.toMatch(/^model_provider\s*=/m)
  })

  it('遇到同名外部表或损坏的自有标记时拒写并保留原文件', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspaces-'))
    const config = join(root, 'config.toml')
    const collision = '[model_providers.laixin-deepseek]\nname = "customer"\n'
    await writeFile(config, collision)
    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', file: createManagedTextFile() }))
      .rejects.toThrow()
    await expect(readFile(config, 'utf8')).resolves.toBe(collision)

    const broken = '# >>> Laixin AI Toolbox managed Codex workspaces >>>\n[model_providers.laixin-deepseek]\n'
    await writeFile(config, broken)
    await expect(installCodexWorkspaceProviders({ codexHome: root, toolboxExecutable: '/toolbox', file: createManagedTextFile() }))
      .rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    await expect(readFile(config, 'utf8')).resolves.toBe(broken)
  })
})

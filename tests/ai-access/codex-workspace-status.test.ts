import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedTextFile } from '../../app/main/ai-access/file'
import * as workspaceConfig from '../../app/main/ai-access/codex-workspace-config'
import type { CodexWorkspaceOfficialModel } from '../../app/main/ai-access/codex-workspace-config'

const multiModel = {
  baseUrl: 'http://127.0.0.1:43210/codex/multi/v1',
  model: 'laixin.deepseek.deepseek-flash',
  models: ['laixin.deepseek.deepseek-flash', 'laixin.zhipu-api.glm-5.3-flash']
}
const executable = '/Applications/Toolbox.app/Contents/MacOS/Toolbox'
const officialModels: CodexWorkspaceOfficialModel[] = [{
  slug: 'gpt-fixture',
  catalog: {
    slug: 'gpt-fixture', display_name: 'GPT Fixture', description: 'Fixture', visibility: 'list',
    input_modalities: ['text'], supported_reasoning_levels: [{ effort: 'low', description: 'Low' }],
    default_reasoning_level: 'low', multi_agent_version: 'v2', additional_speed_tiers: [], service_tiers: [],
    default_service_tier: null, context_window: 1000, max_context_window: 1000,
    shell_type: 'shell_command', web_search_tool_type: 'text'
  }
}]
let root = ''

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })

describe('Codex 多模型目录受控回读', () => {
  it('区分未写入、当前池精确匹配和外部改写，不向结果暴露路径或配置内容', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-catalog-status-'))
    const file = createManagedTextFile()
    const read = (workspaceConfig as unknown as {
      readCodexWorkspaceCatalogStatus(options: { codexHome: string; toolboxExecutable: string; multiModel: typeof multiModel; file: typeof file }): Promise<unknown>
    }).readCodexWorkspaceCatalogStatus
    const options = { codexHome: root, toolboxExecutable: executable, multiModel, file }

    await expect(read(options)).resolves.toEqual({ state: 'missing' })
    await workspaceConfig.installCodexWorkspaceProviders({ ...options, officialModels })
    const written = await read(options)
    expect(written).toEqual({ state: 'written' })
    expect(JSON.stringify(written)).not.toContain(root)
    expect(JSON.stringify(written)).not.toContain('127.0.0.1')

    const generatedModels = (await file.read(join(root, 'laixin-multi-models.json')))!
    await file.write(join(root, 'laixin-multi-models.json'), JSON.stringify({ models: [{ slug: 'gpt-fixture' }] }))
    await expect(read(options)).resolves.toEqual({ state: 'modified' })

    const changed = JSON.parse(generatedModels) as { models: Array<Record<string, unknown>> }
    changed.models.find(model => model.slug === multiModel.model)!.description = 'externally changed'
    await file.write(join(root, 'laixin-multi-models.json'), JSON.stringify(changed))
    await expect(read(options)).resolves.toEqual({ state: 'modified' })
  })

  it('读取失败与未写入分开，不把池里有模型推断成目录已写入', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-catalog-status-'))
    const disk = createManagedTextFile()
    const read = (workspaceConfig as unknown as {
      readCodexWorkspaceCatalogStatus(options: { codexHome: string; toolboxExecutable: string; multiModel: typeof multiModel; file: typeof disk }): Promise<unknown>
    }).readCodexWorkspaceCatalogStatus
    await expect(read({ codexHome: root, toolboxExecutable: executable, multiModel, file: {
      ...disk,
      read: async () => { throw new Error('fixture unreadable') }
    } })).resolves.toEqual({ state: 'unreadable' })
  })
})

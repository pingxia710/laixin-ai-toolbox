import { describe, expect, it } from 'vitest'
import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProjectConfigurationTargetStore,
  configurationTargetEvidence,
  discoverConfigurationTargets,
  selectConfigurationTarget,
  symlinkMarkedError,
  type ConfigurationTargetFile,
  type ConfigurationTargetProjectStoreFile
} from '../../app/main/ai-access/configuration-target'
import { createManagedTextFile } from '../../app/main/ai-access/file'

function files(initial: Readonly<Record<string, string>> = {}): ConfigurationTargetFile {
  const data = new Map(Object.entries(initial))
  return { read: async (path) => data.get(path) }
}

function writableFiles(initial: Readonly<Record<string, string>> = {}): ConfigurationTargetProjectStoreFile {
  const data = new Map(Object.entries(initial))
  return {
    read: async (path) => data.get(path),
    write: async (path, contents) => { data.set(path, contents) }
  }
}

describe('实际配置目标诊断', () => {
  it('适配器可传入已验证的实际用户配置文件，避免把自定义 Hermes 根目录误写回默认位置', async () => {
    const result = await discoverConfigurationTargets({
      shell: 'hermes', home: '/customer', userPath: '/customer/custom-hermes/.env', file: files()
    })

    expect(result.effective).toEqual({
      shell: 'hermes', scope: 'user', path: '/customer/custom-hermes/.env', override: 'none', writable: true
    })
  })

  it('没有项目覆盖时默认选择可写的用户级 Codex 配置', async () => {
    const result = await discoverConfigurationTargets({
      shell: 'codex', home: '/customer', projectDir: '/customer/project', file: files()
    })

    expect(result.effective).toEqual({
      shell: 'codex', scope: 'user', path: '/customer/.codex/config.toml', override: 'none', writable: true
    })
  })

  it('发现项目级 Codex 配置时只报告无路径诊断，用户级配置仍是唯一可写目标', async () => {
    const result = await discoverConfigurationTargets({
      shell: 'codex', home: '/customer', projectDir: '/customer/project',
      file: files({ '/customer/project/.codex/config.toml': 'model = "cc-switch"\n' })
    })

    expect(result.effective).toEqual({
      shell: 'codex', scope: 'user', path: '/customer/.codex/config.toml', override: 'none', writable: true,
      reason: 'project-configuration-ignored'
    })
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user', writable: true }),
      expect.objectContaining({ scope: 'project', writable: false, reason: 'project-configuration-ignored' })
    ]))
    expect(result.candidates.find(target => target.scope === 'project')).not.toHaveProperty('path')
    expect(selectConfigurationTarget(result, 'user')).toEqual({
      shell: 'codex', scope: 'user', path: '/customer/.codex/config.toml', override: 'none', writable: true
    })
    expect(() => selectConfigurationTarget(result, 'project')).toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(configurationTargetEvidence(result.effective)).toEqual({
      shell: 'codex', scope: 'user', override: 'none', writable: true, reason: 'project-configuration-ignored'
    })
    expect(JSON.stringify(result.candidates)).not.toContain('/customer/project')
  })

  it('Codex 项目文件无法读取时仍可使用用户级配置，诊断故障不阻塞修复', async () => {
    const result = await discoverConfigurationTargets({
      shell: 'codex', home: '/customer', projectDir: '/customer/project',
      file: { read: async (path) => {
        if (path.includes('/project/')) throw new Error('project config unreadable')
        return undefined
      } }
    })

    expect(result.effective).toEqual({
      shell: 'codex', scope: 'user', path: '/customer/.codex/config.toml', override: 'none', writable: true
    })
  })

  it('命令行配置目录、受管策略和未知启动上下文均阻断自动写入', async () => {
    const commandLine = await discoverConfigurationTargets({
      shell: 'claude', home: '/customer', file: files(), execution: { configDirectory: '/other/.claude' }
    })
    const managed = await discoverConfigurationTargets({
      shell: 'codex', home: '/customer', file: files(), execution: { managed: true }
    })
    const unknown = await discoverConfigurationTargets({
      shell: 'hermes', home: '/customer', file: files(), execution: { source: 'unknown' }
    })

    expect(commandLine.effective).toMatchObject({ scope: 'unknown', override: 'command-line', writable: false })
    expect(managed.effective).toMatchObject({ scope: 'unknown', override: 'managed', writable: false })
    expect(unknown.effective).toMatchObject({ scope: 'unknown', override: 'unknown', writable: false })
    expect(() => selectConfigurationTarget(commandLine, 'user')).toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(() => selectConfigurationTarget(managed, 'user')).toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(() => selectConfigurationTarget(unknown, 'user')).toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  })

  it('配置文件读不出来时报告固定原因，既不暴露路径也不回退写用户级文件', async () => {
    const unreadable = await discoverConfigurationTargets({
      shell: 'codex', home: '/customer', projectDir: '/customer/project',
      file: { read: async () => { throw new Error('permission denied /customer/.codex/config.toml') } }
    })

    expect(unreadable.effective).toEqual({
      shell: 'codex', scope: 'unknown', override: 'unknown', writable: false, reason: 'unreadable-configuration'
    })
    expect(configurationTargetEvidence(unreadable.effective)).not.toHaveProperty('path')
    expect(() => selectConfigurationTarget(unreadable, 'user')).toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  })

  it('用户配置是软链时明确报 symlinked-configuration，带链接和真身，⛔ 混进「无法读取」（第 3 轮返修）', async () => {
    const symlinked = await discoverConfigurationTargets({
      shell: 'claude', home: '/customer',
      file: { read: async (path) => { throw symlinkMarkedError(path, '/customer/dotfiles/claude-settings.json') } }
    })
    expect(symlinked.effective).toEqual({
      shell: 'claude', scope: 'unknown', override: 'unknown', writable: false, reason: 'symlinked-configuration',
      symlink: { path: '/customer/.claude/settings.json', target: '/customer/dotfiles/claude-settings.json' }
    })
    // 真身路径必须能走到证据里：客户要靠它决定改哪个文件。
    expect(configurationTargetEvidence(symlinked.effective)).toMatchObject({
      reason: 'symlinked-configuration', symlink: { target: '/customer/dotfiles/claude-settings.json' }
    })
    expect(() => selectConfigurationTarget(symlinked, 'user')).toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')

    // 普通的读失败不带 symlink 字段，仍然是 unreadable-configuration。
    const unreadable = await discoverConfigurationTargets({
      shell: 'claude', home: '/customer', file: { read: async () => { throw new Error('AI_ACCESS_CONFIG_FILE_INVALID') } }
    })
    expect(unreadable.effective).toMatchObject({ reason: 'unreadable-configuration' })
    expect(unreadable.effective.symlink).toBeUndefined()
  })

  it('Codex 的历史私有项目选择被忽略且不再写入，Claude 仍拒绝损坏或相对目录', async () => {
    const storeFile = writableFiles({
      '/toolbox/private-project-targets.json': JSON.stringify({ version: 1, directories: { codex: 'relative-legacy-project', claude: '/customer/project' } })
    })
    const store = createProjectConfigurationTargetStore(storeFile, '/toolbox/private-project-targets.json', 'darwin')

    expect(await store.selectedProjectDirectory('codex')).toBeUndefined()
    expect(await store.selectedProjectDirectory('claude')).toBe('/customer/project')
    await expect(store.saveSelectedProjectDirectory('codex', '/customer/project')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    await store.saveSelectedProjectDirectory('claude', '/customer/next-project')
    await expect(storeFile.read('/toolbox/private-project-targets.json')).resolves.not.toContain('codex')
    expect(JSON.stringify(configurationTargetEvidence({
      shell: 'codex', scope: 'project', path: '/customer/project/.codex/config.toml', override: 'project', writable: true
    }))).not.toContain('/customer/project')

    const corrupt = createProjectConfigurationTargetStore(writableFiles({
      '/toolbox/private-project-targets.json': JSON.stringify({ version: 1, directories: { claude: 'relative-project' } })
    }), '/toolbox/private-project-targets.json', 'darwin')
    await expect(corrupt.selectedProjectDirectory('claude')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_SELECTION_INVALID')
  })

  it('私有项目选择沿用受管文件的 0600 与符号链接防护', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-private-target-'))
    const path = join(root, 'ai-access', 'private-project-targets.json')
    const store = createProjectConfigurationTargetStore(createManagedTextFile(), path, 'darwin')
    try {
      await store.saveSelectedProjectDirectory('claude', '/customer/project')
      expect((await lstat(path)).mode & 0o777).toBe(0o600)

      await rm(path)
      await symlink(join(root, 'outside'), path)
      await expect(store.selectedProjectDirectory('claude')).rejects.toThrow('AI_ACCESS_CONFIG_FILE_INVALID')
      await expect(store.saveSelectedProjectDirectory('claude', '/customer/other-project')).rejects.toThrow('AI_ACCESS_CONFIG_FILE_INVALID')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

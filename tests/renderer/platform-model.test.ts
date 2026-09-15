import { describe, expect, it } from 'vitest'
import { accessShell, installationSummary, selectedModelApiProvider, usesDeepSeek } from '../../app/renderer/src/platform/model'
import { canChooseClaudeConfigurationProject, codexProjectConfigurationNotice, hasClaudeConfigurationBinding, modelApiProviderOptions } from '../../app/renderer/src/platform/model-api'
import type { PrecheckReport } from '../../app/main/precheck/types'
import type { AiAccessStatus } from '../../app/main/ai-access/service'
import type { UsagePlatformId } from '../../app/renderer/src/tabs'
import { modelProviderIds, type ModelProviderId } from '../../app/shared/model-providers'

const emptyKeys = (): Record<ModelProviderId, boolean> => Object.fromEntries(modelProviderIds.map((provider) => [provider, false])) as Record<ModelProviderId, boolean>

describe('AI 平台总览数据', () => {
  it('三壳把智谱与 Kimi 的按量 API、套餐入口分开，不能混用', () => {
    expect(modelApiProviderOptions.map((provider) => [provider.id, provider.title])).toEqual([
      ['deepseek', 'DeepSeek API'],
      ['zhipu-api', '智谱开放平台 API'],
      ['zhipu', '智谱 GLM Coding Plan'],
      ['moonshot', 'Kimi 开放平台 API'],
      ['kimi', 'Kimi Code 官方套餐']
    ])
  })

  it('只有三个壳支持路由，国内平台不接管 API', () => {
    const platforms: UsagePlatformId[] = ['codex', 'claude-code', 'hermes', 'deepseek-harness', 'zcode', 'kimi-code']
    expect(platforms.map(accessShell)).toEqual(['codex', 'claude', 'hermes', null, null, null])
  })
  it('无读数不能显示已安装或伪造当前版本', () => {
    expect(installationSummary('codex', { state: 'not-run' })).toMatchObject({ state: '尚未检测', version: '未检测' })
    expect(installationSummary('kimi-code', { state: 'not-run' }).version).toBe('暂未接入版本检测')
  })
  it('展示采集到的版本，不将安装痕迹误称为运行正常', () => {
    const report = {
      state: 'complete', collectedAt: '2026-09-11T00:00:00Z',
      software: [{ software: 'claude', displayKind: 'detected', installation: { version: { status: 'available', value: '1.2.3' } } }]
    } as unknown as PrecheckReport
    expect(installationSummary('claude-code', report)).toEqual({ state: '检测到安装', version: '1.2.3', checkedAt: report.collectedAt })
    const invalid = { ...report, software: [{ ...report.software[0], installation: { version: { status: 'available', value: 'Saving session...\n/path/to/private' } } }] } as unknown as PrecheckReport
    expect(installationSummary('claude-code', invalid).version).toBe('暂未读到版本')
  })
  it('按各自壳的选择决定是否显示 DeepSeek 用量，不能串用官方额度', () => {
    const status: AiAccessStatus = { shells: {
      codex: { selected: 'deepseek', officialAvailable: true, providerKeys: emptyKeys() }, claude: { selected: 'official', officialAvailable: true, providerKeys: emptyKeys() }, hermes: { selected: null, officialAvailable: false, providerKeys: emptyKeys() }
    } }
    expect(usesDeepSeek('codex', status)).toBe(true)
    expect(usesDeepSeek('claude-code', status)).toBe(false)
    expect(usesDeepSeek('hermes', status)).toBe(false)
    expect(usesDeepSeek('codex', null)).toBe(false)
  })
  it('历史待验收路由暂停后不再把它当作当前模型 API', () => {
    const status: AiAccessStatus = { shells: {
      codex: {
        selected: 'zhipu', officialAvailable: true, providerKeys: emptyKeys(),
        suspended: { provider: 'zhipu', reason: 'provider-pending-verification' }
      },
      claude: { selected: null, officialAvailable: true, providerKeys: emptyKeys() },
      hermes: { selected: null, officialAvailable: false, providerKeys: emptyKeys() }
    } }
    expect(selectedModelApiProvider('codex', status)).toBeNull()
    expect(usesDeepSeek('codex', status)).toBe(false)
  })
  it('配置中断的受支持路由也不显示为当前模型 API，客户可重新启用', () => {
    const status: AiAccessStatus = { shells: {
      codex: {
        selected: null, officialAvailable: true, providerKeys: { ...emptyKeys(), deepseek: true },
        interrupted: { provider: 'deepseek', reason: 'configuration-interrupted' }
      },
      claude: { selected: 'deepseek', officialAvailable: true, providerKeys: { ...emptyKeys(), deepseek: true } },
      hermes: { selected: null, officialAvailable: false, providerKeys: emptyKeys() }
    } }
    expect(selectedModelApiProvider('codex', status)).toBeNull()
    expect(usesDeepSeek('codex', status)).toBe(false)
    expect(status.shells.codex.providerKeys.deepseek).toBe(true)
    // One paused row cannot turn another shell's active configuration into a global UI fault.
    expect(selectedModelApiProvider('claude-code', status)).toBe('deepseek')
    expect(usesDeepSeek('claude-code', status)).toBe(true)
  })
  it('旧直连记录不显示为当前配置，保留 Key 供客户显式迁移', () => {
    const status: AiAccessStatus = { shells: {
      codex: {
        selected: null, officialAvailable: true, providerKeys: { ...emptyKeys(), deepseek: true },
        legacyDirect: { provider: 'deepseek', reason: 'not-managed-by-current-gateway' }
      },
      claude: { selected: null, officialAvailable: true, providerKeys: emptyKeys() },
      hermes: { selected: null, officialAvailable: false, providerKeys: emptyKeys() }
    } }
    expect(selectedModelApiProvider('codex', status)).toBeNull()
    expect(usesDeepSeek('codex', status)).toBe(false)
    expect(status.shells.codex.providerKeys.deepseek).toBe(true)
  })
  it('Codex 项目配置只显示用户级配置诊断，不提供项目修复语义', () => {
    expect(codexProjectConfigurationNotice('codex', {
      shell: 'codex', scope: 'user', override: 'none', writable: true, reason: 'project-configuration-ignored'
    })).toContain('用户级配置')
    expect(codexProjectConfigurationNotice('claude', {
      shell: 'claude', scope: 'project', override: 'project', writable: false, reason: 'project-config-overrides-user'
    })).toBeUndefined()
  })
  it('Claude 只在无接管或恢复状态且来源可安全处理时提供项目目录选择', () => {
    const clean: AiAccessStatus = { shells: {
      codex: { selected: null, officialAvailable: true, providerKeys: emptyKeys() },
      claude: { selected: null, officialAvailable: true, providerKeys: emptyKeys() },
      hermes: { selected: null, officialAvailable: false, providerKeys: emptyKeys() }
    } }
    expect(hasClaudeConfigurationBinding(clean)).toBe(false)
    expect(canChooseClaudeConfigurationProject(clean, undefined, true)).toBe(true)
    for (const reason of ['managed-configuration', 'command-line-config-override', 'unreadable-configuration', 'unknown-launch-context'] as const) {
      expect(canChooseClaudeConfigurationProject(clean, {
        shell: 'claude', scope: 'unknown', override: reason === 'managed-configuration' ? 'managed' : reason === 'command-line-config-override' ? 'command-line' : 'unknown', writable: false, reason
      }, true)).toBe(false)
    }
    expect(canChooseClaudeConfigurationProject(clean, {
      shell: 'claude', scope: 'project', override: 'project', writable: false, reason: 'project-config-overrides-user'
    }, true)).toBe(false)
    const active: AiAccessStatus = { ...clean, shells: { ...clean.shells, claude: { ...clean.shells.claude, selected: 'deepseek' } } }
    expect(hasClaudeConfigurationBinding(active)).toBe(true)
    expect(canChooseClaudeConfigurationProject(active, undefined, true)).toBe(false)
    const officiallyReleased: AiAccessStatus = { ...clean, shells: { ...clean.shells, claude: { ...clean.shells.claude, selected: 'official' } } }
    expect(hasClaudeConfigurationBinding(officiallyReleased)).toBe(false)
    expect(canChooseClaudeConfigurationProject(officiallyReleased, undefined, true)).toBe(true)
  })
})

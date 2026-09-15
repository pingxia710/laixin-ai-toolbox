import { describe, expect, it } from 'vitest'
import { readAccessStatus, readCodexLoginStatus } from '../../app/renderer/src/platform/access-status'
import { modelProviderIds, type ModelProviderId } from '../../app/shared/model-providers'

const keys = Object.fromEntries(modelProviderIds.map((provider) => [provider, false])) as Record<ModelProviderId, boolean>
function fixture() {
  return { shells: {
    codex: { selected: 'deepseek', officialAvailable: true, providerKeys: { ...keys, deepseek: true } },
    claude: { selected: 'official', officialAvailable: true, providerKeys: keys },
    hermes: { selected: null, officialAvailable: false, providerKeys: keys }
  } }
}

describe('模型页共享接入状态解析（独立于已移除的 API KEY 页）', () => {
  it('各壳只读自己的 Key 状态，并保留官方与 API 选择', () => {
    const status = readAccessStatus(JSON.stringify(fixture()))
    expect(status.shells.codex).toMatchObject({ selected: 'deepseek', providerKeys: { deepseek: true } })
    expect(status.shells.claude).toMatchObject({ selected: 'official', providerKeys: { deepseek: false } })
    expect(status.shells.hermes).toMatchObject({ selected: null, officialAvailable: false })
  })
  it('共享解析不返回意外附带的凭据', () => {
    const data = fixture()
    expect(JSON.stringify(readAccessStatus(JSON.stringify({ ...data, secret: 'private-fixture', shells: {
      ...data.shells, codex: { ...data.shells.codex, secret: 'private-fixture', providerKeys: { ...data.shells.codex.providerKeys, token: 'private-fixture' } }
    } })))).not.toContain('private-fixture')
  })
  it('只保留主进程固定的 Key 存储恢复提示，忽略路径或任意原文', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), storageNote: '保存的 Key 已失效，请重新添加。' }))
    expect(status.storageNote).toBe('保存的 Key 已失效，请重新添加。')
    const unsafe = readAccessStatus(JSON.stringify({ ...fixture(), storageNote: '/customer/private/sk-fixture' }))
    expect(unsafe.storageNote).toBeUndefined()
    expect(JSON.stringify(unsafe)).not.toContain('/customer/private')
  })
  it('只保留历史暂停路由的固定原因，不把配置细节带进界面', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), shells: {
      ...fixture().shells,
      codex: {
        ...fixture().shells.codex,
        suspended: { provider: 'zhipu', reason: 'provider-pending-verification', path: '/customer/private/.codex/config.toml', key: 'sk-private-fixture' }
      }
    } }))
    expect(status.shells.codex.suspended).toEqual({ provider: 'zhipu', reason: 'provider-pending-verification' })
    expect(JSON.stringify(status)).not.toContain('/customer/private')
    expect(JSON.stringify(status)).not.toContain('sk-private-fixture')
    expect(() => readAccessStatus(JSON.stringify({ ...fixture(), shells: {
      ...fixture().shells,
      codex: { ...fixture().shells.codex, suspended: { provider: 'zhipu', reason: 'other' } }
    } }))).toThrow('AI_ACCESS_STATUS_INVALID')
  })
  it('只保留配置中断的固定提示，不把路由或本地细节带进界面', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), shells: {
      ...fixture().shells,
      codex: {
        ...fixture().shells.codex,
        selected: null,
        interrupted: { provider: 'deepseek', reason: 'configuration-interrupted', port: 47123, path: '/customer/private/.codex/config.toml' }
      }
    } }))
    expect(status.shells.codex.interrupted).toEqual({ provider: 'deepseek', reason: 'configuration-interrupted' })
    expect(JSON.stringify(status)).not.toContain('/customer/private')
    expect(() => readAccessStatus(JSON.stringify({ ...fixture(), shells: {
      ...fixture().shells,
      codex: { ...fixture().shells.codex, interrupted: { provider: 'deepseek', reason: 'other' } }
    } }))).toThrow('AI_ACCESS_STATUS_INVALID')
  })
  it('旧直连只保留固定迁移提示，不把历史配置细节带进界面', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), shells: {
      ...fixture().shells,
      codex: {
        ...fixture().shells.codex,
        selected: null,
        legacyDirect: { provider: 'deepseek', reason: 'not-managed-by-current-gateway', path: '/customer/private/.codex/config.toml', key: 'sk-private-fixture' }
      }
    } }))
    expect(status.shells.codex.legacyDirect).toEqual({ provider: 'deepseek', reason: 'not-managed-by-current-gateway' })
    expect(JSON.stringify(status)).not.toContain('/customer/private')
    expect(JSON.stringify(status)).not.toContain('sk-private-fixture')
    expect(() => readAccessStatus(JSON.stringify({ ...fixture(), shells: {
      ...fixture().shells,
      codex: { ...fixture().shells.codex, legacyDirect: { provider: 'deepseek', reason: 'other' } }
    } }))).toThrow('AI_ACCESS_STATUS_INVALID')
  })
  it('只保留配置目标的脱敏判定，不把路径或启动参数带进界面', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), configurationTargets: {
      codex: {
        shell: 'codex', scope: 'project', override: 'project', writable: false,
        reason: 'project-config-overrides-user', path: '/customer/private/project/.codex/config.toml', args: '--config private'
      }
    } }))
    expect(status.configurationTargets?.codex).toEqual({
      shell: 'codex', scope: 'project', override: 'project', writable: false, reason: 'project-config-overrides-user'
    })
    expect(JSON.stringify(status)).not.toContain('/customer/private')
    expect(JSON.stringify(status)).not.toContain('--config private')
  })
  it('保留 Codex 项目配置只作诊断的固定事实，不把项目路径带进界面', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), configurationTargets: {
      codex: { shell: 'codex', scope: 'user', override: 'none', writable: true, reason: 'project-configuration-ignored', path: '/customer/private/.codex/config.toml' }
    } }))
    expect(status.configurationTargets?.codex).toEqual({ shell: 'codex', scope: 'user', override: 'none', writable: true, reason: 'project-configuration-ignored' })
    expect(JSON.stringify(status)).not.toContain('/customer/private')
  })
  it('软链配置目标带链接与真身路径——客户要靠它决定改哪个文件（第 3 轮返修）', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), configurationTargets: {
      claude: {
        shell: 'claude', scope: 'unknown', override: 'unknown', writable: false, reason: 'symlinked-configuration',
        symlink: { path: '/customer/.claude/settings.json', target: '/customer/dotfiles/settings.json' }
      }
    } }))
    expect(status.configurationTargets?.claude).toEqual({
      shell: 'claude', scope: 'unknown', override: 'unknown', writable: false, reason: 'symlinked-configuration',
      symlink: { path: '/customer/.claude/settings.json', target: '/customer/dotfiles/settings.json' }
    })
    // symlink 结构不完整就是坏数据，⛔ 放行后让界面渲染出 undefined。
    expect(() => readAccessStatus(JSON.stringify({ ...fixture(), configurationTargets: {
      claude: { shell: 'claude', scope: 'unknown', override: 'unknown', writable: false, reason: 'symlinked-configuration', symlink: { path: '/only-path' } }
    } }))).toThrow('AI_ACCESS_STATUS_INVALID')
  })
  it('只保留 Codex 官方认证的安全结论，不把 CC Switch 留下的 Key 或 auth.json 原文带进界面', () => {
    const status = readAccessStatus(JSON.stringify({ ...fixture(), officialAuthentication: {
      codex: {
        state: 'login-required', reason: 'other-tool-api-key',
        key: 'sk-private-fixture', authJson: '{"OPENAI_API_KEY":"sk-private-fixture"}'
      }
    } }))
    expect(status.officialAuthentication?.codex).toEqual({ state: 'login-required', reason: 'other-tool-api-key' })
    expect(JSON.stringify(status)).not.toContain('sk-private-fixture')
    expect(() => readAccessStatus(JSON.stringify({ ...fixture(), officialAuthentication: { codex: { state: 'unknown', reason: 'other-tool-api-key' } } }))).toThrow('AI_ACCESS_STATUS_INVALID')
  })
  it('保留姐妹产品探测的建议入口，拒绝任意产品名', () => {
    const attempt = { shell: 'codex', provider: 'kimi', ok: false, at: '2026-09-13T08:00:00.000Z', code: 'key_product_mismatch', suggestedProvider: 'moonshot' }
    expect(readAccessStatus(JSON.stringify({ ...fixture(), attempt })).attempt).toMatchObject({ suggestedProvider: 'moonshot' })
    expect(() => readAccessStatus(JSON.stringify({ ...fixture(), attempt: { ...attempt, suggestedProvider: 'evil' } }))).toThrow('AI_ACCESS_STATUS_INVALID')
  })
  it('缺少壳、无效选择或错误 Key 状态均报错，不能当作未配置', () => {
    const data = fixture()
    for (const value of [{}, { shells: {} }, { shells: { ...data.shells, codex: { ...data.shells.codex, selected: 'unknown' } } }, { shells: { ...data.shells, codex: { ...data.shells.codex, providerKeys: { ...keys, kimi: 'unknown' } } } }]) {
      expect(() => readAccessStatus(JSON.stringify(value))).toThrow('AI_ACCESS_STATUS_INVALID')
    }
  })
  it('官方授权等待、成功和失败状态完整保留', () => {
    for (const status of ['idle', 'pending', 'connected', 'failed']) expect(readCodexLoginStatus(JSON.stringify({ status }))).toBe(status)
    expect(() => readCodexLoginStatus('{"status":"unknown"}')).toThrow('AI_ACCESS_LOGIN_STATUS_INVALID')
  })
})

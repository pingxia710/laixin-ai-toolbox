import { describe, expect, it } from 'vitest'
import {
  ccSwitchDetachAccepted,
  ccSwitchFixtureIsDetachedFromToolbox,
  ccSwitchFixtureSnapshot,
  expectedProviderMismatchAccepted,
  expectedProviderMismatchSuggestion,
  isolatedNativeEnvironment,
  nativeClientEvidence,
  newlyPrependedGatewayRecords,
  nativeRouteModelAccepted,
  sameCcSwitchFixture
} from '../../scripts/verify-ai-route-real-upstream-output.mjs'

const ccSwitchFixture = [
  'model = "deepseek-chat"',
  'model_provider = "deepseek"',
  '',
  '[model_providers.deepseek]',
  'name = "CC Switch"',
  'base_url = "https://api.deepseek.com"',
  '',
  '[model_providers.customer-secondary]',
  'name = "Customer secondary"',
  'base_url = "https://customer-secondary.invalid/v1"',
  '',
  '[mcp_servers.customer-tool]',
  'command = "customer-tool"',
  '',
  '[mcp_servers.customer-review]',
  'command = "customer-review"'
].join('\n').concat('\n')

describe('真实上游验收输出约束', () => {
  it('原生客户端启动后的网关记录只取 newest-first 队列中新前插的部分，边界丢失就失败关闭', () => {
    const oldProbe = { source: 'test', ok: true }
    const newClient = { source: 'client', ok: true }
    const oldClient = { source: 'client', ok: true }

    expect(newlyPrependedGatewayRecords([oldProbe, oldClient], [newClient, oldProbe, oldClient])).toEqual([newClient])
    expect(newlyPrependedGatewayRecords([], [newClient])).toEqual([newClient])
    expect(newlyPrependedGatewayRecords([oldProbe], [newClient])).toEqual([])
  })

  it('真上游失败摘要只保留本次客户端的计数和固定失败码，不带请求或回复内容', () => {
    expect(nativeClientEvidence([
      { source: 'test', shell: 'codex', provider: 'kimi', ok: true, prompt: 'private' },
      { source: 'client', shell: 'codex', provider: 'kimi', ok: false, code: 'client_aborted', response: 'private' },
      { source: 'client', shell: 'codex', provider: 'kimi', ok: true, response: 'private' }
    ], 'codex', 'kimi')).toEqual({ requests: 2, succeeded: true, cancelled: 1, failure: null })
    expect(nativeClientEvidence([], 'invalid', 'kimi')).toEqual({ requests: 0, succeeded: false, cancelled: 0, failure: null })
  })

  it('Claude Code 的受支持小模型可以作为真实原生调用，其他壳必须使用当前配置模型', () => {
    const models = ['deepseek-v4-flash', 'deepseek-v4-pro']
    expect(nativeRouteModelAccepted('claude', 'deepseek-v4-pro', 'deepseek-v4-flash', models)).toBe(true)
    expect(nativeRouteModelAccepted('codex', 'deepseek-v4-pro', 'deepseek-v4-flash', models)).toBe(false)
    expect(nativeRouteModelAccepted('hermes', 'deepseek-v4-pro', 'private-model', models)).toBe(false)
  })

  it('预期失败只能证明 Kimi 两个独立 Key 产品的实际姐妹入口，不接收本机或任意鉴权故障', () => {
    expect(expectedProviderMismatchSuggestion('kimi')).toBe('moonshot')
    expect(expectedProviderMismatchSuggestion('moonshot')).toBe('kimi')
    expect(expectedProviderMismatchSuggestion('deepseek')).toBeUndefined()
    expect(expectedProviderMismatchAccepted('kimi', 'moonshot', {
      ok: false, code: 'key_product_mismatch', suggestedProvider: 'moonshot'
    })).toBe(true)
    for (const attempt of [
      { ok: false, code: 'port_unavailable', suggestedProvider: undefined },
      { ok: false, code: 'key_product_mismatch', suggestedProvider: 'kimi' },
      { ok: false, code: 'key_rejected', suggestedProvider: 'moonshot' },
      { ok: true, code: undefined, suggestedProvider: 'moonshot' }
    ]) expect(expectedProviderMismatchAccepted('kimi', 'moonshot', attempt)).toBe(false)
    expect(expectedProviderMismatchAccepted('deepseek', 'moonshot', {
      ok: false, code: 'key_product_mismatch', suggestedProvider: 'moonshot'
    })).toBe(false)
  })

  it('Windows 真实原生验收使用固定系统根和隔离用户目录，不继承调用终端环境', () => {
    const environment = isolatedNativeEnvironment('win32', 'C:\\private\\runner-home', 'C:\\private\\runner-home\\.hermes', 'C:\\private\\runner-temp', 'C:\\Windows')
    expect(environment).toMatchObject({
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      Path: 'C:\\Windows\\System32;C:\\Windows',
      SystemRoot: 'C:\\Windows',
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      HOME: 'C:\\private\\runner-home',
      USERPROFILE: 'C:\\private\\runner-home',
      APPDATA: 'C:\\private\\runner-home\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\private\\runner-home\\AppData\\Local',
      TEMP: 'C:\\private\\runner-temp',
      TMP: 'C:\\private\\runner-temp'
    })
    expect(() => isolatedNativeEnvironment('win32', 'C:\\private\\runner-home', 'C:\\private\\runner-home\\.hermes', 'C:\\private\\runner-temp', 'D:\\untrusted')).toThrow('windows_root_invalid')
    expect(isolatedNativeEnvironment('darwin', '/private/runner-home', '/private/runner-home/.hermes', '/private/runner-temp', 'C:\\Windows')).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/private/runner-home',
      CODEX_HOME: '/private/runner-home/.codex',
      CLAUDE_CONFIG_DIR: '/private/runner-home/.claude',
      HERMES_HOME: '/private/runner-home/.hermes',
      XDG_CONFIG_HOME: '/private/runner-home/.xdg/config',
      XDG_DATA_HOME: '/private/runner-home/.xdg/data',
      XDG_STATE_HOME: '/private/runner-home/.xdg/state',
      XDG_CACHE_HOME: '/private/runner-home/.xdg/cache',
      TMPDIR: '/private/runner-temp',
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    })
  })

  it('CC Switch 场景只在原 provider、MCP 与模型语义都完整恢复时通过', () => {
    const before = ccSwitchFixtureSnapshot(ccSwitchFixture)
    expect(before).toBeDefined()
    expect(sameCcSwitchFixture(before, ccSwitchFixtureSnapshot(ccSwitchFixture))).toBe(true)
    for (const changed of [
      ccSwitchFixture.replace('name = "CC Switch"', 'name = "Other Tool"'),
      ccSwitchFixture.replace('https://api.deepseek.com', 'https://example.invalid'),
      ccSwitchFixture.replace('command = "customer-tool"', 'command = "replaced-tool"'),
      ccSwitchFixture.replace('model_provider = "deepseek"', 'model_provider = "other"')
    ]) expect(sameCcSwitchFixture(before, ccSwitchFixtureSnapshot(changed))).toBe(false)
  })

  it('解除工具箱接管同时逐字恢复 CC Switch 原配置，并保留第三方 Key 的登录提示', () => {
    const detachedFixture = [
      '[model_providers.deepseek]',
      'name = "CC Switch"',
      'base_url = "https://api.deepseek.com"',
      '',
      '[mcp_servers.customer-tool]',
      'command = "customer-tool"'
    ].join('\n').concat('\n')
    const toolboxFixture = [
      '# >>> Laixin AI Toolbox managed model connection >>>',
      'model = "deepseek-v4-pro"',
      'model_provider = "laixin-deepseek"',
      '',
      '[model_providers.laixin-deepseek]',
      'base_url = "http://127.0.0.1:19361/codex/deepseek/v1"',
      '# <<< Laixin AI Toolbox managed model connection >>>',
      '',
      detachedFixture
    ].join('\n')
    const markerlessToolboxFixture = toolboxFixture
      .replace('# >>> Laixin AI Toolbox managed model connection >>>\n', '')
      .replace('# <<< Laixin AI Toolbox managed model connection >>>\n', '')
    const before = { authHash: 'fixture-auth-hash', configHash: 'fixture-config-hash', config: ccSwitchFixtureSnapshot(ccSwitchFixture) }

    expect(ccSwitchFixtureIsDetachedFromToolbox(detachedFixture)).toBe(true)
    expect(ccSwitchFixtureSnapshot(detachedFixture)).toBeUndefined()
    expect(ccSwitchFixtureIsDetachedFromToolbox(toolboxFixture)).toBe(false)
    expect(ccSwitchFixtureIsDetachedFromToolbox(markerlessToolboxFixture)).toBe(false)
    expect(ccSwitchDetachAccepted(before, 'fixture-auth-hash', 'fixture-config-hash', 'official', {
      state: 'login-required', reason: 'other-tool-api-key'
    }, ccSwitchFixture)).toBe(true)
    expect(ccSwitchDetachAccepted(before, 'fixture-auth-hash', 'fixture-config-hash', 'official', {
      state: 'login-required', reason: 'other-tool-api-key'
    }, toolboxFixture)).toBe(false)
    expect(ccSwitchDetachAccepted(before, 'fixture-auth-hash', 'other-config-hash', 'official', {
      state: 'login-required', reason: 'other-tool-api-key'
    }, ccSwitchFixture)).toBe(false)
    expect(ccSwitchDetachAccepted(before, 'fixture-auth-hash', 'fixture-config-hash', 'official', {
      state: 'official'
    }, ccSwitchFixture)).toBe(false)
  })
})

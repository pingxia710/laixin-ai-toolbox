import { describe, expect, it } from 'vitest'
import { inspectCodexOfficialAuthentication } from '../../app/main/ai-access/codex-auth-document'

describe('Codex 官方认证状态', () => {
  it('只把完整的 ChatGPT 令牌包视为已登录，且绝不回传令牌内容', () => {
    const contents = JSON.stringify({
      tokens: { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', id_token: 'fixture-id-token' },
      last_refresh: '2026-09-13T00:00:00Z'
    })

    const status = inspectCodexOfficialAuthentication(contents)

    expect(status).toEqual({ state: 'official', reason: 'chatgpt-session' })
    expect(JSON.stringify(status)).not.toContain('fixture-')
  })

  it('识别 CC Switch 的仅 API Key 认证，但不迁移、删除或泄露这个 Key', () => {
    const contents = JSON.stringify({ OPENAI_API_KEY: 'fixture-third-party-api-key' })

    const status = inspectCodexOfficialAuthentication(contents)

    expect(status).toEqual({ state: 'login-required', reason: 'other-tool-api-key' })
    expect(JSON.stringify(status)).not.toContain('fixture-third-party-api-key')
  })

  it('即使同时残留 ChatGPT tokens，只要还有第三方 OPENAI_API_KEY 也不冒充官方登录', () => {
    const status = inspectCodexOfficialAuthentication(JSON.stringify({
      OPENAI_API_KEY: 'fixture-cc-switch-key',
      tokens: { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token' }
    }))

    expect(status).toEqual({ state: 'login-required', reason: 'other-tool-api-key' })
    expect(JSON.stringify(status)).not.toContain('fixture-')
  })

  it('官方 auth.json 中的空 OPENAI_API_KEY 不覆盖完整 ChatGPT 登录', () => {
    const status = inspectCodexOfficialAuthentication(JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      last_refresh: '2026-09-13T00:00:00Z',
      tokens: {
        access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token',
        account_id: 'fixture-account-id', id_token: 'fixture-id-token'
      }
    }))

    expect(status).toEqual({ state: 'official', reason: 'chatgpt-session' })
    expect(JSON.stringify(status)).not.toContain('fixture-')
  })

  it('缺失、损坏或无法证明官方身份的 auth.json 一律要求官方登录', () => {
    expect(inspectCodexOfficialAuthentication(undefined)).toEqual({ state: 'login-required', reason: 'no-authentication' })
    expect(inspectCodexOfficialAuthentication('{not-json')).toEqual({ state: 'login-required', reason: 'unrecognized-authentication' })
    expect(inspectCodexOfficialAuthentication(JSON.stringify({ OPENAI_API_KEY: 'fixture', source: 'customer' })))
      .toEqual({ state: 'login-required', reason: 'other-tool-api-key' })
    expect(inspectCodexOfficialAuthentication(JSON.stringify({ source: 'customer' })))
      .toEqual({ state: 'login-required', reason: 'unrecognized-authentication' })
    expect(inspectCodexOfficialAuthentication(JSON.stringify({ tokens: { access_token: 'only-one-token' } })))
      .toEqual({ state: 'login-required', reason: 'unrecognized-authentication' })
  })
})

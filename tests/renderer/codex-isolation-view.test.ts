import { describe, expect, it } from 'vitest'
import { claudeIsolationCopy, claudeIsolationMessage, codexIsolationCopy, codexIsolationMessage, readClaudeIsolationStatus, readCodexIsolationStatus } from '../../app/renderer/src/platform/model-api'

describe('N-56 Codex 隔离页面状态', () => {
  it('只展示固定受控状态，不接受地址、配置或原始异常字段', () => {
    const value = readCodexIsolationStatus(JSON.stringify({
      application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 2, available: true, code: 'AVAILABLE',
      proxyUrl: 'http://127.0.0.1:18080', configuration: 'private', error: 'raw exception'
    }))

    expect(value).toEqual({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 2, available: true, code: 'AVAILABLE' })
  })

  it('缺失、未知或错误 application/scope 时拒绝快照', () => {
    const fixed = { application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'verifying', action: 'enable', intentGeneration: 1, available: false, code: 'AVAILABLE' }
    expect(readCodexIsolationStatus(JSON.stringify({ ...fixed, application: undefined }))).toBeNull()
    expect(readCodexIsolationStatus(JSON.stringify({ ...fixed, application: 'claude' }))).toBeNull()
    expect(readCodexIsolationStatus(JSON.stringify({ ...fixed, scope: undefined }))).toBeNull()
    expect(readCodexIsolationStatus(JSON.stringify({ ...fixed, scope: 'all-egress' }))).toBeNull()
  })

  it('明确限定为 Codex 模型 API 请求、系统未接管、正在验证和可确定失败原因', () => {
    const fixed = { application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'verifying', action: 'enable', intentGeneration: 1, available: false, code: 'AVAILABLE' }
    expect(codexIsolationMessage(readCodexIsolationStatus(JSON.stringify(fixed)))).toContain('模型 API')
    expect(codexIsolationMessage(readCodexIsolationStatus(JSON.stringify({ ...fixed, phase: 'limited', action: 'health', code: 'TARGET_UNREACHABLE' })))).toContain('原配置已恢复')
    expect(codexIsolationMessage(readCodexIsolationStatus(JSON.stringify({ ...fixed, phase: 'limited', action: 'recover', code: 'RESTORE_FAILED' })))).toContain('恢复失败')
    expect(codexIsolationMessage(readCodexIsolationStatus(JSON.stringify({ ...fixed, phase: 'available', available: true })))).toBe('Codex 模型 API 请求已通过隔离通道验证；此功能仅作用于 Codex 模型请求，系统连接状态请查看首页。')
    expect(codexIsolationCopy).toEqual({ title: 'Codex 模型 API 隔离', enable: '仅让 Codex 模型请求使用来信通道', disable: '停止 Codex 模型 API 隔离' })
    expect(codexIsolationMessage(null)).not.toContain('仅 Codex 使用来信网络')
  })

  it('拒绝把不可达或受限状态伪装为已验证 available', () => {
    const fixed = { application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'health', intentGeneration: 1, available: false, code: 'TARGET_UNREACHABLE' }
    expect(readCodexIsolationStatus(JSON.stringify({ ...fixed, available: true }))).toBeNull()
    expect(readCodexIsolationStatus(JSON.stringify({ ...fixed, phase: 'available', available: true }))).toBeNull()
  })
})

describe('N-57 Claude Code 隔离页面状态', () => {
  it('只展示 Claude 模型 API 的固定能力状态，不接收入口、settings、Key、路径、登录或原始异常', () => {
    const value = readClaudeIsolationStatus(JSON.stringify({
      application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 2, available: true, code: 'AVAILABLE',
      proxyUrl: 'http://127.0.0.1:18080', settings: 'private', key: 'fixture', path: '/customer/.claude', login: 'official', error: 'raw exception'
    }))

    expect(value).toEqual({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 2, available: true, code: 'AVAILABLE' })
  })

  it('拒绝错误 application、scope 或 capability，并明确不宣称官方流量被隔离', () => {
    const fixed = { application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'verifying', action: 'enable', intentGeneration: 1, available: false, code: 'AVAILABLE' }
    expect(readClaudeIsolationStatus(JSON.stringify({ ...fixed, application: 'codex' }))).toBeNull()
    expect(readClaudeIsolationStatus(JSON.stringify({ ...fixed, scope: 'all-egress' }))).toBeNull()
    expect(readClaudeIsolationStatus(JSON.stringify({ ...fixed, capability: 'socks5' }))).toBeNull()
    expect(claudeIsolationMessage(readClaudeIsolationStatus(JSON.stringify({ ...fixed, phase: 'available', available: true })))).toContain('不表示官方登录、更新、遥测或插件流量已隔离')
    expect(claudeIsolationCopy).toEqual({ title: 'Claude Code 模型 API 隔离', enable: '仅让 Claude Code 模型请求使用来信通道', disable: '停止 Claude Code 模型 API 隔离' })
  })

  it('拒绝把 Claude target 不可达状态伪装为已验证 available', () => {
    const fixed = { application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'health', intentGeneration: 1, available: false, code: 'TARGET_UNREACHABLE' }
    expect(readClaudeIsolationStatus(JSON.stringify({ ...fixed, available: true }))).toBeNull()
    expect(readClaudeIsolationStatus(JSON.stringify({ ...fixed, phase: 'available', available: true }))).toBeNull()
  })
})

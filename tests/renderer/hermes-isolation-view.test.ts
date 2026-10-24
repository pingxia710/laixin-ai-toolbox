import { describe, expect, it } from 'vitest'
import { hermesIsolationCopy, hermesIsolationMessage, readHermesIsolationStatus } from '../../app/renderer/src/platform/model-api'

describe('N-58 Hermes 隔离页面状态', () => {
  it('只接受固定 Hermes 合同，忽略地址、配置与原始异常字段', () => {
    const value = readHermesIsolationStatus(JSON.stringify({
      application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 2, available: true, code: 'AVAILABLE',
      proxyUrl: 'http://127.0.0.1:18080', hermesHome: '/private', configuration: 'model.api_key=private', error: 'raw exception'
    }))
    expect(value).toEqual({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 2, available: true, code: 'AVAILABLE' })
  })

  it('拒绝错误 application 或 scope，且 available 不冒充 Hermes 客户端完整回答', () => {
    const fixed = { application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'verifying', action: 'enable', intentGeneration: 1, available: false, code: 'AVAILABLE' }
    expect(readHermesIsolationStatus(JSON.stringify({ ...fixed, application: 'codex' }))).toBeNull()
    expect(readHermesIsolationStatus(JSON.stringify({ ...fixed, scope: 'all-egress' }))).toBeNull()
    expect(hermesIsolationMessage(readHermesIsolationStatus(JSON.stringify({ ...fixed, phase: 'available', available: true })))).toContain('不代表 Hermes 客户端已经完成回答')
    expect(hermesIsolationCopy).toEqual({ title: 'Hermes 模型 API 隔离', enable: '仅让 Hermes 模型请求使用来信通道', disable: '停止 Hermes 模型 API 隔离' })
  })

  it.each([
    ['available 却不是 AVAILABLE', { mode: 'disabled', phase: 'restored', available: true, code: 'RESTORED' }],
    ['AVAILABLE 却落在 limited', { mode: 'application-only', phase: 'limited', available: false, code: 'AVAILABLE' }],
    ['RESTORED 却仍是 application-only', { mode: 'application-only', phase: 'available', available: false, code: 'RESTORED' }],
    ['普通错误却不是 application-only/limited', { mode: 'disabled', phase: 'restored', available: false, code: 'TARGET_UNREACHABLE' }]
  ])('页面拒绝矛盾隔离状态：%s', (_name, contradiction) => {
    const value = {
      application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', systemNetwork: 'unmanaged', action: 'health', intentGeneration: 1,
      ...contradiction
    }
    expect(readHermesIsolationStatus(JSON.stringify(value))).toBeNull()
  })
})

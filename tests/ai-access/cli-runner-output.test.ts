import { describe, expect, it } from 'vitest'
import { nativeAssistantReplyCompleted, nativeAssistantReplyIsOk, safeCliResult } from '../../scripts/verify-ai-route-cli-output.mjs'

describe('隔离 CLI 验收输出', () => {
  it('只保留固定状态、壳、退出码和请求数，不传播路径、异常或 Key', () => {
    const result = safeCliResult('codex', 'configuration-failed', {
      exitCode: 1,
      requests: 0,
      path: '/customer/private/laixin-native-api-123',
      error: 'private error sk-customer-key-1234567890'
    })
    expect(result).toEqual({ shell: 'codex', status: 'configuration-failed', exitCode: 1, requests: 0, reason: 'configuration_failed' })
    expect(JSON.stringify(result)).not.toContain('/customer/private')
    expect(JSON.stringify(result)).not.toContain('sk-customer-key')
  })

  it('只接受各原生客户端结构化的最终 assistant OK，不把回显提示、空回复或错误文本当成功', () => {
    expect(nativeAssistantReplyIsOk('codex', [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',
      '{"type":"turn.completed"}'
    ].join('\n'))).toBe(true)
    expect(nativeAssistantReplyIsOk('claude', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'OK'
    }))).toBe(true)
    // Hermes can write a harmless setup/title line before its quiet-mode final answer.
    expect(nativeAssistantReplyIsOk('hermes', 'OK\n')).toBe(true)
    expect(nativeAssistantReplyIsOk('hermes', 'title helper unavailable\nOK\n')).toBe(true)

    for (const [shell, output] of [
      ['codex', 'Reply only OK.\n{"type":"turn.completed"}'],
      ['codex', '{"type":"item.completed","item":{"type":"agent_message","text":""}}\n{"type":"turn.completed"}'],
      ['codex', '{"type":"error","message":"OK"}'],
      ['claude', JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'OK' })],
      ['claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' })],
      ['hermes', 'Reply only OK.'],
      ['hermes', 'error: OK'],
      ['hermes', 'title helper unavailable\nerror: provider rejected\nOK']
    ] as const) {
      expect(nativeAssistantReplyIsOk(shell, output)).toBe(false)
    }
  })

  it('真上游验收只要求原生客户端完成并显示一条有效回答，不把模型标点差异误判为失败', () => {
    expect(nativeAssistantReplyCompleted('codex', [
      '{"type":"item.completed","item":{"type":"agent_message","text":"OK."}}',
      '{"type":"turn.completed"}'
    ].join('\n'))).toBe(true)
    expect(nativeAssistantReplyCompleted('claude', JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'OK.'
    }))).toBe(true)
    expect(nativeAssistantReplyCompleted('hermes', 'OK.\n')).toBe(true)
    for (const [shell, output] of [
      ['codex', '{"type":"turn.completed"}'],
      ['claude', JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'OK.' })],
      ['hermes', 'Error: provider rejected the request']
    ] as const) expect(nativeAssistantReplyCompleted(shell, output)).toBe(false)
  })
})

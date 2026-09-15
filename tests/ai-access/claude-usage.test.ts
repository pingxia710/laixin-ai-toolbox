import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseClaudeQuota, readClaudeQuota } from '../../app/main/ai-access/claude-usage'

const fixture = resolve('tests/ai-access/fixtures/claude-usage-cli.mjs')
describe('Claude 官方客户端用量协议', () => {
  it('不发送对话，只请求官方用量，跳过本机对话分析', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-usage-test-'))
    const requests = join(root, 'requests.jsonl')
    const result = await readClaudeQuota({ executable: process.execPath, args: [fixture, 'ready'] }, root, { ...process.env, CLAUDE_USAGE_REQUESTS: requests })
    expect(result).toMatchObject({ status: 'plan', plan: { level: 'max', windows: [{ remainingPercent: 77 }, { remainingPercent: null, resetsAt: null }] } })
    expect(JSON.stringify(result)).not.toContain('fixture-private')
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls.map(call => call.request.subtype)).toEqual(['initialize', 'get_usage'])
    expect(calls[1].request.skip_behaviors).toBe(true)
  })
  it.each(['empty', 'invalid', 'unsupported', 'request', 'hang'])('%s 不伪造额度，也不执行其他请求', async mode => {
    expect(await readClaudeQuota({ executable: process.execPath, args: [fixture, mode] }, tmpdir(), process.env, 300)).toEqual({ status: 'official-unavailable', plan: null })
  })
  it('未知数值不按零处理，动态模型窗口保留官方名字', () => {
    const result = parseClaudeQuota({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: '1', resets_at: 'bad' }, model_scoped: [{ display_name: '模型窗口', utilization: 40 }] } })
    expect(result.plan?.windows).toMatchObject([{ usedPercent: null, remainingPercent: null, resetsAt: null }, { name: '模型窗口', remainingPercent: 60 }])
  })
  it('取消时不启动客户端', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await readClaudeQuota({ executable: '/missing' }, tmpdir(), process.env, 300, controller.signal)).toEqual({ status: 'official-unavailable', plan: null })
  })
})

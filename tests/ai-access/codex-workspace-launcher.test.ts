import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchCodexWorkspaceThread } from '../../app/main/ai-access/codex-workspace-launcher'

const fixture = resolve('tests/ai-access/fixtures/codex-workspace-server.mjs')
let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })

describe('Codex 短时工作窗口创建器', () => {
  it('把来源绑定进持久线程、命名后回收 app-server', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspace-launcher-'))
    const requests = join(root, 'requests.jsonl')
    const pidFile = join(root, 'pid')
    const result = await launchCodexWorkspaceThread({ executable: process.execPath, args: [fixture] }, {
      cwd: root,
      codexHome: join(root, '.codex'),
      source: { id: 'deepseek', provider: 'laixin-deepseek', model: 'deepseek-flash', title: 'DeepSeek API · 新工作' },
      timeoutMs: 3_000,
      env: { ...process.env, WORKSPACE_FIXTURE_REQUESTS: requests, WORKSPACE_FIXTURE_PID: pidFile }
    })

    expect(result).toEqual({ threadId: '01999999-1111-7111-8111-111111111111', provider: 'laixin-deepseek', model: 'deepseek-flash' })
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
    expect(calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'thread/start', 'thread/inject_items', 'thread/name/set'])
    expect(calls[2].params).toMatchObject({ modelProvider: 'laixin-deepseek', model: 'deepseek-flash', ephemeral: false })
    expect(JSON.stringify(calls)).not.toContain('API key')
    const pid = Number(await readFile(pidFile, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2_500 })
  })

  it('官方线程显式绑定 openai，模型交给官方目录选择', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspace-launcher-'))
    const requests = join(root, 'requests.jsonl')
    const result = await launchCodexWorkspaceThread({ executable: process.execPath, args: [fixture] }, {
      cwd: root,
      codexHome: join(root, '.codex'),
      source: { id: 'official', provider: 'openai', title: 'OpenAI 官方 · 新工作' },
      timeoutMs: 3_000,
      env: { ...process.env, WORKSPACE_FIXTURE_REQUESTS: requests, WORKSPACE_FIXTURE_PID: join(root, 'pid') }
    })
    expect(result.provider).toBe('openai')
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls[2].params).toMatchObject({ modelProvider: 'openai', ephemeral: false })
    expect(calls[2].params).not.toHaveProperty('model')
  })
})

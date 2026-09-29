import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchCodexWorkspaceThread, readCodexWorkspaceBundledCatalog } from '../../app/main/ai-access/codex-workspace-launcher'

const fixture = resolve('tests/ai-access/fixtures/codex-workspace-server.mjs')
const bundledCatalogFixture = resolve('tests/ai-access/fixtures/codex-bundled-catalog-command.sh')
let root = ''
const fixturePids = new Set<number>()
afterEach(async () => {
  for (const pid of fixturePids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
  fixturePids.clear()
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('Codex 短时工作窗口创建器', () => {
  it('把来源绑定进持久线程、命名后回收 app-server', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspace-launcher-'))
    const requests = join(root, 'requests.jsonl')
    const pidFile = join(root, 'pid')
    const result = await launchCodexWorkspaceThread({ executable: process.execPath, args: [fixture] }, {
      cwd: root,
      codexHome: join(root, '.codex'),
      source: { id: 'multi', provider: 'laixin-multi', model: 'laixin.deepseek.deepseek-flash', title: '来信多模型 · 新对话' },
      timeoutMs: 3_000,
      env: { ...process.env, WORKSPACE_FIXTURE_REQUESTS: requests, WORKSPACE_FIXTURE_PID: pidFile }
    })

    expect(result).toEqual({ threadId: '01999999-1111-7111-8111-111111111111', provider: 'laixin-multi', model: 'laixin.deepseek.deepseek-flash' })
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
    expect(calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'thread/start', 'thread/inject_items', 'thread/name/set'])
    expect(calls[2].params).toMatchObject({ modelProvider: 'laixin-multi', model: 'laixin.deepseek.deepseek-flash', ephemeral: false })
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

  it('bundled 目录超时后会在 SIGTERM 被忽略时有界 SIGKILL 回收子进程', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-workspace-bundled-timeout-'))
    const pidFile = join(root, 'bundled-catalog.pid')
    const command = await bundledCatalogCommand(root)
    const startedAt = Date.now()
    const reading = readCodexWorkspaceBundledCatalog(command, {
      cwd: root,
      codexHome: join(root, '.codex'),
      timeoutMs: 50,
      env: { ...process.env, BUNDLED_CATALOG_FIXTURE_PID: pidFile }
    })
    const outcome = settlesWithin(reading, 1_500)
    const pid = await waitForFixturePid(pidFile)
    fixturePids.add(pid)

    try {
      expect(await outcome).toEqual({ kind: 'rejected', message: 'CODEX_WORKSPACE_TIMEOUT' })
      expect(Date.now() - startedAt).toBeLessThan(1_500)
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1_000, interval: 20 })
    } finally {
      try { process.kill(pid, 'SIGKILL') } catch { /* bounded test cleanup */ }
    }
  }, 4_000)
})

async function bundledCatalogCommand(workspace: string): Promise<{ readonly executable: string, readonly args: readonly string[] }> {
  const executable = join(workspace, 'fixture-codex')
  await writeFile(executable, await readFile(bundledCatalogFixture), { mode: 0o700 })
  return { executable, args: [] }
}

async function waitForFixturePid(path: string): Promise<number> {
  await vi.waitFor(async () => {
    const pid = Number(await readFile(path, 'utf8'))
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
  }, { timeout: 500, interval: 10 })
  return Number(await readFile(path, 'utf8'))
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<{ readonly kind: 'resolved' } | { readonly kind: 'rejected', readonly message: string } | { readonly kind: 'outer-timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        () => ({ kind: 'resolved' as const }),
        error => ({ kind: 'rejected' as const, message: error instanceof Error ? error.message : String(error) })
      ),
      new Promise<{ readonly kind: 'outer-timeout' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'outer-timeout' }), timeoutMs) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

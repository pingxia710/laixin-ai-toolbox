import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { shell } from 'electron'
import { registerActions } from '../../app/main/actions/download'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { loadCatalog } from '../../app/main/download/catalog'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TOOLBOX_SW01_TEST_USERDATA },
  dialog: {},
  shell: { openExternal: vi.fn(async () => undefined) }
}))

it('产品桥接不再提供下载、续传或代装动作，历史只读入口仍在', async () => {
  const failures: unknown[] = []
  const registry = new BridgeRegistry({ diagnostic: (_code, _name, error) => failures.push(error) })
  registerActions(registry)
  for (const [name, params] of [
    ['download.chooseLocal', { resourceId: 'codex-macos-arm64' }],
    ['download.start', { resourceId: 'codex-macos-arm64' }],
    ['download.cancel', { taskId: 'old-task' }],
    ['download.retry', { taskId: 'old-task' }],
    ['download.resume', { taskId: 'old-task' }],
    ['download.openInstaller', { taskId: 'old-task' }]
  ] as const) {
    await expect(registry.execute(name, params)).rejects.toThrow('ACTION_NOT_FOUND')
  }
  await expect(registry.execute('download.status', { taskId: 'missing' })).rejects.toThrow('ACTION_FAILED')
  await expect(registry.execute('download.openExternal', { resourceId: 'unlisted-official-page' })).rejects.toThrow('ACTION_FAILED')
  expect(failures.at(-1)).toEqual(new Error('DOWNLOAD_ENTRY_UNAVAILABLE'))
})

it('六款批准的官方页与已有 GitHub 入口都可打开，且不创建安装进度或下载记录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laixin-sw01-bridge-'))
  process.env.TOOLBOX_SW01_TEST_USERDATA = root
  try {
    const registry = new BridgeRegistry()
    registerActions(registry)
    const resources = [
      'codex-official-download', 'codex-github',
      'claude-code-official-install', 'claude-code-github',
      'hermes-official-download', 'hermes-github',
      'deepseek-harness-official-install', 'deepseek-harness-github',
      'zcode-official-download',
      'kimi-code-official-install', 'kimi-code-github'
    ]
    const catalog = loadCatalog()
    for (const [index, resourceId] of resources.entries()) {
      const result = await registry.execute('download.openExternal', { resourceId }) as { state: string }
      expect(result.state).toBe('opened-external')
      expect(shell.openExternal).toHaveBeenNthCalledWith(index + 1,
        catalog.resources.find((resource) => resource.id === resourceId)?.officialPageUrl)
    }
    expect(shell.openExternal).toHaveBeenCalledTimes(resources.length)
    expect(readdirSync(root)).toEqual([])
  } finally {
    delete process.env.TOOLBOX_SW01_TEST_USERDATA
    rmSync(root, { recursive: true, force: true })
    vi.clearAllMocks()
  }
})

it('历史下载任务可读取，读取不会恢复续传或改写记录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laixin-sw01-history-'))
  process.env.TOOLBOX_SW01_TEST_USERDATA = root
  const records = join(root, 'toolbox-download/download-records')
  mkdirSync(records, { recursive: true })
  const record = join(records, 'old-task.json')
  const original = JSON.stringify({ taskId: 'old-task', resourceId: 'codex-macos-arm64', authorizationId: '',
    state: 'interrupted-resumable', reason: '', message: '历史任务', receivedBytes: '1', totalBytes: '2', retryCount: '0',
    resumeEtag: '', resumeLastModified: '', localSha256: '', artifactPath: '', partPath: '', startedAt: '2026-09-01T00:00:00Z', endedAt: '' })
  writeFileSync(record, original)
  try {
    const registry = new BridgeRegistry()
    registerActions(registry)
    const status = await registry.execute('download.status', { taskId: 'old-task' }) as { state: string }
    expect(status.state).toBe('interrupted-resumable')
    expect(readFileSync(record, 'utf8')).toBe(original)
  } finally {
    delete process.env.TOOLBOX_SW01_TEST_USERDATA
    rmSync(root, { recursive: true, force: true })
  }
})

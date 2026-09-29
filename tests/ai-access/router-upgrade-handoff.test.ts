import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAiRouterUpdate, restoreAiRouterAfterUpdate } from '../../app/main/ai-access/router-upgrade-handoff'
import type { AiAccessState } from '../../app/main/ai-access/service'

const active: AiAccessState = {
  version: 1,
  selected: {},
  codexMode: 'multi',
  codexMultiRelay: { port: 43210, identitySecret: 'a'.repeat(64) },
  codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }],
  shellKeys: { codex: { deepseek: 'sk-fixture-router-handoff-0123456789' } }
}
const spec = { executable: '/fixture/toolbox', logDir: '/fixture/logs' }
let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('AI router 更新交接', () => {
  it('只有验证停止成功才返回回滚函数', async () => {
    const stop = vi.fn(async () => true)
    const refresh = vi.fn(async () => true)
    const restore = await prepareAiRouterUpdate('/fixture/user-data', spec, {
      store: { read: async () => active, write: async () => undefined },
      controller: { stop, refresh }
    })

    expect(stop).toHaveBeenCalledWith(active)
    await expect(restore?.()).resolves.toBeUndefined()
    expect(refresh).toHaveBeenCalledWith(active)
  })

  it('无法证明旧 owner 已停止时失败关闭', async () => {
    await expect(prepareAiRouterUpdate('/fixture/user-data', spec, {
      store: { read: async () => active, write: async () => undefined },
      controller: { stop: async () => false, refresh: async () => true }
    })).rejects.toThrow('AI_ROUTER_UPDATE_HANDOFF_FAILED')
  })

  it('已证明 owner 但停止结果不确定时先恢复旧路由再失败关闭', async () => {
    const refresh = vi.fn(async () => true)
    await expect(prepareAiRouterUpdate('/fixture/user-data', spec, {
      store: { read: async () => active, write: async () => undefined },
      controller: { stop: async () => { throw new Error('AI_ROUTER_STOP_UNCERTAIN') }, refresh }
    })).rejects.toThrow('AI_ROUTER_UPDATE_HANDOFF_FAILED')
    expect(refresh).toHaveBeenCalledWith(active)
  })

  it('停止不确定且旧路由无法恢复时返回专用失败码', async () => {
    await expect(prepareAiRouterUpdate('/fixture/user-data', spec, {
      store: { read: async () => active, write: async () => undefined },
      controller: { stop: async () => { throw new Error('AI_ROUTER_STOP_INCOMPLETE') }, refresh: async () => false }
    })).rejects.toThrow('AI_ROUTER_UPDATE_RESTORE_FAILED')
  })

  it('更新后的新路由只有 HMAC-ready runtime 与同一 seat 都已证明才放行', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-update-restore-'))
    const routerRoot = join(root, 'ai-access')
    const runtime = { pid: 741, bootId: 'a'.repeat(32), port: 43210, token: 'b'.repeat(64) }
    await mkdir(routerRoot)
    await writeFile(join(routerRoot, 'ai-router.seat'), JSON.stringify({ pid: runtime.pid, bootId: runtime.bootId }))
    const ensureReady = vi.fn(async () => ({ runtime, baseUrl: `http://127.0.0.1:${String(runtime.port)}` }))

    await expect(restoreAiRouterAfterUpdate(root, spec, {
      store: { read: async () => active, write: async () => undefined }, controller: { ensureReady }
    })).resolves.toBe('ready')

    expect(ensureReady).toHaveBeenCalledWith(active, true)
  })

  it('更新后的 runtime 和 seat 不一致时失败关闭', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-update-seat-mismatch-'))
    const routerRoot = join(root, 'ai-access')
    const runtime = { pid: 742, bootId: 'a'.repeat(32), port: 43210, token: 'b'.repeat(64) }
    await mkdir(routerRoot)
    await writeFile(join(routerRoot, 'ai-router.seat'), JSON.stringify({ pid: 743, bootId: runtime.bootId }))

    await expect(restoreAiRouterAfterUpdate(root, spec, {
      store: { read: async () => active, write: async () => undefined },
      controller: { ensureReady: async () => ({ runtime, baseUrl: `http://127.0.0.1:${String(runtime.port)}` }) }
    })).resolves.toBe('failed')
  })
})

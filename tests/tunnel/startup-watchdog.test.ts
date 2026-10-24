import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armStartupWatchdog, STARTUP_WATCHDOG_EXIT_CODE, startupContextIssue } from '../../sidecar/mac/tunnel-daemon.mjs'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('守护启动看门狗与上下文自检', () => {
  it('启动上下文缺适配器时在接管前给出安全原因', () => {
    const root = mkdtempSync(join(tmpdir(), 'startup-context-'))
    roots.push(root)
    expect(startupContextIssue({
      dataDir: root,
      adapterPath: join(root, 'missing-adapter.mjs'),
      platform: 'darwin'
    })).toBe('适配器文件不存在')
  })

  it('Windows 常驻真实适配器缺放行钥匙时提前拒绝，路径带空格也能识别', () => {
    const adapter = 'C:\\Program Files\\来信\\managed-adapter.mjs'
    writeFileSync(adapter, '')
    try {
      expect(startupContextIssue({
        dataDir: 'C:\\Users\\tester\\AppData\\Roaming\\来信',
        adapterPath: adapter,
        resident: true,
        platform: 'win32',
        env: {}
      })).toBe('Windows 真实适配器未获运行放行')
      expect(startupContextIssue({
        dataDir: 'C:\\Users\\tester\\AppData\\Roaming\\来信',
        adapterPath: adapter,
        resident: true,
        platform: 'win32',
        env: { TOOLBOX_REAL_NETWORK_ADAPTER: '1' }
      })).toBeUndefined()
    } finally {
      rmSync(adapter, { force: true })
    }
  })

  it('已有本轮 state 时看门狗立即收口，不误杀慢连接', () => {
    const root = mkdtempSync(join(tmpdir(), 'startup-watchdog-state-'))
    roots.push(root)
    writeFileSync(join(root, 'state.json'), JSON.stringify({ state: 'connecting', runId: 'run-1', updatedAt: Date.now() }))
    const exit = vi.fn()
    const stop = armStartupWatchdog({ dataDir: root, runId: 'run-1', timeoutMs: 10, exit })
    stop()
    expect(exit).not.toHaveBeenCalled()
  })

  it('启动恢复已发布本轮 recovery-owner 时看门狗不误杀慢机恢复', () => {
    const root = mkdtempSync(join(tmpdir(), 'startup-watchdog-recovery-'))
    roots.push(root)
    writeFileSync(join(root, 'recovery-owner.json'), JSON.stringify({ runId: 'run-recovery', generation: 2 }))
    const exit = vi.fn()
    const stop = armStartupWatchdog({ dataDir: root, runId: 'run-recovery', timeoutMs: 10, exit })
    stop()
    expect(exit).not.toHaveBeenCalled()
  })

  it('120 秒预算内没有本轮 state 时退出 75，交给计划任务重拉', async () => {
    const root = mkdtempSync(join(tmpdir(), 'startup-watchdog-timeout-'))
    roots.push(root)
    const exit = vi.fn()
    armStartupWatchdog({ dataDir: root, runId: 'run-stuck', timeoutMs: 20, exit })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(exit).toHaveBeenCalledWith(STARTUP_WATCHDOG_EXIT_CODE)
  })
})

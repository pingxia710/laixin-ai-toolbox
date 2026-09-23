// N-26 轻暂停的主进程侧轻保证:客户暂停落定(意图 user-disconnected 且账本结清)后,主进程做一次
// 幂等的常驻任务禁用检查——Windows `schtasks /change /disable`(形状照 resident.ts wake 的 enable
// 反向);mac 无需动作(launchd KeepAlive.SuccessfulExit=false 由守护自禁覆盖)。
// 守护干净退出本会自禁任务(sidecar settleResidentTask),这里是自禁没写上时的补手。
// 注入假 schtasks 记录调用,核对真实命令形状;未修代码上本用例红(没有禁用调用发生)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const control = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[] }>
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const fakeExecFile = (file: string, args: string[], options?: unknown, maybeCallback?: unknown) => {
    control.calls.push({ file, args: args as string[] })
    const callback = (typeof options === 'function' ? options : maybeCallback) as
      ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    queueMicrotask(() => callback?.(null, '', ''))
    return { unref() { /* 无进程可等 */ } }
  }
  return { ...actual, execFile: fakeExecFile }
})

import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { makeResidentRuntime, residentSpecFor } from '../../app/main/tunnel/resident-bridge'
import { RESIDENT_TASK } from '../../app/main/tunnel/platform/resident'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  control.calls.length = 0
})

const disableCalls = (): Array<{ file: string; args: string[] }> =>
  control.calls.filter((call) => call.file === 'schtasks.exe' && call.args[0] === '/change' && call.args.includes('/disable'))

interface Fixture {
  readonly dataDir: string
  readonly tunnel: TunnelService
}

// 全新数据目录 = 账本本就结清:暂停落定的条件立即成立,首个轮询 tick 就该触发禁用检查。
function setup(platform: 'windows' | 'macos'): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), `n26-pause-${platform}-`))
  roots.push(dataDir)
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const runtime = makeResidentRuntime({
    dataDir,
    platform,
    supported: true,
    probeInstalled: () => false,
    spec: () => residentSpecFor({ executable: '/工具箱', launch: { daemonPath: '/d.mjs', adapterPath: '/a.mjs', env: {} }, dataDir, logDir: '/logs' }),
    install: async () => ({ installed: true }),
    uninstall: async () => undefined,
    wake: async () => ({ woken: true })
  })
  const tunnel = new TunnelService({
    dataDir, platform, sidecarDir, trust: { whitelistDigests: [], signingPublicKeys: [] }, now: () => Date.now(),
    picker: async () => undefined, spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
    routesFile: join(sidecarDir, 'routes.default.json'), resident: runtime.bridge
  })
  return { dataDir, tunnel }
}

const waitForDisableCall = async (): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && disableCalls().length === 0) await new Promise((resolve) => setTimeout(resolve, 25))
}

describe('N-26 暂停落定后确保常驻任务禁用', () => {
  it('Windows:客户暂停落定后记录到 schtasks /change /disable(幂等,形状照 wake 的 enable 反向)', async () => {
    const f = setup('windows')
    expect((await f.tunnel.stop()).outcome).toBe('stopped')
    await waitForDisableCall()
    const calls = disableCalls()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls.at(-1)).toEqual({ file: 'schtasks.exe', args: ['/change', '/tn', RESIDENT_TASK, '/disable'] })
  })

  it('mac:不做额外动作(launchd 由守护自禁覆盖),⛔ 出现 disable 类调用', async () => {
    const f = setup('macos')
    expect((await f.tunnel.stop()).outcome).toBe('stopped')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(disableCalls()).toEqual([])
  })
})

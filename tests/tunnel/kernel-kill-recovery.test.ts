// 对抗检测轮 09-13 · 创始人真机那一幕的真进程复刻:真守护进程 + 真 Xray 内核 + 本机 REALITY 假节点 + 假系统设置。
// 连上之后从外面把 xray 内核 SIGKILL(相当于被杀软干掉):
//   ① 守护必须先把系统代理还给客户(假设置回到空),状态说「已先恢复电脑正常上网」;
//   ② 然后自己把内核拉起来重新接上,系统代理重新写回;
//   ③ 用户断开 → 假设置回到空;退出 → 进程正常结束。
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { readDaemonState } from '../../app/main/tunnel/status-service'
import { layout, writeFileAtomic } from '../../app/main/tunnel/paths'
import { freePort, startRealityNode } from './fixtures/reality-node'
import { fakeAdapterEnv, makeTempDir, readFakeStore, removeTempDir, waitFor } from './helpers'

it('内核被外部杀掉:先还系统代理、再自己拉起内核重新接上;断开还原;退出干净', async () => {
  const root = makeTempDir('laixin-kernel-kill-')
  const node = await startRealityNode(root)
  let child: ChildProcess | undefined
  try {
    const dataDir = join(root, 'data')
    const storePath = join(root, 'fake-system.json')
    const port = await freePort()
    const credentialPath = join(root, 'vless.json')
    writeFileSync(credentialPath, JSON.stringify(node.credential), { mode: 0o600 })
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'connected', authorization: { id: 'local-test', expiresAt: Date.now() + 60_000 }, bridgePort: port,
      connector: { kind: 'vless-reality', node: node.node, credentialPath, verifyUrl: node.verifyUrl, localPort: port, timeoutMs: 500 } }))
    const daemonPath = fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
    child = spawn(process.execPath, [daemonPath, 'start', '--data-dir', dataDir, '--adapter', fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url)),
      '--intent-poll-ms', '50', '--verify-interval-ms', '200'], { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''
    child.stdout?.on('data', (chunk) => { logs += chunk })
    child.stderr?.on('data', (chunk) => { logs += chunk })
    await waitFor(() => readDaemonState(dataDir)?.state === 'connected', 8000)
    expect(Object.keys(readFakeStore(storePath)).length).toBeGreaterThan(0)

    // 从外面杀内核(SIGKILL,清理钩子不跑),pid 在桥的记档里
    const record = JSON.parse(readFileSync(join(dataDir, 'xray-bridge.json.pid'), 'utf8')) as { pid: number }
    process.kill(record.pid, 'SIGKILL')
    // ① 先还系统代理
    await waitFor(() => readDaemonState(dataDir)?.state === 'error' && Object.keys(readFakeStore(storePath)).length === 0, 4000)
    expect(readDaemonState(dataDir)?.message).toContain('已先恢复电脑正常上网')
    // ② 自己拉起内核、重新接上、设置写回
    await waitFor(() => readDaemonState(dataDir)?.state === 'connected', 10_000)
    expect(Object.keys(readFakeStore(storePath)).length).toBeGreaterThan(0)
    const again = JSON.parse(readFileSync(join(dataDir, 'xray-bridge.json.pid'), 'utf8')) as { pid: number }
    expect(again.pid).not.toBe(record.pid)
    // ③ 断开还原、退出干净
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'user-disconnected' }))
    await waitFor(() => readDaemonState(dataDir)?.state === 'stopped-restored', 4000)
    expect(readFakeStore(storePath)).toEqual({})
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'shutdown' }))
    await waitFor(() => child?.exitCode !== null, 4000)
    expect(child.exitCode).toBe(0)
    expect(logs).toContain('本机中继不在监听:已先把系统代理还给客户')
    expect(logs).not.toContain(node.credential.uuid)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      try { await waitFor(() => child?.exitCode !== null || child?.signalCode !== null, 3000) } catch { child.kill('SIGKILL') }
    }
    await node.close()
    removeTempDir(root)
  }
}, 40_000)

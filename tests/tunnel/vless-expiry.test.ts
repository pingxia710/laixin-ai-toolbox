import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layout, writeFileAtomic } from '../../app/main/tunnel/paths'
import { readDaemonState } from '../../app/main/tunnel/status-service'
import { fakeAdapterEnv, makeTempDir, readFakeStore, removeTempDir, waitFor } from './helpers'
import { freePort, startRealityNode } from './fixtures/reality-node'

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(300, () => finish(false))
  })
}

it('真实 Xray 通道连接后到期：关闭监听、恢复假系统设置、停止自动重连', async () => {
  const root = makeTempDir('laixin-vless-expiry-')
  let child: ChildProcess | undefined
  const node = await startRealityNode(root)
  try {
    const dataDir = join(root, 'data')
    const storePath = join(root, 'fake-system.json')
    const port = await freePort()
    const credentialPath = join(root, 'vless.json')
    writeFileSync(credentialPath, JSON.stringify(node.credential), { mode: 0o600 })
    const expiresAt = Date.now() + 5000
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'connected', authorization: { id: 'local-expiry-test', expiresAt }, bridgePort: port,
      connector: { kind: 'vless-reality', node: node.node, credentialPath, verifyUrl: node.verifyUrl, localPort: port, timeoutMs: 500 } }))
    const executable = process.env.TOOLBOX_TEST_PACKAGED_EXECUTABLE
    const daemonPath = process.env.TOOLBOX_TEST_PACKAGED_RESOURCES
      ? join(process.env.TOOLBOX_TEST_PACKAGED_RESOURCES, 'sidecar/mac/tunnel-daemon.mjs')
      : fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
    child = spawn(executable ?? process.execPath, [daemonPath, 'start', '--data-dir', dataDir, '--adapter', fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url)), '--intent-poll-ms', '50', '--verify-interval-ms', '200'], {
      env: { ...process.env, ...fakeAdapterEnv(storePath), ...(executable ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''
    child.stdout?.on('data', (chunk) => { logs += chunk })
    child.stderr?.on('data', (chunk) => { logs += chunk })
    await waitFor(() => readDaemonState(dataDir)?.state === 'connected', 4000)
    const connectedAt = Date.now()
    expect(await listening(port)).toBe(true)
    expect(Object.keys(readFakeStore(storePath)).length).toBeGreaterThan(0)
    await waitFor(() => readDaemonState(dataDir)?.code === 'TUNNEL_AUTHORIZATION_EXPIRED', 7000)
    const stoppedAt = Date.now()
    expect(await listening(port)).toBe(false)
    expect(readFakeStore(storePath)).toEqual({})
    const requests = node.requests()
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(node.requests()).toBe(requests)
    expect(await listening(port)).toBe(false)
    expect(logs).not.toContain(node.credential.uuid)
    expect(logs).not.toContain(node.credential.publicKey)
    expect(logs).not.toContain('重连尝试')
    if (process.env.TOOLBOX_NETWORK_EVIDENCE_DIR) {
      mkdirSync(process.env.TOOLBOX_NETWORK_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(process.env.TOOLBOX_NETWORK_EVIDENCE_DIR, 'expiry-runtime.json'), JSON.stringify({ connectedAt, expiresAt, stoppedAt, stopDelayMs: stoppedAt - expiresAt,
        realXray: true, onlyLoopback: true, systemAdapterIsFixture: true, listenerClosed: true, automaticReconnectStopped: true, packagedRuntime: Boolean(executable) }, null, 2))
    }
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'shutdown' }))
    await waitFor(() => child?.exitCode !== null, 4000)
    expect(child.exitCode).toBe(0)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      try { await waitFor(() => child?.exitCode !== null || child?.signalCode !== null, 3000) } catch { child.kill('SIGKILL') }
    }
    await node.close()
    removeTempDir(root)
  }
}, 20000)

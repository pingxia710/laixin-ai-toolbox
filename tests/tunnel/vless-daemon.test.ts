import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layout, writeFileAtomic } from '../../app/main/tunnel/paths'
import { readDaemonState, readTrafficObservation } from '../../app/main/tunnel/status-service'
import { fakeAdapterEnv, makeTempDir, readFakeStore, removeTempDir, waitFor } from './helpers'
import { freePort, startRealityNode } from './fixtures/reality-node'

it('生产守护接 VLESS：真实回环连接、失败状态、自动恢复、断开恢复假系统设置并退出', async () => {
  const root = makeTempDir('laixin-vless-daemon-')
  let child: ChildProcess | undefined
  const node = await startRealityNode(root)
  try {
    const dataDir = join(root, 'data')
    const storePath = join(root, 'fake-system.json')
    const port = await freePort()
    const credentialPath = join(root, 'vless.json')
    writeFileSync(credentialPath, JSON.stringify(node.credential), { mode: 0o600 })
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'connected', authorization: { id: 'local-test', expiresAt: Date.now() + 60000 }, bridgePort: port, connector: { kind: 'vless-reality', node: node.node, credentialPath, verifyUrl: node.verifyUrl, localPort: port, timeoutMs: 500 } }))
    const packagedExecutable = process.env.TOOLBOX_TEST_PACKAGED_EXECUTABLE
    const daemonPath = process.env.TOOLBOX_TEST_PACKAGED_RESOURCES
      ? join(process.env.TOOLBOX_TEST_PACKAGED_RESOURCES, 'sidecar/mac/tunnel-daemon.mjs')
      : fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
    child = spawn(packagedExecutable ?? process.execPath, [daemonPath, 'start', '--data-dir', dataDir, '--adapter', fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url)), '--intent-poll-ms', '50', '--verify-interval-ms', '200'], { env: { ...process.env, ...fakeAdapterEnv(storePath), ...(packagedExecutable ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''
    child.stdout?.on('data', (chunk) => { logs += chunk })
    child.stderr?.on('data', (chunk) => { logs += chunk })
    await waitFor(() => readDaemonState(dataDir)?.state === 'connected', 8000)
    expect(readDaemonState(dataDir)?.exitIp).toBe('203.0.113.42')
    await waitFor(() => (readTrafficObservation(dataDir)?.updatedAt ?? 0) > 0, 4000)
    expect(readTrafficObservation(dataDir)).toMatchObject({ source: 'local-proxy-entry' })
    expect(readTrafficObservation(dataDir)?.uploadBytes).toBeGreaterThan(0)
    expect(readTrafficObservation(dataDir)?.downloadBytes).toBeGreaterThan(0)
    expect(Object.keys(readFakeStore(storePath)).length).toBeGreaterThan(0)
    await node.stop()
    await waitFor(() => readDaemonState(dataDir)?.state === 'error', 4000)
    await node.start()
    await waitFor(() => readDaemonState(dataDir)?.state === 'connected', 8000)
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'user-disconnected' }))
    await waitFor(() => readDaemonState(dataDir)?.state === 'stopped-restored', 4000)
    await waitFor(() => readTrafficObservation(dataDir) === undefined, 2000)
    expect(readFakeStore(storePath)).toEqual({})
    writeFileAtomic(layout.intent(dataDir), JSON.stringify({ desired: 'shutdown' }))
    await waitFor(() => child?.exitCode !== null, 4000)
    expect(child.exitCode).toBe(0)
    expect(logs).not.toContain(node.credential.uuid)
    expect(logs).toContain('重连尝试')
    expect(logs).not.toContain(node.credential.publicKey)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      try { await waitFor(() => child?.exitCode !== null || child?.signalCode !== null, 3000) }
      catch { child.kill('SIGKILL') }
    }
    await node.close()
    removeTempDir(root)
  }
}, 25000)

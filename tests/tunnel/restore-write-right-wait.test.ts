// N-23 写权从「0 秒抢」改「有界等」:一次性恢复子进程(acquireWriteRight)对被占的写权做有界等待
// (对齐甲-2 梯子的节奏语义),等到就恢复,等不到才按 TUNNEL_WRITE_RIGHT_HELD 如实回报。
// 基线:timeoutMs 0 秒探测,常驻守护/另一份安装持权的瞬间窗口直接失败,账本没机会被碰。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { fakeAdapterEnv, makeTempDir, readFakeOps, waitFor } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function launchRestore(dataDir: string, storePath: string, extraEnv: Record<string, string> = {}): ReturnType<typeof spawn> {
  const daemonPath = fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
  const adapterPath = fileURLToPath(new URL('./fixtures/recording-write-right-adapter.mjs', import.meta.url))
  return spawn(process.execPath, [daemonPath, 'restore', '--data-dir', dataDir, '--adapter', adapterPath],
    { env: { ...process.env, ...fakeAdapterEnv(storePath), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
}

// 硬重启现场:上次连接写下的设置还在系统里生效,账本待结算。
function seedInterrupted(dataDir: string, storePath: string): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(storePath, `${JSON.stringify({ 'Wi-Fi/socks-proxy': { enabled: true, host: '127.0.0.1', port: 18080 } }, null, 1)}\n`)
  writeFileSync(join(dataDir, 'ledger.json'), `${JSON.stringify([
    { id: 'n23-wr-1', kind: 'setting', service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: null, writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 },
      sessionToken: 'previous-session', time: 1, status: 'applied', note: '' }
  ], null, 1)}\n`, { mode: 0o600 })
}

it('一次性恢复拿写权是有界等待:请求 15s 超时(基线:0 秒抢);等不到 → TUNNEL_WRITE_RIGHT_HELD 如实回报、账本不碰', async () => {
  const root = makeTempDir('n23-write-right-wait-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  seedInterrupted(dataDir, storePath)
  const child = launchRestore(dataDir, storePath)
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk) })
  child.stderr?.resume()
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', (exitCode) => resolve(exitCode))
    child.once('error', reject)
  })
  // 写权被持:有界等待后仍拿不到 → 如实回报,exit 65,账本原样(等待者/席位守护继续负责)
  expect(code).toBe(65)
  const requests = readFakeOps(storePath).filter((op) => op.op === 'acquireWriteRight')
  expect(requests.length).toBeGreaterThan(0)
  expect(requests[0].value).toBe(15_000) // 基线在这里是 0:0 秒抢
  expect(stdout).toContain('"restored":0')
  const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { code?: string }
  expect(state.code).toBe('TUNNEL_WRITE_RIGHT_HELD')
  const ledger = JSON.parse(readFileSync(join(dataDir, 'ledger.json'), 'utf8')) as Array<{ id: string; status: string }>
  expect(ledger.find((entry) => entry.id === 'n23-wr-1')?.status).toBe('applied')
}, 30_000)

it('有界等待等到写权(持权方在窗口内交出):恢复照常完成,exit 0、账本结清', async () => {
  const root = makeTempDir('n23-write-right-acquire-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  seedInterrupted(dataDir, storePath)
  const child = launchRestore(dataDir, storePath, { FAKE_WRITE_RIGHT_ACQUIRED: '1' })
  child.stdout?.resume()
  child.stderr?.resume()
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', (exitCode) => resolve(exitCode))
    child.once('error', reject)
  })
  expect(code).toBe(0)
  await waitFor(() => existsSync(join(dataDir, 'state.json')), 5_000)
  const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { state?: string }
  expect(state.state).toBe('stopped-restored')
  const ledger = JSON.parse(readFileSync(join(dataDir, 'ledger.json'), 'utf8')) as Array<{ id: string; status: string }>
  expect(ledger.find((entry) => entry.id === 'n23-wr-1')?.status).toBe('restored')
}, 30_000)

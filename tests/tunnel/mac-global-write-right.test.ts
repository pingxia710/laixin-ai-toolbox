import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireWriteRight } from '../../sidecar/mac/macos-write-right.mjs'
import { composeManagedAdapters } from '../../sidecar/mac/managed-adapter.mjs'
import { appendSettingEntry, ledgerFailure } from '../../sidecar/mac/ledger.mjs'
import { installCrashBailout } from '../../sidecar/mac/daemon-core.mjs'
import { restoreLedger } from '../../sidecar/mac/restore.mjs'
import { guardedResidentSelfHeal, withWriteRight } from '../../sidecar/mac/write-right-owner.mjs'
import { makeTempDir } from './helpers'

const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface WorkerLine { state: string; code?: string; port?: number; restored?: number; abandonedRecovered?: boolean }

function launchWorker(root: string, name: string, port: number, faultMode?: string): ChildProcessWithoutNullStreams {
  const worker = fileURLToPath(new URL('./fixtures/mac-write-right-worker.mjs', import.meta.url))
  const args = [worker, join(root, 'global', 'write-right.json'), join(root, name), join(root, 'system.json'), String(port)]
  if (faultMode !== undefined) args.push(faultMode)
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: join(root, 'home') }
  })
  children.push(child)
  return child
}

function nextLine(child: ChildProcessWithoutNullStreams): Promise<WorkerLine> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      child.stdout.off('data', onData)
      resolve(JSON.parse(buffer.slice(0, newline)) as WorkerLine)
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.stderr.once('data', (chunk) => reject(new Error(String(chunk))))
  })
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<WorkerLine> {
  const line = nextLine(child)
  child.stdin.write('stop\n')
  const result = await line
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
  })
  return result
}

function systemState(root: string): { enabled: boolean; host: string; port: number } {
  return JSON.parse(readFileSync(join(root, 'system.json'), 'utf8')) as { enabled: boolean; host: string; port: number }
}

function prepare(): string {
  const root = makeTempDir('mac-global-write-right-')
  roots.push(root)
  mkdirSync(join(root, 'global'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'system.json'), `${JSON.stringify({ enabled: false, host: '', port: 0 })}\n`, { mode: 0o600 })
  return root
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`等待争用者就绪超时:${paths.join(',')}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function managedSystem(root: string) {
  const lockPath = join(root, 'global', 'write-right.json')
  const ref = { service: 'FakeSystem', item: 'secure-web-proxy' }
  let system = { enabled: false, host: '', port: 0 }
  const network = {
    preflight() {}, managedItems: () => [], read: () => system,
    write: (_ref: unknown, value: typeof system) => { system = value },
    valuesEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  }
  const terminal = {
    service: 'TerminalEnvironment' as const, enabled: false, owns: () => false,
    preflight() {}, managedItems: () => [], read: () => undefined, write() {}, valuesEqual: () => true, restoredValueMatches: () => true
  }
  const adapter = composeManagedAdapters(network, terminal, (options) => acquireWriteRight({
    ...options, lockPath, dataDir: join(root, 'data-owner')
  }))
  return { adapter, lockPath, ref, system: () => system, setSystem: (value: typeof system) => { system = value } }
}

describe('macOS 跨安装与 dataDir 的系统代理全局写权', () => {
  it('两个真实进程只允许一方写；B 先退、A 后退时共享系统代理回到客户原值', async () => {
    const root = prepare()
    const a = launchWorker(root, 'data-a', 18080)
    expect(await nextLine(a)).toMatchObject({ state: 'connected', port: 18080 })
    const b = launchWorker(root, 'data-b', 18180)
    expect(await nextLine(b)).toEqual({ state: 'error', code: 'held' })
    expect(systemState(root)).toEqual({ enabled: true, host: '127.0.0.1', port: 18080 })
    expect(await stop(a)).toMatchObject({ state: 'stopped' })
    expect(systemState(root)).toEqual({ enabled: false, host: '', port: 0 })
  })

  it('A 先完整交还后 B 才能写；B 再退出不会把系统代理还到 A 的死端口', async () => {
    const root = prepare()
    const a = launchWorker(root, 'data-a', 18080)
    expect(await nextLine(a)).toMatchObject({ state: 'connected' })
    expect(await stop(a)).toMatchObject({ state: 'stopped' })
    const b = launchWorker(root, 'data-b', 18180)
    expect(await nextLine(b)).toMatchObject({ state: 'connected', port: 18180 })
    expect(await stop(b)).toMatchObject({ state: 'stopped' })
    expect(systemState(root)).toEqual({ enabled: false, host: '', port: 0 })
  })

  it('前任异常退出后按前任 dataDir 还原再接管，最终不会恢复到前任死端口', async () => {
    const root = prepare()
    const a = launchWorker(root, 'data-a', 18080)
    expect(await nextLine(a)).toMatchObject({ state: 'connected' })
    a.kill('SIGKILL')
    await new Promise<void>((resolve) => a.once('exit', () => resolve()))

    const b = launchWorker(root, 'data-b', 18180)
    expect(await nextLine(b)).toMatchObject({ state: 'connected', port: 18180, abandonedRecovered: true })
    expect(await stop(b)).toMatchObject({ state: 'stopped' })
    expect(systemState(root)).toEqual({ enabled: false, host: '', port: 0 })
    const previousLedger = JSON.parse(readFileSync(join(root, 'data-a', 'ledger.json'), 'utf8')) as Array<{ status: string }>
    expect(previousLedger.every((entry) => entry.status === 'restored')).toBe(true)
  })

  it('三个争用者同时回收同一 stale owner：恰好一方取得席位，其余只读到 held，最终仍还回客户原值', async () => {
    const root = prepare()
    const a = launchWorker(root, 'data-a', 18080)
    expect(await nextLine(a)).toMatchObject({ state: 'connected', port: 18080 })
    a.kill('SIGKILL')
    await new Promise<void>((resolve) => a.once('exit', () => resolve()))

    const contenders = [
      launchWorker(root, 'data-b', 18180, 'wait-for-start'),
      launchWorker(root, 'data-c', 18280, 'wait-for-start'),
      launchWorker(root, 'data-d', 18380, 'wait-for-start')
    ]
    await waitForFiles(['data-b', 'data-c', 'data-d'].map((name) => join(root, `${name}.ready`)))
    writeFileSync(join(root, 'global', 'start-three-way'), 'go\n', { mode: 0o600 })
    const outcomes = await Promise.all(contenders.map(nextLine))
    expect(outcomes.filter((outcome) => outcome.state === 'connected')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.state === 'error')).toEqual([
      { state: 'error', code: 'held' },
      { state: 'error', code: 'held' }
    ])
    const winner = contenders[outcomes.findIndex((outcome) => outcome.state === 'connected')]
    expect(await stop(winner)).toMatchObject({ state: 'stopped' })
    expect(systemState(root)).toEqual({ enabled: false, host: '', port: 0 })
  })

  it('回收者移除旧锁后被杀：责任已先落盘，下一进程仍恢复前任账本', async () => {
    const root = prepare()
    const a = launchWorker(root, 'data-a', 18080)
    expect(await nextLine(a)).toMatchObject({ state: 'connected', port: 18080 })
    a.kill('SIGKILL')
    await new Promise<void>((resolve) => a.once('exit', () => resolve()))

    const interrupted = launchWorker(root, 'data-interrupted', 18180, 'crash-after-stale-removed')
    await new Promise<void>((resolve) => interrupted.once('exit', () => resolve()))
    expect(interrupted.signalCode).toBe('SIGKILL')
    expect(existsSync(join(root, 'global', 'write-right.json.recovery'))).toBe(true)

    const b = launchWorker(root, 'data-b', 18280)
    expect(await nextLine(b)).toMatchObject({ state: 'connected', port: 18280, abandonedRecovered: true })
    expect(await stop(b)).toMatchObject({ state: 'stopped' })
    expect(systemState(root)).toEqual({ enabled: false, host: '', port: 0 })
    expect(existsSync(join(root, 'global', 'write-right.json.recovery'))).toBe(false)
    const previousLedger = JSON.parse(readFileSync(join(root, 'data-a', 'ledger.json'), 'utf8')) as Array<{ status: string }>
    expect(previousLedger.every((entry) => entry.status === 'restored')).toBe(true)
  })

  it('完成凭据前后两个崩溃点都有可接力状态，最终不留下死代理', async () => {
    for (const faultMode of ['crash-after-recovery-completed', 'crash-after-recovery-removed']) {
      const root = prepare()
      const a = launchWorker(root, 'data-a', 18080)
      expect(await nextLine(a)).toMatchObject({ state: 'connected', port: 18080 })
      a.kill('SIGKILL')
      await new Promise<void>((resolve) => a.once('exit', () => resolve()))

      const interrupted = launchWorker(root, `data-${faultMode}`, 18180, faultMode)
      await new Promise<void>((resolve) => interrupted.once('exit', () => resolve()))
      expect(interrupted.signalCode).toBe('SIGKILL')
      expect(existsSync(join(root, 'global', 'write-right.json.recovery-completed'))).toBe(true)
      expect(existsSync(join(root, 'global', 'write-right.json.recovery'))).toBe(faultMode === 'crash-after-recovery-completed')

      const c = launchWorker(root, `data-c-${faultMode}`, 18280)
      expect(await nextLine(c)).toMatchObject({ state: 'connected', port: 18280, abandonedRecovered: true })
      expect(await stop(c)).toMatchObject({ state: 'stopped' })
      expect(systemState(root)).toEqual({ enabled: false, host: '', port: 0 })
    }
  })

  it('完成阶段连续 fsync 失败时不丢唯一恢复责任，下一进程仍拿到原 owner', () => {
    const moduleUrl = new URL('../../sidecar/mac/macos-write-right.mjs', import.meta.url).href
    const script = `
      import fs from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      import { join } from 'node:path'
      import { mkdtempSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      const { acquireWriteRight } = await import(${JSON.stringify(moduleUrl)})
      const originalFsync = fs.fsyncSync
      const root = mkdtempSync(join(tmpdir(), 'mac-write-right-fsync-'))
      const lockPath = join(root, 'write-right.json')
      fs.writeFileSync(lockPath, JSON.stringify({
        version: 1, pid: 424242, startIdentity: 'dead-owner', token: 'a'.repeat(32), dataDir: join(root, 'old')
      }) + '\\n', { mode: 0o600 })
      const first = acquireWriteRight({
        lockPath,
        dataDir: join(root, 'new-a'),
        processAlive: () => false,
        processIdentity: () => 'new-owner-a'
      })
      if (first.acquired !== true || first.abandoned !== true) throw new Error('STALE_OWNER_NOT_ACQUIRED')
      let fsyncCalls = 0
      fs.fsyncSync = (...args) => {
        fsyncCalls += 1
        if (fsyncCalls >= 2) throw new Error('INJECTED_CONTINUOUS_FSYNC_FAILURE')
        return originalFsync(...args)
      }
      syncBuiltinESMExports()
      const completed = first.completeRecovery()
      first.release()
      const recoveryExists = fs.existsSync(lockPath + '.recovery')
      fs.fsyncSync = originalFsync
      syncBuiltinESMExports()
      const second = acquireWriteRight({
        lockPath,
        dataDir: join(root, 'new-b'),
        processAlive: () => false,
        processIdentity: () => 'new-owner-b'
      })
      console.log(JSON.stringify({
        completed,
        recoveryExists,
        fsyncCalls,
        secondAcquired: second.acquired,
        secondAbandoned: second.acquired ? second.abandoned : null,
        previousToken: second.acquired ? second.previousOwner?.token : null
      }))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      completed: false,
      recoveryExists: true,
      secondAcquired: true,
      secondAbandoned: true,
      previousToken: 'a'.repeat(32)
    })
  })

  it('前任坏账本先 recoverLedger 再 restore，不能让 stale owner 永久卡住', () => {
    const root = prepare()
    const previousDataDir = join(root, 'data-corrupt')
    mkdirSync(previousDataDir, { recursive: true })
    const original = { enabled: false, host: '', port: 0 }
    const written = { enabled: true, host: '127.0.0.1', port: 18080 }
    appendSettingEntry(previousDataDir, {
      service: 'FakeSystem', item: 'secure-web-proxy', originalValue: original, writtenValue: written,
      sessionToken: 'corrupt-owner', time: 1
    })
    const ledgerPath = join(previousDataDir, 'ledger.json')
    const entries = JSON.parse(readFileSync(ledgerPath, 'utf8')) as unknown[]
    entries.push({ corrupted: true })
    writeFileSync(ledgerPath, JSON.stringify(entries))

    let system = written
    let completed = 0
    const network = {
      preflight() {},
      managedItems: () => [],
      read: () => system,
      write: (_ref: unknown, value: typeof system) => { system = value },
      valuesEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
      preserveExternalChanges: () => true
    }
    const terminal = {
      service: 'TerminalEnvironment' as const,
      enabled: false,
      owns: () => false,
      preflight() {},
      managedItems: () => [],
      read: () => undefined,
      write() {},
      valuesEqual: () => true,
      restoredValueMatches: () => true
    }
    const adapter = composeManagedAdapters(network, terminal, () => ({
      acquired: true,
      abandoned: true,
      previousOwner: { dataDir: previousDataDir },
      completeRecovery: () => { completed += 1; return true },
      release() {}
    }))

    const right = adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(right).toMatchObject({ acquired: true, abandonedRecovered: true })
    expect(system).toEqual(original)
    expect(ledgerFailure(previousDataDir)).toBeUndefined()
    expect(completed).toBe(1)
  })

  it('活持有者不会因锁文件很旧被偷走；PID 相同但进程出生标识不同可回收', async () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    const a = launchWorker(root, 'data-a', 18080)
    expect(await nextLine(a)).toMatchObject({ state: 'connected' })
    const old = new Date(0)
    utimesSync(lockPath, old, old)
    expect(acquireWriteRight({ lockPath, dataDir: join(root, 'same-process') })).toMatchObject({ acquired: false, reason: 'held' })
    expect(await stop(a)).toMatchObject({ state: 'stopped' })

    writeFileSync(lockPath, `${JSON.stringify({ version: 1, pid: process.pid, startIdentity: 'different-process-birth', token: 'a'.repeat(32), dataDir: join(root, 'old') })}\n`, { mode: 0o600 })
    const recovered = acquireWriteRight({ lockPath, dataDir: join(root, 'new') })
    expect(recovered).toMatchObject({ acquired: true, abandoned: true })
    if (recovered.acquired) recovered.release()
  })

  it('拒绝符号链接，释放时也不删除后来替换成的其他持有者文件；目录和锁权限收紧', async () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'do-not-touch\n', { mode: 0o600 })
    symlinkSync(outside, lockPath)
    expect(acquireWriteRight({ lockPath, dataDir: join(root, 'data-a') })).toMatchObject({ acquired: false, reason: 'unavailable' })
    expect(readFileSync(outside, 'utf8')).toBe('do-not-touch\n')
    rmSync(lockPath)

    const recoveryPath = `${lockPath}.recovery`
    symlinkSync(outside, recoveryPath)
    expect(acquireWriteRight({ lockPath, dataDir: join(root, 'data-a') })).toMatchObject({ acquired: false, reason: 'unavailable' })
    expect(readFileSync(outside, 'utf8')).toBe('do-not-touch\n')
    rmSync(recoveryPath)

    const completedPath = `${lockPath}.recovery-completed`
    symlinkSync(outside, completedPath)
    expect(acquireWriteRight({ lockPath, dataDir: join(root, 'data-a') })).toMatchObject({ acquired: false, reason: 'unavailable' })
    expect(readFileSync(outside, 'utf8')).toBe('do-not-touch\n')
    rmSync(completedPath)

    const transitionPath = `${lockPath}.transition-lock`
    symlinkSync(outside, transitionPath)
    expect(acquireWriteRight({ lockPath, dataDir: join(root, 'data-a') })).toMatchObject({ acquired: false, reason: 'unavailable' })
    expect(readFileSync(outside, 'utf8')).toBe('do-not-touch\n')
    rmSync(transitionPath)

    chmodSync(join(root, 'global'), 0o777)
    const right = acquireWriteRight({ lockPath, dataDir: join(root, 'data-a') })
    expect(right).toMatchObject({ acquired: true })
    expect(lstatSync(join(root, 'global')).mode & 0o077).toBe(0)
    expect(lstatSync(lockPath).mode & 0o077).toBe(0)
    expect(lstatSync(transitionPath).mode & 0o077).toBe(0)

    rmSync(lockPath)
    const replacement = { version: 1, pid: process.pid, startIdentity: 'replacement', token: 'b'.repeat(32), dataDir: join(root, 'replacement') }
    writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 })
    if (right.acquired) right.release()
    expect(existsSync(lockPath)).toBe(true)
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'b'.repeat(32) })
  })

  it('关键系统写前复核全局席位：席位被替换后旧持有者不能继续写', () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    let system = { enabled: false, host: '', port: 0 }
    const network = {
      preflight() {},
      managedItems: () => [],
      read: () => system,
      write: (_ref: unknown, value: typeof system) => { system = value },
      valuesEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
    }
    const terminal = {
      service: 'TerminalEnvironment' as const,
      enabled: false,
      owns: () => false,
      preflight() {},
      managedItems: () => [],
      read: () => undefined,
      write() {},
      valuesEqual: () => true,
      restoredValueMatches: () => true
    }
    const adapter = composeManagedAdapters(network, terminal, (options) => acquireWriteRight({
      ...options, lockPath, dataDir: join(root, 'data-a')
    }))
    const right = adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(right).toMatchObject({ acquired: true })
    rmSync(lockPath)
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1, pid: process.pid, startIdentity: 'replacement', token: 'b'.repeat(32), dataDir: join(root, 'data-b')
    })}\n`, { mode: 0o600 })

    expect(() => adapter.write(
      { service: 'FakeSystem', item: 'secure-web-proxy' },
      { enabled: true, host: '127.0.0.1', port: 18080 }
    )).toThrowError(/TUNNEL_WRITE_RIGHT_LOST/)
    expect(system).toEqual({ enabled: false, host: '', port: 0 })
    if (right?.acquired) right.release()
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'b'.repeat(32) })
  })

  it('交还 transition 暂不可用：同一 right 保留重试资格，条件恢复后能真正释放并重新取得', () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    const network = {
      managedItems: () => [], read: () => undefined, write() {}, valuesEqual: () => true
    }
    const terminal = {
      service: 'TerminalEnvironment' as const, enabled: false, owns: () => false,
      preflight() {}, managedItems: () => [], read: () => undefined, write() {}, valuesEqual: () => true, restoredValueMatches: () => true
    }
    const adapter = composeManagedAdapters(network, terminal, (options) => acquireWriteRight({
      ...options, lockPath, dataDir: join(root, 'data-a')
    }))
    const right = adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(right).toMatchObject({ acquired: true })

    const transitionPath = `${lockPath}.transition-lock`
    rmSync(transitionPath)
    mkdirSync(transitionPath)
    expect(right?.acquired && right.release()).toBe(false)
    expect(existsSync(lockPath)).toBe(true)

    rmSync(transitionPath, { recursive: true })
    expect(right?.acquired && right.release()).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
    const reacquired = adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(reacquired).toMatchObject({ acquired: true })
    if (reacquired?.acquired) reacquired.release()
  })

  it('stale 回收已提交但 helper 响应丢失：父进程重读本次 token 恢复 handle 与旧账责任', () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1, pid: 424242, startIdentity: 'dead-owner', token: 'a'.repeat(32), dataDir: join(root, 'data-old')
    })}\n`, { mode: 0o600 })

    const recovered = acquireWriteRight({
      lockPath,
      dataDir: join(root, 'data-new'),
      processAlive: () => false,
      processIdentity: () => 'new-owner',
      testDropTransitionResultAfterCommit: true
    })
    expect(recovered).toMatchObject({
      acquired: true, abandoned: true, previousOwner: { token: 'a'.repeat(32), dataDir: join(root, 'data-old') }
    })
    if (!recovered.acquired) throw new Error('应从已提交 owner 恢复 handle')
    expect(recovered.completeRecovery()).toBe(true)
    expect(recovered.release()).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('stale 回收在 owner 目录 fsync 前丢 helper：同一次 acquire 清理 preparing 并接回旧恢复责任', () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1, pid: 424242, startIdentity: 'dead-owner', token: 'a'.repeat(32), dataDir: join(root, 'data-old')
    })}\n`, { mode: 0o600 })
    const common = {
      lockPath, dataDir: join(root, 'data-new'), processAlive: () => false, processIdentity: () => 'new-owner'
    }

    const recovered = acquireWriteRight({ ...common, testDropTransitionBeforeDirectorySync: true })
    expect(recovered).toMatchObject({
      acquired: true, abandoned: true, previousOwner: { token: 'a'.repeat(32), dataDir: join(root, 'data-old') }
    })
    const [ownerLine, receiptLine] = readFileSync(lockPath, 'utf8').split('\n')
    const owner = JSON.parse(ownerLine) as { phase: string; token: string }
    expect(owner.phase).toBe('preparing')
    expect(JSON.parse(receiptLine)).toMatchObject({ commitToken: owner.token })
    expect(JSON.parse(readFileSync(`${lockPath}.recovery`, 'utf8'))).toMatchObject({ token: 'a'.repeat(32) })
    if (!recovered.acquired) throw new Error('应在同一次 acquire 清理 preparing 后接回旧恢复责任')
    expect(recovered.completeRecovery()).toBe(true)
    expect(recovered.release()).toBe(true)
  })

  it('owner 目录 fsync 与随后的清理都失败：不授予 undurable handle，同一次 acquire 重试到 durable commit', () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    const common = { lockPath, dataDir: join(root, 'data-new'), processIdentity: () => 'new-owner' }

    const acquired = acquireWriteRight({ ...common, testFailOwnerDirectorySync: true, testFailOwnerCleanup: true })
    expect(acquired).toMatchObject({ acquired: true, abandoned: false })
    const [ownerLine, receiptLine] = readFileSync(lockPath, 'utf8').split('\n')
    const owner = JSON.parse(ownerLine) as { phase: string; token: string }
    expect(owner.phase).toBe('preparing')
    expect(JSON.parse(receiptLine)).toMatchObject({ commitToken: owner.token })
    if (acquired.acquired) expect(acquired.release()).toBe(true)
  })

  it('commit receipt 只追加半截就丢 helper：第一行仍可解析并在同一次 acquire 清理重试，旧责任不丢', () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1, pid: 424242, startIdentity: 'dead-owner', token: 'a'.repeat(32), dataDir: join(root, 'data-old')
    })}\n`, { mode: 0o600 })
    const recovered = acquireWriteRight({
      lockPath, dataDir: join(root, 'data-new'), processAlive: () => false, processIdentity: () => 'new-owner',
      testDropTransitionDuringCommit: true
    })
    expect(recovered).toMatchObject({
      acquired: true, abandoned: true, previousOwner: { token: 'a'.repeat(32), dataDir: join(root, 'data-old') }
    })
    expect(JSON.parse(readFileSync(`${lockPath}.recovery`, 'utf8'))).toMatchObject({ token: 'a'.repeat(32) })
    if (!recovered.acquired) throw new Error('应从半截 receipt 清理重试并接回恢复责任')
    expect(recovered.completeRecovery()).toBe(true)
    expect(recovered.release()).toBe(true)
  })

  it('release 删除 owner 后目录 fsync 未确认：本次返回 false，下一次确认后才算交还', () => {
    const root = prepare()
    const lockPath = join(root, 'global', 'write-right.json')
    const acquired = acquireWriteRight({
      lockPath, dataDir: join(root, 'data-new'), processIdentity: () => 'new-owner',
      testFailReleaseDirectorySyncAttempts: 3
    })
    expect(acquired).toMatchObject({ acquired: true })
    if (!acquired.acquired) throw new Error('应取得测试席位')
    expect(acquired.release()).toBe(false)
    expect(existsSync(lockPath)).toBe(false)
    expect(acquired.release()).toBe(true)
  })

  it('遗弃恢复失败且首次 release 未确认：下次 acquire 先重试旧 handle，不能把自己卡成 held', () => {
    let held = false
    let releaseAvailable = false
    let acquireCalls = 0
    let releaseCalls = 0
    const rawAcquire = () => {
      acquireCalls += 1
      if (held) return { acquired: false as const, reason: 'held' as const }
      held = true
      const abandoned = acquireCalls === 1
      return {
        acquired: true as const,
        abandoned,
        ...(abandoned ? { previousOwner: {} } : {}),
        release: () => {
          releaseCalls += 1
          if (!releaseAvailable) return false
          held = false
          return true
        }
      }
    }
    const network = { managedItems: () => [], read: () => undefined, write() {}, valuesEqual: () => true }
    const terminal = {
      service: 'TerminalEnvironment' as const, enabled: false, owns: () => false,
      preflight() {}, managedItems: () => [], read: () => undefined, write() {}, valuesEqual: () => true, restoredValueMatches: () => true
    }
    const adapter = composeManagedAdapters(network, terminal, rawAcquire)

    expect(adapter.acquireWriteRight?.({ timeoutMs: 0 })).toEqual({ acquired: false, reason: 'recovery-incomplete' })
    expect({ held, acquireCalls, releaseCalls }).toEqual({ held: true, acquireCalls: 1, releaseCalls: 1 })
    releaseAvailable = true
    const second = adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(second).toMatchObject({ acquired: true, abandoned: false })
    expect({ acquireCalls, releaseCalls }).toEqual({ acquireCalls: 2, releaseCalls: 2 })
    if (second?.acquired) expect(second.release()).toBe(true)
    expect(held).toBe(false)
  })

  it('无外层持有者的 withWriteRight 交权失败：后续 acquire 接管待重试 handle，不留幽灵引用', () => {
    let held = false
    let releaseAvailable = false
    let acquireCalls = 0
    let releaseCalls = 0
    const rawAcquire = () => {
      acquireCalls += 1
      if (held) return { acquired: false as const, reason: 'held' as const }
      held = true
      return {
        acquired: true as const,
        abandoned: false,
        assertHeld: () => {
          if (!held) throw new Error('WRITE_RIGHT_NOT_HELD')
        },
        release: () => {
          releaseCalls += 1
          if (!releaseAvailable) return false
          held = false
          return true
        }
      }
    }
    const network = { managedItems: () => [], read: () => undefined, write() {}, valuesEqual: () => true }
    const terminal = {
      service: 'TerminalEnvironment' as const, enabled: false, owns: () => false,
      preflight() {}, managedItems: () => [], read: () => undefined, write() {}, valuesEqual: () => true, restoredValueMatches: () => true
    }
    const adapter = composeManagedAdapters(network, terminal, rawAcquire)
    let ran = false

    expect(withWriteRight(adapter, () => { ran = true })).toEqual({ ok: false, reason: 'release-incomplete' })
    expect(ran).toBe(true)
    expect({ held, acquireCalls, releaseCalls }).toEqual({ held: true, acquireCalls: 1, releaseCalls: 1 })

    releaseAvailable = true
    const second = adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(second).toMatchObject({ acquired: true, abandoned: false })
    expect({ held, acquireCalls, releaseCalls }).toEqual({ held: true, acquireCalls: 2, releaseCalls: 2 })
    if (second?.acquired) expect(second.release()).toBe(true)
    expect({ held, releaseCalls }).toEqual({ held: false, releaseCalls: 3 })
  })

  it('Daemon 已持权时 resident self-heal 取得嵌套 lease：恢复账本后只释放内层，外层仍可继续持有', () => {
    const root = prepare()
    const h = managedSystem(root)
    const outer = h.adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(outer).toMatchObject({ acquired: true })
    const dataDir = join(root, 'resident-data')
    const original = { enabled: false, host: '', port: 0 }
    const written = { enabled: true, host: '127.0.0.1', port: 18080 }
    appendSettingEntry(dataDir, {
      ...h.ref, originalValue: original, writtenValue: written, sessionToken: 'resident-nested', time: 1
    })
    h.setSystem(written)
    let ran = false

    const outcome = guardedResidentSelfHeal(h.adapter, () => {
      ran = true
      const restored = restoreLedger(dataDir, h.adapter)
      return {
        restored: restored.restored.length,
        keptModified: restored.keptModified.length,
        failed: restored.failed,
        unrestored: 0,
        residentRemoved: true,
        shouldExit: true,
        settingsBusy: false,
        reason: 'restored'
      }
    })
    expect(ran).toBe(true)
    expect(outcome).toMatchObject({ shouldExit: true, restored: 1 })
    expect(h.system()).toEqual(original)
    expect(existsSync(h.lockPath)).toBe(true)
    if (outer?.acquired) expect(outer.release()).toBe(true)
    expect(existsSync(h.lockPath)).toBe(false)
  })

  it('Daemon 已持权时 crash bailout 复用嵌套 lease：确实恢复账本而不是把自己判 held', () => {
    const root = prepare()
    const h = managedSystem(root)
    const outer = h.adapter.acquireWriteRight?.({ timeoutMs: 0 })
    expect(outer).toMatchObject({ acquired: true })
    const dataDir = join(root, 'crash-data')
    const original = { enabled: false, host: '', port: 0 }
    const written = { enabled: true, host: '127.0.0.1', port: 18080 }
    appendSettingEntry(dataDir, {
      ...h.ref, originalValue: original, writtenValue: written, sessionToken: 'crash-nested', time: 1
    })
    h.setSystem(written)
    let exitCode: number | undefined
    const prior = new Set(process.listeners('uncaughtException'))
    const installed = installCrashBailout({ dataDir, adapterOf: () => h.adapter, runId: 'nested-crash', exit: (code) => { exitCode = code } })
    const handler = process.listeners('uncaughtException').find((candidate) => !prior.has(candidate))
    expect(handler).toBeDefined()
    handler?.(new Error('injected crash'), 'uncaughtException')
    installed.dispose()

    expect(exitCode).toBe(70)
    expect(h.system()).toEqual(original)
    expect(existsSync(h.lockPath)).toBe(true)
    if (outer?.acquired) expect(outer.release()).toBe(true)
    expect(existsSync(h.lockPath)).toBe(false)
  })
})

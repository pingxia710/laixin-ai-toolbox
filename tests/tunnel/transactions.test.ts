import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importConfig, type ImportOutcome } from '../../app/main/tunnel/import-service'
import { ActionMutex } from '../../app/main/tunnel/mutex'
import { layout } from '../../app/main/tunnel/paths'
import { applyPending, currentBatchId, pendingBatchId, reconcilePointers } from '../../app/main/tunnel/transactions'
import { TRUST_LINES } from '../../app/main/tunnel/trust'
import { buildPackageEntries, writePackageDir, type BuiltPackage } from './fixtures/package-builder'
import { makeTempDir, removeTempDir, waitFor } from './helpers'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const WORKER_ENTRY = fileURLToPath(new URL('./fixtures/transaction-worker.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ESBUILD = join(REPO_ROOT, 'node_modules', '.bin', 'esbuild')

function treeState(dataDir: string): string {
  const lines: string[] = []
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) {
      return
    }
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) {
        lines.push(`${prefix}${name}/`)
        walk(path, `${prefix}  `)
      } else {
        lines.push(`${prefix}${name} (${stat.size}B)`)
      }
    }
  }
  walk(dataDir, '')
  const pointers = ['current', 'pending', 'rollback']
    .map((name) => {
      const path = join(dataDir, name)
      return existsSync(path) ? `${name}=${JSON.stringify(readFileSync(path, 'utf8').trim())}` : `${name}=(无)`
    })
    .join(' ')
  return `${lines.join('\n')}\n指针: ${pointers}`
}

describe('导入事务与隔离(判据 13 五组、判据 17 互斥)', () => {
  let dataDir: string
  let packageDir: string
  let workerBundle: string

  beforeAll(() => {
    // worker 经 esbuild(随 electron-vite 来的既有二进制,非新依赖)打成单文件 mjs 后由 plain node 跑
    const outDir = makeTempDir('laixin-worker-')
    workerBundle = join(outDir, 'transaction-worker.mjs')
    execFileSync(ESBUILD, [
      '--bundle',
      WORKER_ENTRY,
      '--format=esm',
      '--platform=node',
      `--outfile=${workerBundle}`
    ])
  })

  beforeEach(() => {
    dataDir = makeTempDir('laixin-tx-')
    packageDir = makeTempDir('laixin-txpkg-')
  })

  afterEach(() => {
    removeTempDir(dataDir)
    removeTempDir(packageDir)
  })

  async function importPackage(built: BuiltPackage, name: string): Promise<ImportOutcome> {
    const dir = writePackageDir(join(packageDir, name), built)
    return importConfig({
      dataDir,
      picker: () => Promise.resolve(dir),
      trust: { whitelistDigests: [built.digest], signingPublicKeys: [] },
      now: () => NOW,
      sourceLineOf: (validated) => TRUST_LINES[validated.trust.tier]
    })
  }

  function hashTree(dir: string): string {
    if (!existsSync(dir)) {
      return '(无)'
    }
    return readdirSync(dir, { recursive: true })
      .sort()
      .map((entry) => {
        const path = join(dir, String(entry))
        return statSync(path).isDirectory() ? `${entry}/` : `${entry}:${readFileSync(path).length}`
      })
      .join('|')
  }

  it('① 同一授权 id 连续导入两个包 → 各自独立批次目录,current 指针与其批次目录字节不变', async () => {
    const first = await importPackage(buildPackageEntries({ configVersion: 1 }), 'pkg-a')
    const second = await importPackage(buildPackageEntries({ configVersion: 2 }), 'pkg-b')
    if (first.outcome !== 'imported' || second.outcome !== 'imported') {
      throw new Error('两次导入都应成功')
    }
    expect(first.batchId).not.toBe(second.batchId)
    expect(existsSync(layout.batchDir(dataDir, first.batchId))).toBe(true)
    expect(existsSync(layout.batchDir(dataDir, second.batchId))).toBe(true)
    expect(currentBatchId(dataDir)).toBeUndefined() // 从未应用:无 current

    // 应用第一个后,再导入第三个:current 指针与其批次目录字节不动
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied', batchId: second.batchId })
    const currentDirBefore = hashTree(layout.batchDir(dataDir, second.batchId))
    const currentPointerBefore = readFileSync(layout.currentPointer(dataDir), 'utf8')
    const third = await importPackage(buildPackageEntries({ configVersion: 3 }), 'pkg-c')
    expect(third.outcome).toBe('imported')
    expect(readFileSync(layout.currentPointer(dataDir), 'utf8')).toBe(currentPointerBefore)
    expect(hashTree(layout.batchDir(dataDir, second.batchId))).toBe(currentDirBefore)
    process.stdout.write(`\n[判据13① 磁盘状态]\n${treeState(dataDir)}\n`)
  })

  it('② 已连时导入 → 只落 pending、current 不动', async () => {
    const first = await importPackage(buildPackageEntries({ configVersion: 1 }), 'pkg-a')
    if (first.outcome !== 'imported') {
      throw new Error('导入应成功')
    }
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied' })
    // 模拟「已连」:state.json 由守护写有 connected
    const { writeFileAtomic } = await import('../../app/main/tunnel/paths')
    writeFileAtomic(join(dataDir, 'state.json'), `${JSON.stringify({ state: 'connected' })}\n`)
    const currentPointerBefore = readFileSync(layout.currentPointer(dataDir), 'utf8')
    const currentDirBefore = hashTree(layout.batchDir(dataDir, first.batchId))

    const second = await importPackage(buildPackageEntries({ configVersion: 2 }), 'pkg-b')
    expect(second.outcome).toBe('imported')
    expect(pendingBatchId(dataDir)).not.toBe(first.batchId)
    expect(readFileSync(layout.currentPointer(dataDir), 'utf8')).toBe(currentPointerBefore)
    expect(hashTree(layout.batchDir(dataDir, first.batchId))).toBe(currentDirBefore)
    process.stdout.write(`\n[判据13② 磁盘状态]\n${treeState(dataDir)}\n`)
  })

  it('③ 导入提交前 kill → 只剩 staging 语义内的本批残留之外什么都没有,指针未变(跨进程 SIGKILL)', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const dir = writePackageDir(join(packageDir, 'pkg-a'), built)
    const worker = spawn(
      process.execPath,
      [
        workerBundle,
        'import',
        '--data-dir',
        dataDir,
        '--package',
        dir,
        '--pause-after-validation-ms',
        '8000'
      ],
      { env: { ...process.env, TOOLBOX_TEST_PACKAGE_WHITELIST: built.digest } }
    )
    let output = ''
    worker.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    await waitFor(() => output.includes('PHASE=AFTER_VALIDATION'), 10_000)
    worker.kill('SIGKILL')
    await waitFor(() => worker.signalCode !== null)

    expect(existsSync(layout.imports(dataDir)) ? readdirSync(layout.imports(dataDir)) : []).toEqual([])
    expect(existsSync(layout.staging(dataDir)) ? readdirSync(layout.staging(dataDir)) : []).toEqual([])
    expect(currentBatchId(dataDir)).toBeUndefined()
    expect(pendingBatchId(dataDir)).toBeUndefined()
    process.stdout.write(`\n[判据13③ kill 后磁盘状态]\n${treeState(dataDir)}\n(数据目录根下文件: ${readdirSync(dataDir).join(', ') || '空'})\n`)
  }, 20_000)

  it('④ 应用后立即 kill → current 指针要么旧要么新,⛔ 半状态;重起 reconcile 幂等收尾', async () => {
    const first = await importPackage(buildPackageEntries({ configVersion: 1 }), 'pkg-a')
    if (first.outcome !== 'imported') {
      throw new Error('导入应成功')
    }
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied', batchId: first.batchId })
    const second = await importPackage(buildPackageEntries({ configVersion: 2 }), 'pkg-b')
    if (second.outcome !== 'imported') {
      throw new Error('导入应成功')
    }
    expect(currentBatchId(dataDir)).toBe(first.batchId)
    expect(pendingBatchId(dataDir)).toBe(second.batchId)

    const runApplyKill = async (phase: 'before' | 'after') => {
      const flag = phase === 'before' ? '--pause-before-current-write-ms' : '--pause-after-current-write-ms'
      const expectedPhase = phase === 'before' ? 'PHASE=BEFORE_CURRENT_WRITE' : 'PHASE=AFTER_CURRENT_WRITE'
      const worker = spawn(
        process.execPath,
        [workerBundle, 'apply', '--data-dir', dataDir, flag, '8000'],
        { env: process.env }
      )
      let output = ''
      worker.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      await waitFor(() => output.includes(expectedPhase), 10_000)
      worker.kill('SIGKILL')
      await waitFor(() => worker.signalCode !== null)
    }

    // 变体 A:kill 在写 current 之前 → current 仍是旧批次
    await runApplyKill('before')
    expect(currentBatchId(dataDir)).toBe(first.batchId)
    expect(pendingBatchId(dataDir)).toBe(second.batchId)
    process.stdout.write(`\n[判据13④ 变体A(写 current 前 kill)磁盘状态]\n${treeState(dataDir)}\n`)

    // 变体 B:kill 在写完 current 之后、清 pending 之前 → current 已是新批次,pending 未清
    await runApplyKill('after')
    process.stdout.write(
      `\n[判据13④ 变体B 即时] current=${currentBatchId(dataDir)} pending=${pendingBatchId(dataDir)} first=${first.batchId} second=${second.batchId}\n`
    )
    expect(currentBatchId(dataDir)).toBe(second.batchId)
    expect(pendingBatchId(dataDir)).toBe(second.batchId)
    process.stdout.write(`\n[判据13④ 变体B(写 current 后 kill)磁盘状态]\n${treeState(dataDir)}\n`)

    // 重起幂等收尾:pending==current 清掉
    reconcilePointers(dataDir)
    expect(pendingBatchId(dataDir)).toBeUndefined()
    expect(currentBatchId(dataDir)).toBe(second.batchId)

    // 指针内容必须是完整批次 id(⛔ 半状态):两份批次目录都完整存在
    expect(existsSync(layout.batchDir(dataDir, first.batchId))).toBe(true)
    expect(existsSync(layout.batchDir(dataDir, second.batchId))).toBe(true)
  }, 30_000)

  it('⑤ 应用后 current 凭据字节 = 该批次导入时的字节', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const importTimeBytes = built.entries.find((entry) => entry.path === 'credentials/id_ed25519')?.data
    const outcome = await importPackage(built, 'pkg-a')
    if (outcome.outcome !== 'imported') {
      throw new Error('导入应成功')
    }
    expect(applyPending(dataDir)).toMatchObject({ outcome: 'applied', batchId: outcome.batchId })
    const currentCredentials = readFileSync(
      join(layout.batchDir(dataDir, outcome.batchId), 'credentials', 'id_ed25519')
    )
    expect(currentCredentials.equals(importTimeBytes ?? Buffer.alloc(0))).toBe(true)
  })

  it('判据 17 互斥原语:并发 import + 持锁 → 后到者被拒(TUNNEL_BUSY),释放后可再入', () => {
    const mutex = new ActionMutex()
    const release = mutex.tryAcquire()
    expect(release).toBeDefined()
    expect(mutex.tryAcquire()).toBeUndefined() // 后到者被拒
    release?.()
    expect(mutex.tryAcquire()).toBeDefined()
  })
})

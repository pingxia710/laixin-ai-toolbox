// N-25 延伸:current/pending/rollback 指针文件的记忆化读。computeStatus 每轮经
// hasInvalidPointers(3×lstat+read)与 readCurrentInfo/readPendingInfo(各 1×lstat+read)
// 碰指针,状态轮询 2s×2+5s 三路打进来;指针没动就不必每轮重读。
// 计数导出 pointerDiskReads():真实读盘体(记忆化命中不计数)。
// 未修代码上:导出不存在(红);变异去缓存:计数随轮数增长(红)。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeStatus } from '../../app/main/tunnel/status-service'
import { layout } from '../../app/main/tunnel/paths'
import { hasInvalidPointers, pointerDiskReads } from '../../app/main/tunnel/transactions'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pointer-cache-'))
  roots.push(dir)
  return dir
}

const statusInput = (dataDir: string) => ({
  dataDir,
  daemonState: undefined,
  daemonUnexpectedExitAt: undefined,
  componentMissing: [],
  sshBinary: ''
})

describe('指针文件记忆化读', () => {
  it('指针不变时连续 computeStatus,底层指针读盘不增;盘面变化后拿新值', () => {
    const dataDir = tempDir()
    // 冷读一次(全部 ENOENT,合法的未配置形态),从这以后度量。
    computeStatus(statusInput(dataDir))
    const readsAfterFirst = pointerDiskReads()
    for (let index = 0; index < 10; index += 1) {
      computeStatus(statusInput(dataDir))
      expect(hasInvalidPointers(dataDir)).toBe(false)
    }
    expect(pointerDiskReads() - readsAfterFirst).toBe(0)

    // 外部把 current 写坏:签名变化 → 恰好一轮新读,并且读到的是新值(损坏即真)。
    writeFileSync(layout.currentPointer(dataDir), 'garbage-not-a-batch-id\n')
    expect(hasInvalidPointers(dataDir)).toBe(true)
    const readsAfterCorrupt = pointerDiskReads()
    expect(readsAfterCorrupt).toBeGreaterThan(readsAfterFirst)
    // current 指针盘面已变:computeStatus 侧的 readPointer 恰一次新读,其后不再读。
    computeStatus(statusInput(dataDir))
    expect(pointerDiskReads() - readsAfterCorrupt).toBe(1)
    computeStatus(statusInput(dataDir))
    expect(pointerDiskReads() - readsAfterCorrupt).toBe(1)

    // 修回合法批次号:再次失效重读,invalid 回落。
    writeFileSync(layout.currentPointer(dataDir), '20260929120000-00112233\n')
    expect(hasInvalidPointers(dataDir)).toBe(false)
  })
})

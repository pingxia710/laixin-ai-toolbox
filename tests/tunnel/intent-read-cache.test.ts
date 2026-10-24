// P2(网络数据面优化):意图轮询读取记忆化。500ms 一拍的 readIntentChecked 原每次
// existsSync+readFileSync+JSON.parse(约 17.3 万次/日,文件仅用户操作时变化);仿
// loadLedgerCached 用 mtime+size 签名缓存。⛔ 缓存损坏/读失败结果——损坏改名、下个
// tick 重试的语义必须保留。变异自证:去掉缓存 → 「只读盘一次」断言红。
import { expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { intentDiskReads, readIntentChecked } from '../../sidecar/win/daemon-core.mjs'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

it('意图读取记忆化:文件不变只读盘一次;变化与损坏路径失效正确', () => {
  const root = makeTempDir('netopt-intentcache-')
  try {
    writeIntentFile(root, { desired: 'connected', sessionToken: 'a' })
    const before = intentDiskReads()
    let last: ReturnType<typeof readIntentChecked> | undefined
    for (let i = 0; i < 20; i += 1) last = readIntentChecked(root)
    expect(last?.intent).toMatchObject({ desired: 'connected', sessionToken: 'a' })
    expect(intentDiskReads() - before).toBe(1)
    // 内容变化:签名变化即失效,读到新意图。
    writeIntentFile(root, { desired: 'user-disconnected', sessionToken: 'b' })
    expect(readIntentChecked(root).intent).toMatchObject({ desired: 'user-disconnected', sessionToken: 'b' })
    expect(intentDiskReads() - before).toBe(2)
    // 损坏:报 corrupted 并改名留证;改名后下一次读不得命中损坏前的旧缓存。
    writeFileSync(join(root, 'intent.json'), '{broken', 'utf8')
    const corrupt = readIntentChecked(root)
    expect(corrupt.corrupted).toBe(true)
    expect(corrupt.intent).toBeUndefined()
    expect(existsSync(join(root, 'intent.json'))).toBe(false)
    const after = readIntentChecked(root)
    expect(after.corrupted).toBe(false)
    expect(after.intent).toBeUndefined()
    expect(intentDiskReads() - before).toBe(4)
    // 损坏结果 ⛔ 入缓存:再次出现损坏文件时必须真读盘再报一次(重试语义保持)。
    writeFileSync(join(root, 'intent.json'), '{broken-again', 'utf8')
    expect(readIntentChecked(root).corrupted).toBe(true)
    expect(intentDiskReads() - before).toBe(5)
  } finally {
    removeTempDir(root)
  }
})

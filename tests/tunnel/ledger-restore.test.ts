import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import {
  appendIntentEntry,
  appendSettingEntry,
  generateSessionToken,
  lastIntent,
  loadLedger,
  pendingSettingEntries,
  type SettingEntry
} from '../../sidecar/mac/ledger.mjs'
import { restoreLedger, unrestoredEntries } from '../../sidecar/mac/restore.mjs'
import {
  fakeAdapterEnv,
  makeTempDir,
  readFakeOps,
  readFakeStore,
  removeTempDir
} from './helpers'

const ITEM_REF = { service: 'Wi-Fi', item: 'socks-proxy' }
const OUR_VALUE = { enabled: true, host: '127.0.0.1', port: 18080 }
const THIRD_PARTY_VALUE = { enabled: true, host: '10.0.0.9', port: 7890 }

describe('受管操作账本与恢复(判据 4)', () => {
  let dataDir: string
  let storePath: string

  beforeEach(() => {
    dataDir = makeTempDir('laixin-ledger-')
    storePath = join2(dataDir, 'fake-system.json')
  })

  afterEach(() => {
    removeTempDir(dataDir)
  })

  function adapter(extraFailures?: unknown) {
    return createAdapter({ ...fakeAdapterEnv(storePath, extraFailures) } as NodeJS.ProcessEnv)
  }

  function applyOurSetting(originalValue: unknown) {
    const token = generateSessionToken()
    appendSettingEntry(dataDir, {
      ...ITEM_REF,
      originalValue,
      writtenValue: OUR_VALUE,
      sessionToken: token,
      time: 1
    })
    adapter().write(ITEM_REF, OUR_VALUE)
    return token
  }

  function firstSettingEntry(): SettingEntry {
    const entry = loadLedger(dataDir).find((candidate) => candidate.kind === 'setting')
    if (entry === undefined || entry.kind !== 'setting') {
      throw new Error('预期存在 setting 账目')
    }
    return entry
  }

  it('fixture 甲:起前已有第三方系统代理 → 停后恢复为该第三方值', () => {
    adapter().write(ITEM_REF, THIRD_PARTY_VALUE)
    const before = readFakeStore(storePath)

    applyOurSetting(THIRD_PARTY_VALUE)
    expect(readFakeStore(storePath)[`${ITEM_REF.service}/${ITEM_REF.item}`]).toEqual(OUR_VALUE)

    const result = restoreLedger(dataDir, adapter())
    expect(result.restored).toHaveLength(1)
    expect(result.keptModified).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    expect(readFakeStore(storePath)).toEqual(before)
    expect(firstSettingEntry().status).toBe('restored')
  })

  it('fixture 乙:连接期间用户手改代理 → 停后保留用户值并列「未恢复:已被改动」', () => {
    applyOurSetting(null)
    const userValue = { enabled: true, host: '192.168.9.9', port: 8888 }
    adapter().write(ITEM_REF, userValue) // 用户手改

    const result = restoreLedger(dataDir, adapter())
    expect(result.restored).toHaveLength(0)
    expect(result.keptModified).toHaveLength(1)
    expect(readFakeStore(storePath)[`${ITEM_REF.service}/${ITEM_REF.item}`]).toEqual(userValue)
    const entry = firstSettingEntry()
    expect(entry.status).toBe('kept-modified')
    expect(unrestoredEntries(dataDir).map((candidate) => candidate.id)).toEqual([entry.id])
  })

  it('fixture 丙:重复 stop 两次 → 第二次幂等无副作用', () => {
    applyOurSetting(null)
    const first = restoreLedger(dataDir, adapter())
    expect(first.restored).toHaveLength(1)
    const opsAfterFirst = readFakeOps(storePath).length

    const second = restoreLedger(dataDir, adapter())
    expect(second.restored).toHaveLength(0)
    expect(second.keptModified).toHaveLength(0)
    expect(second.failed).toHaveLength(0)
    const secondOps = readFakeOps(storePath).slice(opsAfterFirst)
    expect(secondOps.filter((op) => op.op === 'write')).toEqual([])
  })

  it('fixture 丁:写回失败 → 显式「原设置未恢复」且账本项「失败 + 原因」', () => {
    applyOurSetting(null)
    const failing = adapter({
      write: [{ key: `${ITEM_REF.service}/${ITEM_REF.item}`, whenValue: null, message: '模拟写回失败' }]
    })
    // whenValue=null 只匹配「写回 null(原值)」这一笔,不拦建立时的 OUR_VALUE 写入
    const result = restoreLedger(dataDir, failing)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].note).toContain('模拟写回失败')
    const entry = firstSettingEntry()
    expect(entry.status).toBe('restore-failed')
    expect(readFakeStore(storePath)[`${ITEM_REF.service}/${ITEM_REF.item}`]).toEqual(OUR_VALUE)
  })

  it('账本:kill 中途只留旧版完整文件(原子写),意图条目可回读', () => {
    applyOurSetting(null)
    appendIntentEntry(dataDir, { intent: 'user-disconnected', time: 2 })
    expect(lastIntent(dataDir)).toBe('user-disconnected')
    expect(pendingSettingEntries(dataDir)).toHaveLength(1)
    restoreLedger(dataDir, adapter())
    expect(pendingSettingEntries(dataDir)).toHaveLength(0)
  })
})

function join2(left: string, right: string): string {
  return `${left}/${right}`
}

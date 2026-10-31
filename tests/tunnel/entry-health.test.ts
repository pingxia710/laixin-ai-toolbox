import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEntryHealthStore, ENTRY_COOLDOWN_MS, ENTRY_DWELL_MS, ENTRY_FAILURE_THRESHOLD } from '../../sidecar/mac/entry-health.mjs'

// N-86 入口健康状态机:healthy→suspect→cooling→复活;换序凭证据(当头冷却)、驻留限速、
// 全冷却=耗尽(交给既有退避/还原链)。证据只按当头入口记;单入口语义与既有完全一致。
const A = 'a.test:443'
const B = 'b.test:443'
const C = 'c.test:443'

describe('入口健康状态机(N-86)', () => {
  let dir: string
  let path: string
  let clock: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entry-health-'))
    path = join(dir, 'entry-health.json')
    clock = 1_000_000
  })

  it('① 双入口无故障:保持第一位,不换序;单入口恒 kept', () => {
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock })
    expect(store.nextHead([A, B])).toMatchObject({ head: A, rotated: false, reason: 'kept' })
    expect(store.nextHead([A])).toMatchObject({ reason: 'kept' })
    expect(store.nextHead([])).toMatchObject({ reason: 'kept' })
  })

  it('② 一坏一好:当头连续失败到阈值进冷却→换到好入口;成功归零;冷却期满复活', () => {
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock })
    for (let index = 0; index < ENTRY_FAILURE_THRESHOLD; index += 1) store.recordFailure(A)
    expect(store.view().entries[A]!.state).toBe('cooling')
    expect(store.nextHead([A, B])).toMatchObject({ head: B, rotated: true, reason: 'rotated' })
    // 好入口成功:即便曾有嫌疑也归零回 healthy。
    store.recordFailure(B)
    store.recordSuccess(B)
    expect(store.view().entries[B]!.state).toBe('healthy')
    // 冷却期满:A 复活给一次机会(内存结算,不需重启)。
    clock += ENTRY_COOLDOWN_MS + 1
    expect(store.nextHead([A, B])).toMatchObject({ head: A, rotated: false, reason: 'kept' })
    expect(store.view().entries[A]!.state).toBe('healthy')
  })

  it('③ 全部失败:两条都冷却→exhausted,不再换序(退避/还原链兜底普通网络)', () => {
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock })
    for (let index = 0; index < ENTRY_FAILURE_THRESHOLD; index += 1) store.recordFailure(A)
    clock += ENTRY_DWELL_MS + 1
    store.nextHead([A, B])
    for (let index = 0; index < ENTRY_FAILURE_THRESHOLD; index += 1) store.recordFailure(B)
    expect(store.exhausted([A, B])).toBe(true)
    expect(store.nextHead([A, B])).toMatchObject({ reason: 'exhausted', rotated: false })
  })

  it('④ 反复抖动:三入口快速连败时驻留限速(dwell)拦住风车,出窗后凭证据再换', () => {
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock })
    for (let index = 0; index < ENTRY_FAILURE_THRESHOLD; index += 1) store.recordFailure(A)
    expect(store.nextHead([A, B, C]).reason).toBe('rotated') // → B 当头(调用方按返回值换序)
    // 新当头 B 立刻也连败到冷却(故障震荡);C 健康——此刻距换序仅几秒,驻留窗内 ⛔ 再换。
    for (let index = 0; index < ENTRY_FAILURE_THRESHOLD; index += 1) store.recordFailure(B)
    expect(store.nextHead([B, A, C])).toMatchObject({ reason: 'dwell', rotated: false, head: B })
    // 出窗后:凭证据换到 C。
    clock += ENTRY_DWELL_MS + 1
    expect(store.nextHead([B, A, C])).toMatchObject({ reason: 'rotated', head: C })
  })

  it('重启恢复:落盘往返;守护停机期间冷却满期的入口在 load 时复活;损坏文件从空开始', () => {
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock })
    for (let index = 0; index < ENTRY_FAILURE_THRESHOLD; index += 1) store.recordFailure(A)
    const reloaded = createEntryHealthStore({ path, now: () => clock + ENTRY_COOLDOWN_MS + 1, monotonicNow: () => clock + ENTRY_COOLDOWN_MS + 1 })
    expect(reloaded.view().entries[A]!.state).toBe('healthy')
    writeFileSync(path, '{corrupt')
    const fromCorrupt = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock })
    expect(fromCorrupt.view().entries).toEqual({})
  })

  // N-86 审计补项:冷却/驻留的运行期判定用单调时钟;墙钟回拨/快进/跨重启损坏
  // 不得造成永久冷却、提前复活或阻断连接。跨重启用持久墙钟判满期,回拨签名时保守按新冷却计。
  it('审计① 墙钟回拨:不提前复活也不永久冷却,复活只看单调时钟', () => {
    let mono = 0
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => mono })
    store.recordFailure(A); store.recordFailure(A)
    expect(store.view().entries[A]!.state).toBe('cooling')
    clock -= 3_600_000 // 系统时间被回拨一小时
    mono += 1_000
    store.nextHead([A, B]) // 复活是惰性结算,探一次选择让 entryOf 跑到
    expect(store.view().entries[A]!.state).toBe('cooling') // 回拨 ⛔ 提前复活
    mono += ENTRY_COOLDOWN_MS // 单调时钟走满冷却
    store.nextHead([A, B])
    expect(store.view().entries[A]!.state).toBe('healthy') // 回拨 ⛔ 永久冷却
  })

  it('审计② 墙钟快进:不提前复活(单调时钟说了算)', () => {
    let mono = 0
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => mono })
    store.recordFailure(A); store.recordFailure(A)
    clock += 3_600_000 // 系统时间被快进一小时
    store.nextHead([A, B])
    expect(store.view().entries[A]!.state).toBe('cooling') // 快进 ⛔ 提前复活
    mono += ENTRY_COOLDOWN_MS + 1
    store.nextHead([A, B])
    expect(store.view().entries[A]!.state).toBe('healthy')
  })

  it('审计③ 重启遇墙钟回拨签名:保守按新冷却计,不永久冷却不阻断', () => {
    // 上一代落盘的 lastFailureAt 在「未来」= 回拨签名;⛔ 按墙钟差立即复活,⛔ 永久钉死。
    writeFileSync(path, JSON.stringify({ entries: { [A]: { state: 'cooling', failures: 2, changedAt: clock, lastFailureAt: clock + 3_600_000 } } }) + '\n')
    let mono = 0
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => mono })
    expect(store.view().entries[A]!.state).toBe('cooling')
    mono += ENTRY_COOLDOWN_MS + 1 // 从加载点起保守走满一个冷却窗
    store.nextHead([A, B])
    expect(store.view().entries[A]!.state).toBe('healthy')
    // 单入口候选在冷却中也不阻断选择(kept 语义)。
    expect(store.nextHead([A])).toMatchObject({ head: A, reason: 'kept' })
  })

  it('落盘不含自由文本;被改写的行读回即弃', () => {
    const store = createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock })
    store.recordFailure(A)
    store.recordFailure('<script>')
    expect(readFileSync(path, 'utf8')).not.toContain('<script>')
    writeFileSync(path, JSON.stringify({ entries: { '<injected>': { state: 'cooling', failures: 9, changedAt: 1, lastFailureAt: 1 } } }) + '\n')
    expect(createEntryHealthStore({ path, now: () => clock, monotonicNow: () => clock }).view().entries).toEqual({})
  })
})

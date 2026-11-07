// N-86 入口健康状态机:healthy → suspect(证据) → cooling(冷却窗) → 期满回 healthy;
// 全部候选都不可选 = exhausted(决策态,不落成入口属性)。
// 驻留 dwell:两次换序之间的最小间隔——防「哪条都没坏却来回跳」;当头入口已凭证据进
// 冷却时,证据优先于驻留,允许立即换。
// 冷却 cooldown:连续失败到阈值的入口暂停当头资格,期满自动复活给一次机会(重启期间
// 期满同样复活——load 时统一结算)。
// 证据只按「当头入口」记:非当头入口无归因证据,状态保持不变。单入口意图下本模块
// 只做记录,选择行为与既有完全一致(⛔ 改变单入口语义)。
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// 运行期冷却/驻留判定一律单调时钟(缺省 performance.now):墙钟回拨 ⛔ 永久冷却、
// 快进 ⛔ 提前复活。跨重启才用持久化的墙钟差判满期;回拨签名(存的时间在未来)保守重计。
const defaultMonotonicNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()

export const ENTRY_HEALTH_STATES = ['healthy', 'suspect', 'cooling']
/** 连续失败到该次数 → 进冷却。 */
export const ENTRY_FAILURE_THRESHOLD = 2
/** 换序驻留:距上次换序小于该值时不再换(当头已冷却除外)。 */
export const ENTRY_DWELL_MS = 30_000
/** 冷却时长:期满复活,给一次机会。 */
export const ENTRY_COOLDOWN_MS = 5 * 60_000

const KEY_PATTERN = /^[a-z0-9.:[\]-]{1,64}$/

function blankEntry(at) {
  return { state: 'healthy', failures: 0, changedAt: at, lastFailureAt: null }
}

function sanitizeEntry(value, at) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!ENTRY_HEALTH_STATES.includes(value.state)) return undefined
  if (!Number.isFinite(value.failures) || value.failures < 0 || value.failures > 99) return undefined
  if (!Number.isFinite(value.changedAt)) return undefined
  if (value.lastFailureAt !== null && !Number.isFinite(value.lastFailureAt)) return undefined
  const entry = { state: value.state, failures: Math.round(value.failures), changedAt: Math.round(value.changedAt),
    lastFailureAt: value.lastFailureAt === null ? null : Math.round(value.lastFailureAt) }
  // 跨重启结算(持久墙钟):冷却已满期且墙钟无回拨签名 → 复活——⛔ 重启把入口永久钉死。
  // 回拨签名(存的时间在未来)不由这里复活,由 load 挂保守新锚。
  if (entry.state === 'cooling' && entry.lastFailureAt !== null && at >= entry.lastFailureAt && at - entry.lastFailureAt >= ENTRY_COOLDOWN_MS) {
    return blankEntry(at)
  }
  return entry
}

export function createEntryHealthStore({ path, now, monotonicNow = defaultMonotonicNow, limit = 32 }) {
  let entries = new Map()
  let lastRotationAt = null
  let lastRotationAtMono = null

  const at = () => Math.round(now())
  const mono = () => monotonicNow()

  // 落盘只带墙钟字段;coolingSinceMono 是运行期锚,⛔ 持久化。
  const anchorCooling = (entry, elapsedAlready = 0) => ({ ...entry, coolingSinceMono: mono() - elapsedAlready })

  const persist = () => {
    try {
      const payload = { entries: Object.fromEntries([...entries.entries()].map(([key, entry]) => [key, {
        state: entry.state, failures: entry.failures, changedAt: entry.changedAt, lastFailureAt: entry.lastFailureAt
      }])), ...(lastRotationAt !== null ? { lastRotationAt } : {}) }
      const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
        renameSync(temporary, path)
      } finally { rmSync(temporary, { force: true }) }
    } catch { /* 健康账落盘失败不得影响连接 */ }
  }

  const load = () => {
    entries = new Map()
    lastRotationAt = null
    lastRotationAtMono = null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.entries === null || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return
      const nowAt = at()
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (!KEY_PATTERN.test(key)) continue
        const sanitized = sanitizeEntry(value, nowAt)
        if (sanitized === undefined || entries.size >= limit) continue
        if (sanitized.state === 'cooling' && sanitized.lastFailureAt !== null) {
          // 跨重启挂锚:墙钟正常时把已冷却的时长折算进单调锚;回拨签名(未来时间)保守按整窗重计。
          const rolledBack = nowAt < sanitized.lastFailureAt
          const elapsedAlready = rolledBack ? 0 : Math.max(0, Math.min(ENTRY_COOLDOWN_MS, nowAt - sanitized.lastFailureAt))
          entries.set(key, anchorCooling(sanitized, elapsedAlready))
        } else {
          entries.set(key, sanitized)
        }
      }
      if (Number.isFinite(parsed.lastRotationAt)) lastRotationAt = Math.round(parsed.lastRotationAt)
    } catch { /* 损坏即从空开始 */ }
  }

  const entryOf = (key) => {
    const current = entries.get(key)
    if (current === undefined) return blankEntry(at())
    // 运行期复活只看单调锚:墙钟回拨/快进都改变不了冷却窗;冷却中再失败会重锚(见 recordFailure)。
    if (current.state === 'cooling' && current.coolingSinceMono !== undefined && mono() - current.coolingSinceMono >= ENTRY_COOLDOWN_MS) {
      const revived = blankEntry(at())
      entries.set(key, revived)
      return revived
    }
    return current
  }

  const recordFailure = (key) => {
    if (!KEY_PATTERN.test(key)) return entryOf(key)
    const current = entryOf(key)
    const nowAt = at()
    const failures = current.failures + 1
    const enteringCooling = current.state !== 'cooling' && failures >= ENTRY_FAILURE_THRESHOLD
    const next = {
      failures,
      lastFailureAt: nowAt,
      // 已在冷却的入口再失败:刷新冷却起点(继续给冷却窗),状态不变。
      state: current.state === 'cooling' ? 'cooling' : enteringCooling ? 'cooling' : 'suspect',
      changedAt: current.state === 'cooling' && failures > ENTRY_FAILURE_THRESHOLD ? current.changedAt : nowAt
    }
    // 进冷却/冷却中再失败都以单调时钟重锚:墙钟怎么拨都不影响冷却窗。
    entries.set(key, current.state === 'cooling' || enteringCooling ? anchorCooling(next) : next)
    if (entries.size > limit) entries.delete(entries.keys().next().value)
    persist()
    return next
  }

  const recordSuccess = (key) => {
    if (!KEY_PATTERN.test(key)) return
    const current = entries.get(key)
    if (current === undefined || (current.state === 'healthy' && current.failures === 0)) return
    entries.set(key, blankEntry(at()))
    persist()
  }

  /**
   * 选择当头入口。返回 { head, rotated, reason }:
   * - 'kept'      当头可选,无换序证据(单入口恒此值——单入口语义与既有完全一致);
   * - 'rotated'   当头已冷却(连续失败到阈值=证据),跳过冷却入口取下一条可选;
   * - 'dwell'     有换序证据但距上次换序不足驻留窗——⛔ 冷却复活震荡把换序转成风车;
   *                当头先留任,下一轮退避重试自然出窗后再换;
   * - 'exhausted' 全部候选都在冷却——不再换序,交给既有退避/还原链(普通网络已由
   *                releaseSettingsForRecovery 交还)。
   */
  const nextHead = (candidateKeys) => {
    const keys = candidateKeys.filter((key) => KEY_PATTERN.test(key))
    if (keys.length <= 1) return { head: keys[0], rotated: false, reason: 'kept' }
    const nowAt = at()
    if (keys.every((key) => entryOf(key).state === 'cooling')) {
      return { head: keys[0], rotated: false, reason: 'exhausted' }
    }
    const currentHead = keys[0]
    if (entryOf(currentHead).state !== 'cooling') {
      return { head: currentHead, rotated: false, reason: 'kept' }
    }
    // 当头冷却=换序证据;但驻留窗内的第二次换序按兵不动(限速,防来回跳)——驻留也看单调时钟。
    const nowMono = mono()
    if (lastRotationAtMono !== null && nowMono - lastRotationAtMono < ENTRY_DWELL_MS) {
      return { head: currentHead, rotated: false, reason: 'dwell' }
    }
    const head = keys.find((key) => entryOf(key).state !== 'cooling')
    lastRotationAt = nowAt
    lastRotationAtMono = nowMono
    persist()
    return { head, rotated: true, reason: 'rotated' }
  }

  const exhausted = (candidateKeys) => nextHead(candidateKeys).reason === 'exhausted'
  const view = () => ({ entries: Object.fromEntries([...entries.entries()].map(([key, entry]) => [key, { ...entry }])), lastRotationAt })

  load()
  return { load, recordFailure, recordSuccess, nextHead, exhausted, view, persist }
}

// 恢复责任(定稿第 2 轮 5):恢复前比对所有权。
// 当前值 == 我们写入的值 → 写回原值、标「已恢复」;
// 不等于(第三方或用户改过)→ 保留现值；支持释放所有权的适配器记 preserved 终态。
// 读/写/读回失败保留账目；重复恢复重试失败项，但绝不覆盖第三方现值。
import {
  ENTRY_STATUS, clearRecoveryMarker, isIntactLedgerEntry, isOptionalSettingService, isSettingLikeEntry, isSettledSetting, loadLedger, loadLedgerCached,
  loadQuarantinedEntries, readRecoveryMarker, saveLedger, ledgerPath, withSettingsLock, assertSettingsLockHeld
} from './ledger.mjs'
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 系统设置变更通知欠着没发:落一个标记,下一次恢复(哪怕没有待恢复项)或守护定时补发,发成才删。
export function notifyPendingPath(dataDir) {
  return join(dataDir, 'settings-notify-pending')
}
export function notifyOwed(dataDir) {
  return existsSync(notifyPendingPath(dataDir))
}
export function markNotifyOwed(dataDir, owed) {
  try {
    if (owed) writeFileSync(notifyPendingPath(dataDir), `${JSON.stringify({ at: Date.now() })}\n`, { mode: 0o600 })
    else rmSync(notifyPendingPath(dataDir), { force: true })
  } catch { /* 标记读写失败不影响恢复结论 */ }
}

// 恢复目标已经不存在(D5):网卡/VPN/蓝牙 PAN 消失后,账本里那条设置再也读不回来。
// 这不是恢复失败——设置随网卡一起没了,没有东西要还原;当失败会把客户永远钉在
// 「原设置尚未恢复」上,而那条网络服务已经不在系统里,他无处可修。
const TARGET_ABSENT = 'TUNNEL_SETTING_TARGET_ABSENT'
const targetAbsent = (error) => error?.code === TARGET_ABSENT

// 把隔离账本里的条目补全成能通过常规校验的完整账目:存疑条目缺的字段用安全占位,
// 恢复结果如实记录;⛔ 让重建账本因结构缺口被再次隔离。
function repairQuarantinedEntry(entry, status, note) {
  return {
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `q-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    kind: 'setting',
    service: entry.service,
    item: entry.item,
    originalValue: entry.originalValue,
    writtenValue: Object.hasOwn(entry, 'writtenValue') ? entry.writtenValue : null,
    sessionToken: typeof entry.sessionToken === 'string' ? entry.sessionToken : 'quarantine-recovery',
    time: Number.isFinite(entry.time) ? entry.time : 0,
    status,
    note
  }
}

// 损坏账本的恢复流程(收敛包3·件4):恢复标记存在时,把隔离坏账本里能识别的
// 未恢复设置按所有权规则恢复;全部落定(已恢复或确认他人所有)即重建干净账本、清标记,
// 坏账本原样留证;有任何失败保留标记并返回可复制诊断。⛔ 静默清砖。
// 审计 R1:存疑条目(缺 note 等字段但原值在)照样尝试恢复;只有原文件里没有任何
// 设置类条目被丢弃时才允许清标记。
export function recoverLedger(dataDir, adapter) {
  return withSettingsLock(dataDir, () => recoverLedgerLocked(dataDir, adapter))
}

function recoverLedgerLocked(dataDir, adapter) {
  const badName = readRecoveryMarker(dataDir)
  if (badName === undefined) return undefined
  const quarantined = loadQuarantinedEntries(dataDir, badName)
  if (quarantined === undefined) {
    return { recovered: [], keptModified: [], failed: [badName],
      diagnostics: `损坏账本无法解析:${badName};无法找回待恢复设置,请联系客服并提供该文件` }
  }
  const { entries, droppedSettings } = quarantined
  const equal = adapter.valuesEqual ?? deepEqual
  const recovered = []
  const keptModified = []
  const failed = []
  const outcomes = new Map()
  // 逆序恢复:后写的先回滚,与常规恢复同一规则。
  // 待恢复项按「是不是设置账目」挑,⛔ 只认 kind === 'setting':kind 丢失或拼坏的条目
  // (审计 R1 形态 C/D)同样带着原值,漏过去就是系统代理仍指向本机桥却被标记清除。
  const pending = entries.filter((candidate) => isSettingLikeEntry(candidate) && !isSettledSetting(candidate))
  for (const entry of [...pending].reverse()) {
    const intact = isIntactLedgerEntry(entry)
    const label = `${entry.service}/${entry.item}`
    let current
    try {
      current = adapter.read({ service: entry.service, item: entry.item })
    } catch (error) {
      if (targetAbsent(error)) {
        const settled = repairQuarantinedEntry(entry, ENTRY_STATUS.restored, '该网络服务已不存在,无需恢复')
        outcomes.set(entry, settled)
        recovered.push(settled)
        continue
      }
      failed.push(`${label}:读取失败:${messageOf(error)}`)
      continue
    }
    if (equal(current, entry.originalValue, entry)) {
      const settled = repairQuarantinedEntry(entry, ENTRY_STATUS.restored, '损坏恢复:已是原值')
      outcomes.set(entry, settled)
      recovered.push(settled)
      continue
    }
    // 存疑条目缺写入值:现值不是原值又无法证明是我们写的,⛔ 覆盖第三方现值,计入失败交人工。
    if (!intact && !Object.hasOwn(entry, 'writtenValue')) {
      failed.push(`${label}:存疑账目缺少写入值,无法判定所有权,未改动现值`)
      continue
    }
    if (equal(current, entry.writtenValue, entry)) {
      try {
        assertSettingsLockHeld(dataDir)
        adapter.write({ service: entry.service, item: entry.item }, entry.originalValue)
        if (!equal(adapter.read({ service: entry.service, item: entry.item }), entry.originalValue, entry)) {
          throw new Error('原设置写回后读数不一致')
        }
        const settled = repairQuarantinedEntry(entry, ENTRY_STATUS.restored, '损坏恢复:已写回原值')
        outcomes.set(entry, settled)
        recovered.push(settled)
      } catch (error) {
        failed.push(`${label}:写回失败:${messageOf(error)}`)
      }
      continue
    }
    if (intact) {
      // 现值既非我们写入的、也非原值:第三方所有,保留现值并留痕。
      const settled = repairQuarantinedEntry(entry, ENTRY_STATUS.restored, '损坏恢复:当前值已被其他软件修改,保留现值')
      outcomes.set(entry, settled)
      keptModified.push(settled)
      continue
    }
    failed.push(`${label}:存疑账目现值既非原值也非记录的写入值,无法判定所有权,未改动现值`)
  }
  // 有设置类条目损坏到无法识别:不能当作没有待恢复项清标记(审计 R1)。
  if (droppedSettings > 0) {
    failed.push(`${badName}:有 ${droppedSettings} 条设置账目损坏到无法识别,无法自动恢复`)
  }
  // 处理过待恢复项就广播系统设置已变更(恢复完浏览器仍走死代理就是漏了这一步);
  // 通知失败不改变「注册表已写回」这个事实,只留痕,⛔ 把恢复翻成失败。
  if (pending.length > 0 || notifyOwed(dataDir)) {
    try { adapter.broadcastSettingsChanged?.(); markNotifyOwed(dataDir, false) } catch { markNotifyOwed(dataDir, true) }
  }
  if (failed.length > 0) {
    return { recovered, keptModified, failed,
      diagnostics: `损坏账本恢复未完成(${badName}):${failed.join(';')}；原设置可能尚未恢复，请联系客服并提供上述信息` }
  }
  // 先落干净账本再清标记:任何一步失败,标记都在,下次启动重走恢复。
  // 没被处理的条目里可能有「已恢复但结构不合规」的(审计 R1 形态 B:restored 条目丢了 note)。
  // 原样写回会让下次启动再判损坏、再隔离,ledger.json.bad-* 每次多一个、主进程持续报
  // 「恢复记录损坏」——所以补齐缺省字段再写回,⛔ 无限重隔离。
  const nextEntries = entries.map((entry) => {
    const settled = outcomes.get(entry)
    if (settled !== undefined) return settled
    if (isIntactLedgerEntry(entry)) return entry
    const status = Object.values(ENTRY_STATUS).includes(entry.status) ? entry.status : ENTRY_STATUS.restored
    return repairQuarantinedEntry(entry, status, typeof entry.note === 'string' ? entry.note : '损坏恢复:账目结构已修补')
  })
  const path = ledgerPath(dataDir)
  const temporary = `${path}.tmp-recovery`
  writeFileSync(temporary, `${JSON.stringify(nextEntries, null, 1)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  clearRecoveryMarker(dataDir)
  return { recovered, keptModified, failed: [], diagnostics: undefined }
}

// 整个「读账本 → 逐项读/写系统设置 → 存回账本」在跨进程锁里做(GPT-6 复核 be04e6a):
// ⛔ 读了旧账本、另一进程写入、再把旧快照整份存回去。
export function restoreLedger(dataDir, adapter) {
  return withSettingsLock(dataDir, () => restoreLedgerLocked(dataDir, adapter))
}

function restoreLedgerLocked(dataDir, adapter) {
  const entries = loadLedger(dataDir)
  const result = { restored: [], keptModified: [], failed: [] }
  // 逆序恢复:后写的先回滚。
  const pending = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === 'setting' && !isSettledSetting(entry))
    .reverse()

  for (const { entry, index } of pending) {
    let current
    try {
      current = adapter.read({ service: entry.service, item: entry.item })
    } catch (error) {
      if (targetAbsent(error)) {
        entries[index] = { ...entry, status: ENTRY_STATUS.restored, note: '该网络服务已不存在,无需恢复' }
        result.restored.push(entries[index])
        continue
      }
      entries[index] = { ...entry, status: ENTRY_STATUS.restoreFailed, note: `读取失败:${messageOf(error)}` }
      result.failed.push(entries[index])
      continue
    }
    const equal = adapter.valuesEqual ?? deepEqual
    const restoredValueMatches = (value) => equal(value, entry.originalValue, entry) ||
      adapter.restoredValueMatches?.(value, entry.originalValue, entry.writtenValue) === true
    if (restoredValueMatches(current)) {
      entries[index] = { ...entry, status: ENTRY_STATUS.restored, note: '' }
      result.restored.push(entries[index])
      continue
    }
    if (!equal(current, entry.writtenValue, entry)) {
      entries[index] = { ...entry, status: adapter.preserveExternalChanges?.(entry) ? ENTRY_STATUS.preserved : ENTRY_STATUS.keptModified, note: '当前值已被改动,保留现值及原始记录' }
      result.keptModified.push(entries[index])
      continue
    }
    try {
      assertSettingsLockHeld(dataDir)
      adapter.write({ service: entry.service, item: entry.item }, entry.originalValue)
      if (!restoredValueMatches(adapter.read({ service: entry.service, item: entry.item }))) {
        throw new Error('原设置写回后读数不一致')
      }
      entries[index] = { ...entry, status: ENTRY_STATUS.restored, note: '' }
      result.restored.push(entries[index])
    } catch (error) {
      entries[index] = { ...entry, status: ENTRY_STATUS.restoreFailed, note: `写回失败:${messageOf(error)}` }
      result.failed.push(entries[index])
    }
  }

  // 注册表已经写回 = 客户的电脑已经回到原设置,这就是「已恢复」。系统变更通知只是让已经开着的
  // 浏览器早点重读设置(Chrome/Edge 自己也监听注册表);通知发不出去(PowerShell 慢/被杀软拦)
  // ⛔ 把已恢复项翻成失败——那会让界面锁在「原设置尚未恢复」、连接按钮一直被拒,而设置其实早就还回去了
  // (创始人 09-13 真机:整机断网 + 再也连不上)。这里只留痕并告诉调用方通知没成,由调用方择机补发。
  if (pending.length > 0 || notifyOwed(dataDir)) {
    try { adapter.broadcastSettingsChanged?.(); markNotifyOwed(dataDir, false) } catch {
      markNotifyOwed(dataDir, true)
      result.notifyFailed = true
      result.restored = result.restored.map((entry) => {
        const noted = { ...entry, note: '设置已写回;系统代理变更通知未送达,已开着的软件可能要重开' }
        const index = entries.findIndex((candidate) => candidate.id === entry.id)
        if (index >= 0) entries[index] = noted
        return noted
      })
    }
  }
  // 广播之后的回落检查(W2-1,真机 2026-09-14):Windows 会对代理相关值连带规范化——还原里
  // 先写回的项,可能被同一轮里后续项的写入/变更通知触发系统重载时又改回**我们写入的值**
  // (真机:blob 的 autoDetect 位被写回开,收尾广播后又被清回关)。签名很明确:现值重新等于
  // 我们的写入值(而不是原值)。命中就再写回原值一次——此刻已无后续写入,系统重载不会再打翻它。
  // 客户恰在这窗口里把值改回我们写入的值,与规范化不可区分,按主路径同一语义处理(以原值为准);
  // 改成别的值不会被这里碰到。
  for (const { entry, index } of pending) {
    if (entries[index]?.status !== ENTRY_STATUS.restored) continue
    let current
    try { current = adapter.read({ service: entry.service, item: entry.item }) } catch { continue }
    const equalFn = adapter.valuesEqual ?? deepEqual
    if (equalFn(current, entry.originalValue, entry) || !equalFn(current, entry.writtenValue, entry)) continue
    try {
      assertSettingsLockHeld(dataDir)
      adapter.write({ service: entry.service, item: entry.item }, entry.originalValue)
      if (!equalFn(adapter.read({ service: entry.service, item: entry.item }), entry.originalValue, entry)) continue
      entries[index] = { ...entries[index], note: '还原后被系统连带改写回,已重写原值' }
    } catch {
      entries[index] = { ...entries[index], status: ENTRY_STATUS.restoreFailed, note: '还原后被系统连带改写回,重写失败' }
      result.failed.push(entries[index])
    }
  }
  saveLedger(dataDir, entries)
  return result
}

/** 补发一次欠着的系统设置变更通知;发成就清标记。没有欠账直接返回 true,失败照实返回 false,⛔ 抛出。 */
export function rebroadcastSettings(dataDir, adapter) {
  if (!notifyOwed(dataDir)) return true
  try { adapter.broadcastSettingsChanged?.(); markNotifyOwed(dataDir, false); return true } catch { return false }
}

// 「未恢复」= 会挡住重新连接的项。可选服务(终端接入)的失败不在此列:它每次恢复照样重试,但 ⛔ 让系统代理网络起不来。
export function unrestoredEntries(dataDir) {
  return loadLedger(dataDir).filter(
    (entry) =>
      entry.kind === 'setting' && !isOptionalSettingService(entry.service) &&
      (entry.status === ENTRY_STATUS.applied ||
        entry.status === ENTRY_STATUS.keptModified ||
        entry.status === ENTRY_STATUS.restoreFailed)
  )
}

// 状态轮询专用:与 unrestoredEntries 同一过滤,走 mtime 记忆化读,⛔ 每 2 秒全量重解析账本。
export function unrestoredEntriesCached(dataDir) {
  return loadLedgerCached(dataDir).filter(
    (entry) =>
      entry.kind === 'setting' && !isOptionalSettingService(entry.service) &&
      (entry.status === ENTRY_STATUS.applied ||
        entry.status === ENTRY_STATUS.keptModified ||
        entry.status === ENTRY_STATUS.restoreFailed)
  )
}

export function deepEqual(left, right) {
  // reg.exe 旧账本使用十六进制，写入值使用十进制；按 DWORD 值比较。
  if (left?.type === 'REG_DWORD' && right?.type === 'REG_DWORD') {
    const valid = (value) => /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(value)) && Number.isSafeInteger(Number(value))
    return valid(left.data) && valid(right.data) && Number(left.data) === Number(right.data)
  }
  return JSON.stringify(left) === JSON.stringify(right)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

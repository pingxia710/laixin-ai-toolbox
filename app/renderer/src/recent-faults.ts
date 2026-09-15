/** 一键诊断快照里的「最近故障与已试过的处理」，提到界面上让客户直接看见。 */
import { faultColumns, sanitizeFaultRecord, type FaultColumns, type FaultRecord } from '../../shared/fault-log-types'

/** 分的就是这五列；表头、读屏说法与用例共用一份，⛔ 各写一套列名。 */
export const FAULT_COLUMNS: readonly { readonly key: keyof Omit<FaultColumns, 'at' | 'note'>; readonly label: string }[] = [
  { key: 'when', label: '时间' },
  { key: 'software', label: '软件' },
  { key: 'category', label: '类别' },
  { key: 'tried', label: '试过什么' },
  { key: 'outcome', label: '结果' }
]
const EMPTY_CELL = '—'

/**
 * 快照里的故障记录。**只收结构化记录**——⛔ 再从诊断文本拆行，那是拿展示当数据源。
 * 每条都过主进程同一份清洗：字段不在清单内就丢掉该字段，整条不可用就不显示。
 */
export function readFaultRecords(value: unknown, limit = 5): readonly FaultRecord[] {
  if (!Array.isArray(value)) return []
  const records: FaultRecord[] = []
  for (const item of value) {
    const record = sanitizeFaultRecord(item)
    if (record !== undefined) records.push(record)
    if (records.length >= limit) break
  }
  return records
}

/** 表头一行。每条记录自己的 aria-label 里已带列名，所以这行对读屏隐藏。 */
export function faultListHead(): HTMLElement {
  const head = document.createElement('li')
  head.className = 'fault-entry fault-entry-head'
  head.setAttribute('aria-hidden', 'true')
  for (const column of FAULT_COLUMNS) {
    const cell = document.createElement('span')
    cell.className = `fault-col fault-col-${column.key}`
    cell.textContent = column.label
    head.append(cell)
  }
  return head
}

/** 一条故障分成五列：时间 / 软件 / 类别 / 试过什么 / 结果。每列直接取记录字段，⛔ 界面自己编。 */
export function faultEntry(record: FaultRecord): HTMLElement {
  const columns = faultColumns(record)
  const item = document.createElement('li')
  item.className = 'fault-entry'
  const when = document.createElement('time')
  when.className = 'fault-col fault-col-when'
  when.setAttribute('datetime', columns.at)
  when.textContent = columns.when
  item.append(when)
  for (const column of FAULT_COLUMNS.slice(1)) {
    const cell = document.createElement('span')
    cell.className = `fault-col fault-col-${column.key}`
    cell.textContent = columns[column.key] || EMPTY_CELL
    item.append(cell)
  }
  if (columns.note) {
    const note = document.createElement('span')
    note.className = 'fault-col fault-col-note'
    note.textContent = columns.note
    item.append(note)
  }
  if (record.outcome) item.setAttribute('data-outcome', record.outcome)
  item.setAttribute('aria-label', [...FAULT_COLUMNS.map(column => `${column.label}：${columns[column.key] || EMPTY_CELL}`),
    ...(columns.note ? [columns.note] : [])].join('，'))
  return item
}

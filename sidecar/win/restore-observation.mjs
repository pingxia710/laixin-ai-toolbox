// 单轮恢复摘要，只含受控原因和数字；不保存地址、进程路径、异常正文或设置快照。
export const RESTORE_REASONS = Object.freeze({
  PORT_QUERY_TIMEOUT: '端口查询超时',
  PORT_QUERY_UNAVAILABLE: '端口查询命令不可用',
  PORT_QUERY_PERMISSION_DENIED: '端口查询权限不足',
  PORT_QUERY_INVALID: '端口查询结果无法解析',
  PORT_ADDRESS_AMBIGUOUS: '端口监听地址或进程归属存在歧义',
  PORT_QUERY_FAILED: '端口归属暂未查明',
  PORT_OTHER_LAIXIN: '代理端口由另一份来信进程监听',
  SETTINGS_READ_FAILED: '原设置读取失败',
  SETTINGS_WRITE_OR_READBACK_FAILED: '原设置写回或读回确认失败',
  SETTINGS_BUSY: '其他恢复任务正在处理设置',
  RESTORE_UNCONFIRMED: '恢复结果尚未确认'
})

export function safeRestoreReason(code) {
  return typeof code === 'string' && Object.hasOwn(RESTORE_REASONS, code) ? code : 'RESTORE_UNCONFIRMED'
}

export function readRestoreObservation(value) {
  if (!value || typeof value !== 'object') return undefined
  const { phase, result, attempts, startedAt, updatedAt, nextRetryAt } = value
  if (!['checking', 'waiting', 'complete', 'blocked'].includes(phase) ||
    !['unconfirmed', 'restored', 'preserved', 'mixed', 'not-needed'].includes(result) ||
    !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 1_000_000 ||
    ![startedAt, updatedAt, nextRetryAt].every((time) => Number.isSafeInteger(time) && time >= 0 && time <= 8_640_000_000_000_000) ||
    updatedAt < startedAt || (phase === 'complete') === (result === 'unconfirmed') ||
    (phase === 'waiting' ? nextRetryAt < updatedAt || nextRetryAt - updatedAt > 30_000 : nextRetryAt !== 0)) return undefined
  return { phase, result, attempts, startedAt, updatedAt, nextRetryAt,
    lastFailureCode: value.lastFailureCode === '' ? '' : safeRestoreReason(value.lastFailureCode) }
}

export function restoreObservationActive(value, now = Date.now()) {
  const record = readRestoreObservation(value)
  return record !== undefined && ['checking', 'waiting'].includes(record.phase) &&
    record.updatedAt <= now && now - record.updatedAt <= 90_000 &&
    (record.phase !== 'waiting' || record.nextRetryAt <= now + 30_000)
}

export function restoreObservationText(value, now = Date.now(), activeAllowed = true) {
  const record = readRestoreObservation(value)
  if (!record) return ''
  const outcomes = { restored: '原设置已读回确认', preserved: '已保留其他软件的设置，未覆盖',
    mixed: '原设置已读回确认；其他软件修改的设置已保留', 'not-needed': '没有待恢复的设置', unconfirmed: '恢复尚未确认' }
  const phase = record.phase === 'complete' ? outcomes[record.result]
    : activeAllowed && restoreObservationActive(record, now) ? record.phase === 'waiting' ? '正在等待自动重试' : '正在检查恢复结果'
      : '当前进度未确认，可重试恢复'
  return [`检查 ${record.attempts} 次，已重试 ${record.attempts - 1} 次`, phase,
    ...(record.lastFailureCode ? [`上次原因：${RESTORE_REASONS[record.lastFailureCode]}（${record.lastFailureCode}）`] : []),
    `开始 ${new Date(record.startedAt).toISOString()}`, `更新 ${new Date(record.updatedAt).toISOString()}`,
    ...(activeAllowed && record.phase === 'waiting' && restoreObservationActive(record, now) ? [`下次尝试 ${new Date(record.nextRetryAt).toISOString()}`] : [])].join('；')
}

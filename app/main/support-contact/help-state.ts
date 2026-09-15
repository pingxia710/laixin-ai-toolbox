export type ChannelStatus = '已连' | '未连' | '未知'

export interface HelpState {
  readonly software: string
  readonly platform: string
  readonly cardId: string
  readonly stageCode: string
  readonly reasonCodes: readonly string[]
  readonly channelStatus: ChannelStatus
  readonly systemVersion: string
  readonly toolboxVersion: string
  readonly customerId?: string
  readonly purchaseId?: string
  readonly deviceId?: string
}

const PREFIX = '来信AI工具箱'
const FIELDS = ['软件', '平台', '卡片', '阶段', '原因', '通道', '系统', '版本'] as const
const CHANNEL_STATUSES = new Set<ChannelStatus>(['已连', '未连', '未知'])
const CONTEXT_FIELDS = ['客户编号', '购买单号', '设备编号']
const CONTEXT_PATTERNS = [/^acct_[a-f0-9]{32}$/, /^lx-[a-f0-9]{32}$/, /^device_[a-f0-9]{32}$/]

export function formatHelpState(state: HelpState): string {
  const values = [
    state.software,
    state.platform,
    state.cardId,
    state.stageCode,
    state.reasonCodes.join(','),
    state.channelStatus,
    state.systemVersion,
    state.toolboxVersion
  ]
  values.forEach((value, index) => validateValue(FIELDS[index], value))
  if (!CHANNEL_STATUSES.has(state.channelStatus)) {
    throw new Error('HELP_STATE_CHANNEL_INVALID')
  }
  const context = [state.customerId, state.purchaseId, state.deviceId]
  const extra = context.some(Boolean) ? context.map((value, index) => `${CONTEXT_FIELDS[index]}:${value && CONTEXT_PATTERNS[index].test(value) ? value : '未关联'}`) : []
  return [PREFIX, ...FIELDS.map((field, index) => `${field}:${values[index]}`), ...extra].join(' | ')
}

export function parseHelpState(value: string): HelpState | undefined {
  const segments = value.split(' | ')
  if (![FIELDS.length + 1, FIELDS.length + 4].includes(segments.length) || segments[0] !== PREFIX) {
    return undefined
  }

  const fields = segments.slice(1, FIELDS.length + 1).map((segment, index) => {
    const field = FIELDS[index]
    const prefix = `${field}:`
    if (!segment.startsWith(prefix)) {
      return undefined
    }
    const fieldValue = segment.slice(prefix.length)
    try {
      validateValue(field, fieldValue)
      return fieldValue
    } catch {
      return undefined
    }
  })
  if (fields.some((field) => field === undefined)) {
    return undefined
  }

  const [software, platform, cardId, stageCode, reasons, channelStatus, systemVersion, toolboxVersion] = fields as string[]
  if (!CHANNEL_STATUSES.has(channelStatus as ChannelStatus)) {
    return undefined
  }
  const reasonCodes = reasons.split(',')
  if (reasonCodes.some((reason) => reason.length === 0)) {
    return undefined
  }
  const context: { customerId?: string; purchaseId?: string; deviceId?: string } = {}
  for (const [index, segment] of segments.slice(FIELDS.length + 1).entries()) {
    const prefix = `${CONTEXT_FIELDS[index]}:`; const value = segment.slice(prefix.length)
    if (!segment.startsWith(prefix) || (value !== '未关联' && !CONTEXT_PATTERNS[index].test(value))) return undefined
    if (value !== '未关联') context[(['customerId', 'purchaseId', 'deviceId'] as const)[index]] = value
  }
  return {
    ...context,
    software,
    platform,
    cardId,
    stageCode,
    reasonCodes,
    channelStatus: channelStatus as ChannelStatus,
    systemVersion,
    toolboxVersion
  }
}

function validateValue(field: string, value: string): void {
  if (value.length === 0 || value.includes('|') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`HELP_STATE_${field}_INVALID`)
  }
}

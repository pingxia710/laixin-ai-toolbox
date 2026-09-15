/**
 * 「模型 API」页的 Mac 使用回执（API-04）视图层：只做桥接结果的读取、结局文案与平台门。
 * 回执文本由主进程按白名单渲染，这里 ⛔ 拼接任何数据字段。
 */

export interface UsageReceiptResult {
  readonly ok: boolean
  readonly reason?: 'unsupported' | 'empty'
  readonly count?: number
  readonly receipt?: string
  /** 主进程预览快照标识：保存时原样回传，⛔ 渲染层自造。 */
  readonly snapshotId?: string
}

export interface UsageReceiptSaveResult {
  readonly ok: boolean
  readonly reason?: 'unsupported' | 'empty' | 'no-preview' | 'expired' | 'canceled' | 'write-failed'
}

/** 只有 macOS 提供这个入口；Windows 与其他平台一律隐藏。 */
export function macUsageReceiptSupported(platform: string): boolean {
  return platform === 'darwin'
}

export function readUsageReceiptResult(snapshot: string): UsageReceiptResult {
  try {
    const value = JSON.parse(snapshot) as Record<string, unknown>
    if (value.ok === true && typeof value.receipt === 'string' && value.receipt !== '') {
      return {
        ok: true,
        count: typeof value.count === 'number' ? value.count : undefined,
        receipt: value.receipt,
        snapshotId: typeof value.snapshotId === 'string' ? value.snapshotId : undefined
      }
    }
    return { ok: false, reason: 'empty' }
  } catch {
    return { ok: false, reason: 'empty' }
  }
}

export function readUsageReceiptSaveResult(snapshot: string): UsageReceiptSaveResult {
  try {
    const value = JSON.parse(snapshot) as Record<string, unknown>
    if (value.ok === true) return { ok: true }
    if (value.reason === 'no-preview' || value.reason === 'expired' || value.reason === 'write-failed' || value.reason === 'unsupported') {
      return { ok: false, reason: value.reason }
    }
    return { ok: false, reason: 'canceled' }
  } catch {
    return { ok: false, reason: 'canceled' }
  }
}

export function usageReceiptEmptyNotice(result: UsageReceiptResult): string {
  return result.ok ? '' : '本机还没有可导出的使用记录。连续使用模型 API 后再回来生成。'
}

/** 预览下方的固定提示：把「由你自行发送」「不会自动发送」说在前头。 */
export function usageReceiptSectionHint(): string {
  return '回执只包含白名单字段（工具箱版本、macOS 版本、客户端、发生时间、阶段、结果、固定错误分类），由你预览后自行复制或保存并发送给支持方；工具箱不会自动发送，也不表示支持方已收到。'
}

export function usageReceiptCopiedNotice(): string {
  return '已复制回执。请自行粘贴发送给支持方。'
}

export function usageReceiptSaveNotice(result: UsageReceiptSaveResult): string {
  if (result.ok) return '回执已保存为本地文件。请自行发送给支持方；工具箱不会自动发送。'
  if (result.reason === 'canceled') return '已取消保存，未写入任何文件。'
  if (result.reason === 'expired') return '这份回执预览已经过期，请重新生成后再保存。'
  if (result.reason === 'no-preview') return '请先生成并预览回执，再保存。'
  if (result.reason === 'write-failed') return '保存没有完成，未写入文件。请重试一次。'
  if (result.reason === 'unsupported') return 'Mac 使用回执只在 macOS 上提供。'
  return '本机还没有可导出的使用记录。'
}

export function usageReceiptFailureNotice(): string {
  return '回执生成没有完成，请重试一次。'
}

export interface UsageReceiptSnapshotLike {
  snapshot: string
}

export type UsageReceiptBridgeApi = {
  usageReceipt(): Promise<UsageReceiptSnapshotLike>
  usageReceiptSave(input: { snapshotId: string }): Promise<UsageReceiptSnapshotLike>
}

/** 桥接调用的窄类型收口，页面只拿这两个动作。 */
export async function requestUsageReceipt(api: UsageReceiptBridgeApi | undefined): Promise<UsageReceiptResult> {
  if (api === undefined) return { ok: false, reason: 'empty' }
  return readUsageReceiptResult((await api.usageReceipt()).snapshot)
}

export async function requestUsageReceiptSave(api: UsageReceiptBridgeApi | undefined, snapshotId: string | undefined): Promise<UsageReceiptSaveResult> {
  if (api === undefined || snapshotId === undefined) return { ok: false, reason: 'no-preview' }
  return readUsageReceiptSaveResult((await api.usageReceiptSave({ snapshotId })).snapshot)
}

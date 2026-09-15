// 一键上报的线上格式：客户端与后台共用这一份，⛔ 两边各写一套再对不上。

/** 回执号：客户能念给客服听。Crockford base32 去掉 I L O U，念错的余地小。 */
export const REPORT_RECEIPT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const REPORT_RECEIPT_PATTERN = /^LX-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
/** 单次上报的体积上限。超了在客户端先裁，后台再按同一个数拒。 */
export const REPORT_MAX_BYTES = 256 * 1024

export interface ReportToolbox {
  readonly version: string
  readonly platform: string
  readonly architecture: string
  readonly packaged: boolean
}

/** 客户端发出去的整包。body 是已经过三道闸的诊断内容，后台只存不解释。 */
export interface ReportUpload {
  readonly receipt: string
  /** 客户机器上的时刻（ISO）。后台另记自己的收件时刻，⛔ 拿客户时钟当准。 */
  readonly createdAt: string
  readonly toolbox: ReportToolbox
  /** 登录了才有；没登录也能上报。 */
  readonly account?: { readonly id?: string; readonly deviceId?: string }
  readonly body: Record<string, unknown>
}

export interface ReportRecord extends ReportUpload {
  readonly receivedAt: number
  /** 后台按令牌认出来的客户；没登录为 null。⛔ 信客户端自报的 id。 */
  readonly customerId: string | null
}

/** 回执号合法性。客户端生成、后台照这条验，两边同一判据。 */
export function validReceipt(value: unknown): value is string {
  return typeof value === 'string' && REPORT_RECEIPT_PATTERN.test(value)
}

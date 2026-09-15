// 一键上报的通道：客户正断着网，所以这条路**不能依赖来信通道本身**。
//
// 路线顺序：
//  1. direct —— 私有 session 强制直连，绕开工具箱接管的系统代理，也绕开客户自己的代理。
//     通道坏了、Xray 死了、系统代理指着一个已经不监听的端口，这条路照样能走。
//  2. system —— 直连不通（公司网只准走代理）时才试；**先解析这条路线会走到哪**，
//     解析结果指回本机中继端口就跳过——那等于又绕回来信通道，正是我们要避开的东西。
//
// 两条都不成：把整包写成本机文件，回执号照给，客户可以手工发给客服（回执号对得上同一次上报）。
import { randomInt } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPORT_RECEIPT_ALPHABET, REPORT_RECEIPT_PATTERN } from '../../report-types'

export type ReportRoute = 'direct' | 'system'

export interface ReportTransport {
  /** 这条路线下目标地址会走到哪个代理；直连返回 'DIRECT'。判「会不会绕回来信通道」用。 */
  resolveProxy(url: string, route: ReportRoute): Promise<string>
  post(url: string, route: ReportRoute, payload: string, token?: string): Promise<{ readonly status: number; readonly body: string }>
}

export interface UploadAttempt {
  readonly route: ReportRoute
  readonly ok: boolean
  /** 没走成的原因：skipped-loopback（会绕回来信通道）/ HTTP 状态 / 异常名。 */
  readonly detail: string
}

export interface UploadOutcome {
  readonly ok: boolean
  readonly route?: ReportRoute
  readonly attempts: readonly UploadAttempt[]
  /** 后台回的错误码；网络层没通为空。 */
  readonly code?: string
}

/** 回执号：LX-XXXX-XXXX，40 位随机。念得出来、写得下、撞车概率可忽略。 */
export function generateReceipt(pick: (max: number) => number = (max) => randomInt(max)): string {
  const block = (): string => Array.from({ length: 4 }, () => REPORT_RECEIPT_ALPHABET[pick(REPORT_RECEIPT_ALPHABET.length)]).join('')
  const receipt = `LX-${block()}-${block()}`
  if (!REPORT_RECEIPT_PATTERN.test(receipt)) throw new Error('REPORT_RECEIPT_INVALID')
  return receipt
}

/** 这条路线解析出来的代理是不是本机中继（也就是来信通道自己）。 */
export function loopsBackToTunnel(resolved: string, bridgePort: number | undefined): boolean {
  if (!/127\.0\.0\.1|::1|localhost/i.test(resolved)) return false
  if (bridgePort === undefined) return true // 认不出端口时按「可能是自己」处理：宁可跳过这条路线
  return new RegExp(`[:\\s]${String(bridgePort)}\\b`).test(resolved) || !/\d{2,5}/.test(resolved)
}

export interface UploadOptions {
  readonly url: string
  readonly payload: string
  readonly transport: ReportTransport
  /** 本机中继端口；用来认出「system 路线又绕回来信通道」。 */
  readonly bridgePort?: number
  readonly token?: string
  /** 每条路线试几次。客户在等，⛔ 无限转圈。 */
  readonly attemptsPerRoute?: number
  readonly delay?: (ms: number) => Promise<void>
}

/** 按路线顺序把包送出去。任一路线成功即止；全不成返回 ok:false，由调用方落本地文件。 */
export async function uploadReport(options: UploadOptions): Promise<UploadOutcome> {
  const attempts: UploadAttempt[] = []
  const perRoute = options.attemptsPerRoute ?? 2
  const wait = options.delay ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  let code: string | undefined
  for (const route of ['direct', 'system'] as const) {
    if (route === 'system') {
      let resolved: string
      try { resolved = await options.transport.resolveProxy(options.url, route) } catch (error) { resolved = error instanceof Error ? error.name : '' }
      if (loopsBackToTunnel(resolved, options.bridgePort)) {
        attempts.push({ route, ok: false, detail: 'skipped-loopback' })
        continue
      }
    }
    for (let attempt = 0; attempt < perRoute; attempt += 1) {
      if (attempt > 0) await wait(800)
      try {
        const response = await options.transport.post(options.url, route, options.payload, options.token)
        if (response.status >= 200 && response.status < 300) {
          attempts.push({ route, ok: true, detail: String(response.status) })
          return { ok: true, route, attempts }
        }
        code = errorCode(response.body) ?? code
        attempts.push({ route, ok: false, detail: `${String(response.status)}${code ? ` ${code}` : ''}` })
        // 4xx 是后台明说「这包不收」，换路线重发也是同样结果；只有 5xx 与网络层失败值得再试。
        if (response.status >= 400 && response.status < 500) return { ok: false, attempts, ...(code ? { code } : {}) }
      } catch (error) {
        attempts.push({ route, ok: false, detail: error instanceof Error ? (error.name || error.message) : 'unknown' })
      }
    }
  }
  return { ok: false, attempts, ...(code ? { code } : {}) }
}

function errorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return typeof parsed.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(parsed.code) ? parsed.code : undefined
  } catch { return undefined }
}

/** 发不出去时的落脚点：整包写成本机文件，客户手工发也对得上同一个回执号。 */
export async function saveReportLocally(directory: string, receipt: string, payload: string): Promise<string> {
  if (!REPORT_RECEIPT_PATTERN.test(receipt)) throw new Error('REPORT_RECEIPT_INVALID')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${receipt}.json`)
  await writeFile(path, payload, { mode: 0o600 })
  return path
}

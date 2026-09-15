import type { DownloadTaskSnapshot } from '../download/types'

// 安装回报的载荷:后台只要这四样。逐屏引导退役后这里不再引 GuideView——
// 那是一整张卡/门/检测器的类型图,⛔ 为了四个字段把它留着。
export interface InstallationReportView {
  readonly software: string
  readonly platform: string
  readonly stageCode: string
  readonly detectors: readonly { readonly state: string }[]
}

type CaptureReport = (customerConfirmed: boolean) => (view: InstallationReportView) => void
let capture: CaptureReport = () => () => undefined

// 回报方在异步操作开始前就捕获账号:之后换人登录不能认领这次操作。
export function setInstallationReporter(next: CaptureReport): void { capture = next }
export function captureInstallationReport(customerConfirmed = false): (view: InstallationReportView) => void { return capture(customerConfirmed) }

type CaptureDownload = (passive: boolean) => (task: DownloadTaskSnapshot | undefined) => void
let captureDownload: CaptureDownload = () => () => undefined
export function setDownloadReporter(next: CaptureDownload): void { captureDownload = next }
export function captureDownloadReport(passive = false): (task: DownloadTaskSnapshot | undefined) => void { return captureDownload(passive) }

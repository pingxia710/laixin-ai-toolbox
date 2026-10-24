// 安装回报的载荷:后台只要这四样。逐屏引导退役后这里不再引 GuideView——
// 那是一整张卡/门/检测器的类型图,⛔ 为了四个字段把它留着。
// RETIRE01:download 上报通道随未接线下载引擎一并退役,只保留安装回报。
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

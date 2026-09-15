import { actionButton, textNode } from './account-overview'

export function mountDeviceReport(element: HTMLElement): () => void {
  let active = true; let busy = false
  let timer: ReturnType<typeof setInterval> | undefined
  const section = document.createElement('section')
  const status = textNode('p', '正在读取电脑配置发送状态…', 'account-note'); status.setAttribute('role', 'status')
  const send = actionButton('发送基本电脑配置', () => { void sendReport() })
  section.append(textNode('h3', '客服协助'),
    textNode('p', '发送后，工具箱只会把以下基本配置告诉客服：平台、系统版本、芯片架构、内存、工具箱数据目录可用空间和工具箱版本。不会发送文件路径、机器名、账号密码、恢复码、会话令牌、API Key 或支付材料。', 'account-note'),
    status, send)
  element.append(section)
  const ensurePolling = (): void => {
    if (active && timer === undefined) timer = setInterval(() => { void refresh() }, 2000)
  }
  const stopPolling = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const apply = (result: { state: string; message: string }): void => {
    status.textContent = result.message
    // 未发送与失败可（重）试；发送中和已成功禁用，连点或完成后不会重复上报。
    send.disabled = result.state === 'syncing' || result.state === 'synced'
    if (result.state === 'syncing') ensurePolling()
    else stopPolling()
  }
  async function refresh(): Promise<void> {
    if (!active || busy) return
    busy = true; send.disabled = true
    try {
      const result = await window.toolbox.account.deviceReportStatus()
      if (active) apply(result)
    } catch {
      if (active) { status.textContent = '暂时无法读取发送状态，请重试。'; send.disabled = false; stopPolling() }
    }
    finally { busy = false }
  }
  async function sendReport(): Promise<void> {
    if (!active || busy) return
    busy = true; send.disabled = true
    try {
      const result = await window.toolbox.account.sendDeviceReport()
      if (active) apply(result)
    } catch {
      if (active) { status.textContent = '暂时无法发送，请重试。'; send.disabled = false; stopPolling() }
    }
    finally { busy = false }
  }
  void refresh()
  return () => { active = false; stopPolling() }
}

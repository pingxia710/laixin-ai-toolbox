import { createLocalQrCode } from '../components/help-contact/qr'

export interface QrRedirect { data: string; expiresAt: number }

const EXPIRY_WARN_MS = 60_000

function el(tag: 'p' | 'span', text = '', className = ''): HTMLElement {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}

// 同一笔付款的二维码数据在等待期间每秒倒计时重渲染,按 data 记忆化,⛔ 每次重新编码 SVG。
const paymentQrCache = new Map<string, SVGSVGElement>()
const PAYMENT_QR_CACHE_MAX = 8

export function renderPaymentQr(data: string): SVGSVGElement {
  const cached = paymentQrCache.get(data)
  if (cached !== undefined) return cached
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  try {
    const modules = createLocalQrCode(data).modules; const size = modules.length
    svg.setAttribute('viewBox', `-4 -4 ${size + 8} ${size + 8}`); svg.setAttribute('width', '220'); svg.setAttribute('height', '220'); svg.style.background = 'white'; svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '微信付款二维码')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('fill', 'black')
    path.setAttribute('d', modules.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x} ${y}h1v1h-1z`] : [])).join('')); svg.append(path)
  } catch { svg.setAttribute('aria-label', '二维码暂时无法生成，请点击重新生成二维码重试。') }
  const oldest = paymentQrCache.keys().next()
  if (paymentQrCache.size >= PAYMENT_QR_CACHE_MAX && !oldest.done) paymentQrCache.delete(oldest.value)
  paymentQrCache.set(data, svg)
  return svg
}

/** 微信收款二维码 + 过期倒计时：剩不到 1 分钟提示尽快扫码，
 * 过期后灰掉二维码并提供「重新生成二维码」。regenerate 由调用方重新发起付款。
 * 返回 stop():容器被替换或页面卸载时由调用方调用,停掉倒计时。 */
export function mountQrCountdown(container: HTMLElement, redirect: QrRedirect, options: { regenerate: () => void }): { stop: () => void } {
  container.classList.add('qr-countdown-block')
  const hint = el('p', '请用微信扫码支付，付款后自动更新进度。')
  const countdown = el('p', '', 'qr-countdown'); countdown.setAttribute('role', 'timer')
  const svg = renderPaymentQr(redirect.data)
  const actions = el('span'); actions.className = 'qr-countdown-actions'
  container.append(hint, countdown, svg, actions)
  let timer: ReturnType<typeof setInterval> | undefined
  const render = (remainingMs: number): void => {
    const expired = remainingMs <= 0
    container.classList.toggle('qr-expired', expired)
    if (expired) {
      svg.remove()
      actions.replaceChildren()
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-action'
      button.textContent = '重新生成二维码'; button.addEventListener('click', options.regenerate)
      actions.append(button)
      countdown.textContent = '二维码已过期，无法继续扫码。'
      stop()
      return
    }
    const totalSeconds = Math.ceil(remainingMs / 1000)
    countdown.textContent = remainingMs <= EXPIRY_WARN_MS
      ? `二维码将在 ${totalSeconds} 秒后过期，请尽快扫码。`
      : `二维码有效期剩余 ${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒。`
  }
  const stop = (): void => { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
  timer = setInterval(() => render(redirect.expiresAt - Date.now()), 1000)
  render(redirect.expiresAt - Date.now())
  return { stop }
}

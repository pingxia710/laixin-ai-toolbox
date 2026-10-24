import type { WechatPanelMode } from '../../../account-types'

/** Keep the isolated native login surface aligned with its visible page slot. */
export function mountWechatLoginPanel(slot: HTMLElement, onError: () => void, onMode: (mode: WechatPanelMode) => void): () => void {
  let active = true; let scheduled = 0; let previous = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let previousMode: WechatPanelMode | undefined
  const checkMode = async () => {
    try {
      const { mode } = await window.toolbox.account.wechatPanelMode()
      if (active && mode !== previousMode) { previousMode = mode; onMode(mode) }
    } catch { previousMode = undefined; if (active) onError() }
    if (active) timer = setTimeout(() => { void checkMode() }, 750)
  }
  const update = () => {
    scheduled = 0
    if (!active) return
    const rect = slot.getBoundingClientRect()
    const bounds = JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      visible: slot.isConnected && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth })
    if (bounds === previous) return
    previous = bounds
    void window.toolbox.account.wechatPanelBounds({ bounds }).catch(() => { if (active) onError() })
  }
  const schedule = () => { if (active && !scheduled) scheduled = requestAnimationFrame(update) }
  const observer = new ResizeObserver(schedule); observer.observe(slot)
  window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true)
  update()
  void checkMode()
  return () => {
    active = false; if (scheduled) cancelAnimationFrame(scheduled)
    if (timer) clearTimeout(timer)
    observer.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true)
    void window.toolbox.account.wechatPanelBounds({ bounds: JSON.stringify({ x: 0, y: 0, width: 0, height: 0, visible: false }) }).catch(() => undefined)
  }
}

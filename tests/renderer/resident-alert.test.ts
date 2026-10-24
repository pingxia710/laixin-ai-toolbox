import { afterEach, expect, it, vi } from 'vitest'
import { mountDesktopStatus } from '../../app/renderer/src/desktop-status'
import { requestTabNavigation } from '../../app/renderer/src/navigation'

vi.mock('../../app/renderer/src/navigation', () => ({ requestTabNavigation: vi.fn(), requestPlatformDownloadNavigation: vi.fn() }))
class Element {
  textContent = ''; className = ''; type = ''; title = ''; hidden = false
  children: Element[] = []; classList = { toggle: vi.fn() }
  onClick = () => undefined
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  after() {}
  before() {}
  addEventListener(_type: string, listener: () => undefined) { this.onClick = listener }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('主界面可见常驻失败码，点击进入设置，恢复后撤掉提示', async () => {
  vi.useFakeTimers()
  const nodes: Element[] = []
  vi.stubGlobal('document', { querySelector: () => new Element(), createElement: () => {
    const node = new Element(); nodes.push(node); return node
  } })
  const status = vi.fn(async () => ({ alerts: [{ id: 'resident:0x80070005', kind: 'resident', message: '网络常驻未生效。错误码：0x80070005' }], update: { state: 'current' } }))
  vi.stubGlobal('window', { addEventListener: vi.fn(), toolbox: { desktop: { status, onNavigate: () => () => undefined } } })
  mountDesktopStatus(new Element() as unknown as HTMLElement)
  await vi.advanceTimersByTimeAsync(0)
  const notices = nodes.find(node => node.className === 'desktop-alerts')!
  expect(notices.hidden).toBe(false)
  expect(notices.children[0].textContent).toContain('0x80070005')
  notices.children[0].onClick()
  expect(requestTabNavigation).toHaveBeenCalledWith('settings')
  status.mockResolvedValue({ alerts: [], update: { state: 'current' } })
  await vi.advanceTimersByTimeAsync(5000)
  expect(notices.hidden).toBe(true)
  expect(notices.children).toEqual([])
})

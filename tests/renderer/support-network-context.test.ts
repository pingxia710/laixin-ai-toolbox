import { afterEach, expect, it, vi } from 'vitest'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'
import type { HelpState } from '../../app/main/support-contact/help-state'
import { formatHelpState, parseHelpState } from '../../app/main/support-contact/help-state'

const { mountHelpContact } = vi.hoisted(() => ({ mountHelpContact: vi.fn(() => () => undefined) }))
vi.mock('../../app/renderer/src/components/help-contact', () => ({ mountHelpContact }))

class Element {
  textContent = ''; open = false; children: Element[] = []; handlers = new Map<string, () => void>()
  append(...children: Element[]) { this.children.push(...children) }
  prepend(...children: Element[]) { this.children.unshift(...children) }
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, handler) }
  removeEventListener() {}
  scrollIntoView() {}
}
const base: TunnelStatusView = {
  currentConfig: '', pendingConfig: '', canApplyPending: false, state: '未配置', message: '', source: '', authorization: '', backend: '',
  nodeLabel: '', exitIp: '', pathSource: '' as const, lastVerifiedAt: '', configVersion: '', expiresAt: '', pendingAvailable: false, unrestored: '', componentMissing: ''
}
let cleanup = () => undefined as void
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

async function readCopiedContext(status?: Partial<TunnelStatusView>): Promise<HelpState> {
  vi.stubGlobal('document', { createElement: () => new Element() })
  vi.stubGlobal('window', { toolbox: {
    app: { info: async () => ({ platform: 'darwin', version: 'test' }) },
    tunnel: { status: async () => { if (status === undefined) throw new Error('unavailable'); return { ...base, ...status } } },
    account: { supportContext: async () => ({}) }
  } })
  const { mountSupport } = await import('../../app/renderer/src/support-widget')
  const root = new Element(); cleanup = mountSupport(root as unknown as HTMLElement, 'tunnel')
  const details = root.children[0]; details.open = true; details.handlers.get('toggle')!()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const props = (mountHelpContact.mock.calls[0] as unknown as [unknown, { state: HelpState }])[1]
  return parseHelpState(formatHelpState(props.state))!
}

it.each(['用户主动断开', '已停止并恢复原设置', '未配置'])('客服摘要忠实记录 %s 为未连', async (state) => {
  expect((await readCopiedContext({ state })).channelStatus).toBe('未连')
})

it('恢复完成与仍在恢复在客服摘要中可以区分', async () => {
  expect((await readCopiedContext({ state: '已停止并恢复原设置' })).reasonCodes).toContain('NETWORK_RESTORED')
})

it('故障类别和恢复未完成进入副本，原始路径与敏感内容不进入副本', async () => {
  const state = await readCopiedContext({ state: '异常', message: '系统代理设置未生效或已被修改，请恢复原设置后重试',
    unrestored: 'Wi-Fi/socks-proxy:未恢复:失败:/Users/private/credentials.json?token=secret-fixture',
    currentConfig: 'ssh://secret-fixture@example.invalid', nodeLabel: 'private-node.invalid' })
  expect(state.reasonCodes).toContain('NETWORK_PROXY_NOT_APPLIED')
  expect(state.reasonCodes).toContain('NETWORK_RESTORE_INCOMPLETE')
  expect(formatHelpState(state)).not.toMatch(/secret-fixture|Users|credentials|private-node|Wi-Fi/)
})

// 一个 it 里只读一次:readCopiedContext 取的是 mountHelpContact.mock.calls[0],
// 同一个 it 里调第二次会读回第一次的结果(写这条时踩过,是假绿)。
it('代理冲突归到固定类别:客户看到的那句话认得出', async () => {
  expect((await readCopiedContext({ state: '异常', message: '检测到其他代理，请先在该软件中断开代理，再连接来信通道' })).reasonCodes)
    .toContain('NETWORK_PROXY_CONFLICT')
})

it('代理冲突归到固定类别:守护写的裸码漏到界面上也认得出,⛔ 落成「未识别故障」', async () => {
  expect((await readCopiedContext({ state: '异常', message: '已有代理控制' })).reasonCodes)
    .toContain('NETWORK_PROXY_CONFLICT')
})

it('意外退出终态改说「未预期的问题」后仍归到进程退出类别(Phase 2 ⑥同款文案),⛔ 退化为通用未识别', async () => {
  expect((await readCopiedContext({ state: '异常', message: '来信遇到一个未预期的问题，连接已停止。请点击重新连接；若反复出现，请复制诊断给客服' })).reasonCodes)
    .toContain('NETWORK_PROCESS_EXIT')
})

it('未识别故障仅复制通用类别，读取失败仍是未知且不会报未连', async () => {
  const state = await readCopiedContext({ state: '异常', message: 'secret-fixture /Users/private/config.json' })
  expect(state.reasonCodes).toContain('NETWORK_CONNECTION_ERROR')
  expect(formatHelpState(state)).not.toContain('secret-fixture')
})

it('状态读取失败保留未知与读取故障，不推断恢复完成', async () => {
  const state = await readCopiedContext()
  expect(state.channelStatus).toBe('未知')
  expect(state.reasonCodes).toContain('NETWORK_STATUS_UNAVAILABLE')
  expect(state.reasonCodes).not.toContain('NETWORK_RESTORED')
})

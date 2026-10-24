import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backupPaths, findingTitle, findingWhere, noticeHeadline, readHiddenStateCleanReceipt, readHiddenStateReport,
  readHiddenStateRestoreOutcome, renderHiddenStateNotice
} from '../../app/renderer/src/platform/hidden-state'
import type { HiddenStateCleanReceipt, HiddenStateRestoreOutcome } from '../../app/main/actions/hidden-state'
import type { HiddenStateFinding, HiddenStateReport } from '../../app/main/ai-access/hidden-state'

// 仓里渲染层用例一律用这个手写桩，没有 jsdom。
class Element {
  textContent = ''
  className = ''
  type = ''
  disabled = false
  hidden = false
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  children: Element[] = []
  handlers = new Map<string, () => unknown>()

  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  addEventListener(event: string, handler: () => unknown) { this.handlers.set(event, handler) }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  removeAttribute(name: string) { delete this.attributes[name] }
  click(): unknown { return this.disabled ? undefined : this.handlers.get('click')?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  byClass(name: string): Element[] { return this.all().filter((item) => item.className.split(' ').includes(name)) }
  text(): string { return this.all().map((item) => item.textContent).join(' ') }
}

afterEach(() => vi.unstubAllGlobals())
function stubDocument(): void { vi.stubGlobal('document', { createElement: () => new Element() }) }

const finding = (over: Partial<HiddenStateFinding> = {}): HiddenStateFinding => ({
  id: 'a', kind: 'shell_export', source: '/Users/demo/.zshrc', name: 'ANTHROPIC_AUTH_TOKEN', valueMasked: 'sk-a••••cdef',
  affects: ['claude'], severity: 'warning', impact: '会盖掉工具箱写的接入。', suggestion: '点一下停用。', cleanable: true, line: 12, ...over
})
const report = (over: Partial<HiddenStateReport> = {}): HiddenStateReport =>
  ({ scannedAt: '2026-09-13T11:00:00.000Z', platform: 'darwin', findings: [finding()], unreadable: [], ...over })

const receipt = (over: Partial<HiddenStateCleanReceipt> = {}): HiddenStateCleanReceipt => ({
  version: 1, receiptId: '9aefb2d8-4d73-4e30-b267-84e6f517de4a', at: '2026-09-13T11:00:00.000Z', cleaned: 1, failures: [], notes: ['新开一个终端才生效。'],
  shell: { entries: [{ source: '/Users/demo/.zshrc', backupPath: '/b/.zshrc.bak', name: 'ANTHROPIC_AUTH_TOKEN', line: 12 }], failures: [], notes: [] },
  registry: { entries: [], failures: [], notes: [] },
  claude: [], ...over
})
const restored = (over: Partial<HiddenStateRestoreOutcome> = {}): HiddenStateRestoreOutcome =>
  ({ results: [{ source: '/Users/demo/.zshrc', name: 'ANTHROPIC_AUTH_TOKEN', outcome: 'restored' }], notes: [], ...over })

function mount(input: HiddenStateReport, over: Partial<Parameters<typeof renderHiddenStateNotice>[2]> = {}) {
  stubDocument()
  const container = new Element()
  const onClean = vi.fn(async () => receipt())
  const onRestore = vi.fn(async () => restored())
  const section = renderHiddenStateNotice(container as unknown as HTMLElement, input, { onClean, onRestore, ...over })
  return { container, onClean, onRestore, section: section as unknown as Element | null }
}

describe('隐形状态提示 · 上屏前的校验', () => {
  it('结构不对就当没有，⛔ 把任意文本塞进界面', () => {
    expect(readHiddenStateReport(JSON.stringify(report())).findings).toHaveLength(1)
    expect(() => readHiddenStateReport('{}')).toThrow()
    expect(() => readHiddenStateReport(JSON.stringify(report({ findings: [{ ...finding(), kind: 'whatever' } as unknown as HiddenStateFinding] })))).toThrow()
    expect(() => readHiddenStateReport(JSON.stringify(report({ findings: [{ ...finding(), affects: ['ollama'] } as unknown as HiddenStateFinding] })))).toThrow()
  })

  it('清理回执只接受可恢复的脱敏凭据，⛔ 把原 shell 行或 Key 带过桥', () => {
    expect(readHiddenStateCleanReceipt(JSON.stringify(receipt())).receiptId).toBe('9aefb2d8-4d73-4e30-b267-84e6f517de4a')
    expect(() => readHiddenStateCleanReceipt(JSON.stringify({ ...receipt(), shell: {
      ...receipt().shell, entries: [{ ...receipt().shell.entries[0], originalLine: 'export OPENAI_API_KEY=sk-should-not-cross-ipc' }]
    }}))).toThrow('HIDDEN_STATE_CLEAN_RECEIPT_INVALID')
    expect(readHiddenStateRestoreOutcome(JSON.stringify(restored())).results).toHaveLength(1)
    expect(() => readHiddenStateRestoreOutcome('{bad')).toThrow()
  })
})

describe('隐形状态提示 · 一句话抬头', () => {
  it('有会干扰的就说几处；只剩参考项就明说没有；一条都没有返回 null ⛔ 报「未知」', () => {
    expect(noticeHeadline(report())).toBe('发现 1 处会干扰接入的旧设置')
    expect(noticeHeadline(report({ findings: [finding({ severity: 'info' })] }))).toBe('没有会干扰接入的旧设置，另有 1 处情况供你参考')
    expect(noticeHeadline(report({ findings: [] }))).toBeNull()
    expect(noticeHeadline(report({ findings: [], unreadable: [{ source: '/x', reason: '没有读取权限' }] }))).toBe('这次有 1 处没能检查')
  })

  it('什么都没有时不往容器里塞空壳', () => {
    const mounted = mount(report({ findings: [] }))
    expect(mounted.section).toBeNull()
    expect(mounted.container.children).toEqual([])
  })
})

describe('隐形状态提示 · 每条说清在哪、是什么、影响谁', () => {
  it('标题写这是什么事，⛔ 甩一个变量名给客户', () => {
    expect(findingTitle(finding())).toBe('终端启动文件里留着一条 ANTHROPIC_AUTH_TOKEN')
    expect(findingTitle(finding({ kind: 'system_proxy', name: '系统代理' }))).toBe('这台电脑开着上网代理')
    expect(findingTitle(finding({ kind: 'claude_onboarding', name: 'hasCompletedOnboarding' }))).toBe('Claude Code 还停在第一次使用的引导页')
    expect(findingWhere(finding())).toBe('在 /Users/demo/.zshrc 第 12 行 · 当前是 sk-a••••cdef')
  })

  it('软链要把真正的文件说出来，⛔ 让客户照着空文件去找', () => {
    expect(findingWhere(finding({ source: '/Users/demo/.bashrc', resolvedSource: '/Users/demo/dotfiles/bashrc', line: 3 })))
      .toBe('在 /Users/demo/.bashrc（链接到 /Users/demo/dotfiles/bashrc） 第 3 行 · 当前是 sk-a••••cdef')
  })

  it('四样都在，且**⛔ 显示完整密钥**', () => {
    const mounted = mount(report({ findings: [finding({ valueMasked: 'sk-a••••cdef' })] }))
    const text = mounted.section!.text()
    expect(text).toContain('/Users/demo/.zshrc 第 12 行')
    expect(text).toContain('sk-a••••cdef')
    expect(text).toContain('影响 Claude Code')
    expect(text).toContain('点一下停用。')
    expect(text).not.toContain('sk-ant-0123456789abcdef')
  })

  it('只报告的那些不给清理按钮', () => {
    const mounted = mount(report({ findings: [finding({ cleanable: false }), finding({ id: 'b', cleanable: true })] }))
    expect(mounted.section!.byClass('hidden-state-clean')).toHaveLength(1)
    // 只有一条能处理时不出「一次全部停用」。
    expect(mounted.section!.byClass('hidden-state-clean-all')).toHaveLength(0)
  })

  it('没读出来的那几处照实说，不影响其余结果', () => {
    const mounted = mount(report({ unreadable: [{ source: 'HKLM\\Environment', reason: '没有读取权限' }] }))
    expect(mounted.section!.byClass('hidden-state-unreadable')[0].textContent).toContain('HKLM\\Environment')
  })
})

describe('隐形状态提示 · 点清理与撤销', () => {
  it('点单条只清这一条；说处理了几条，⛔ 把「点过了」说成「清好了」', async () => {
    const mounted = mount(report({ findings: [finding(), finding({ id: 'b', name: 'OPENAI_API_KEY' })] }))
    await mounted.section!.byClass('hidden-state-clean')[0].click()
    expect(mounted.onClean).toHaveBeenCalledWith(['a'])
    const status = mounted.section!.byClass('hidden-state-status')[0]
    expect(status.hidden).toBe(false)
    expect(status.textContent).toContain('已停用 1 处')
    expect(status.textContent).toContain('新开一个终端才生效')
  })

  it('一次全部停用把能处理的都传过去', async () => {
    const mounted = mount(report({ findings: [finding(), finding({ id: 'b' }), finding({ id: 'c', cleanable: false })] }))
    await mounted.section!.byClass('hidden-state-clean-all')[0].click()
    expect(mounted.onClean).toHaveBeenCalledWith(['a', 'b'])
  })

  it('一条也没改动时照实说，⛔ 报「已清理」', async () => {
    const mounted = mount(report(), { onClean: async () => receipt({ cleaned: 0, failures: [{ source: '/Users/demo/.zshrc', name: 'ANTHROPIC_AUTH_TOKEN', reason: '没有写入权限' }] }) })
    await mounted.section!.byClass('hidden-state-clean')[0].click()
    const status = mounted.section!.byClass('hidden-state-status')[0]
    expect(status.textContent).toContain('一处也没改动')
    expect(status.textContent).toContain('没有写入权限')
    expect(status.dataset.tone).toBe('danger')
    expect(mounted.section!.byClass('hidden-state-undo')[0].hidden).toBe(true)
  })

  it('清理成功后才出现撤销；撤销把那份凭据原样交回去', async () => {
    const mounted = mount(report())
    const undo = mounted.section!.byClass('hidden-state-undo')[0]
    expect(undo.hidden).toBe(true)
    await mounted.section!.byClass('hidden-state-clean')[0].click()
    expect(undo.hidden).toBe(false)
    await undo.click()
    expect(mounted.onRestore).toHaveBeenCalledWith(receipt())
    expect(mounted.section!.byClass('hidden-state-status')[0].textContent).toContain('已经全部还原')
  })

  it('清理出错时给得出下一步，**⛔ 只说「请稍后再试」**', async () => {
    const mounted = mount(report(), { onClean: async () => { throw new Error('bridge down') } })
    await mounted.section!.byClass('hidden-state-clean')[0].click()
    const status = mounted.section!.byClass('hidden-state-status')[0]
    expect(status.textContent).toContain('你的文件一点没动')
    expect(status.textContent).toContain('#')
    expect(status.textContent).not.toContain('请稍后再试')
  })

  it('还原出错时把备份在哪说出来，**⛔ 让客户没得做**', async () => {
    const mounted = mount(report(), { onRestore: async () => { throw new Error('bridge down') } })
    await mounted.section!.byClass('hidden-state-clean')[0].click()
    await mounted.section!.byClass('hidden-state-undo')[0].click()
    expect(mounted.section!.byClass('hidden-state-status')[0].textContent).toContain('/b/.zshrc.bak')
    expect(backupPaths(receipt())).toEqual(['/b/.zshrc.bak'])
  })

  it('还原只成功了一部分就照实说，并点名要手工处理的那几处', async () => {
    const mounted = mount(report(), {
      onRestore: async () => restored({ results: [{ source: '/Users/demo/.zshrc', name: 'ANTHROPIC_AUTH_TOKEN', outcome: 'failed', reason: '后来又被改过', backupPath: '/b/.zshrc.bak' }] })
    })
    await mounted.section!.byClass('hidden-state-clean')[0].click()
    await mounted.section!.byClass('hidden-state-undo')[0].click()
    const status = mounted.section!.byClass('hidden-state-status')[0]
    expect(status.textContent).toContain('后来又被改过')
    expect(status.textContent).toContain('备份在 /b/.zshrc.bak')
    expect(mounted.section!.byClass('hidden-state-undo')[0].hidden).toBe(false)
  })

  it('残留代理给「去网络处理」直达按钮，⛔ 让客户自己找去哪儿', async () => {
    const proxy = finding({ id: 'p', kind: 'system_proxy', name: '系统代理', severity: 'blocking', cleanable: false })
    const onOpenNetwork = vi.fn()
    const mounted = mount(report({ findings: [proxy] }), { onOpenNetwork })
    await mounted.section!.byClass('hidden-state-open-network')[0].click()
    expect(onOpenNetwork).toHaveBeenCalled()
    // 不是代理的那些条目不出这个按钮。
    expect(mount(report(), { onOpenNetwork }).section!.byClass('hidden-state-open-network')).toHaveLength(0)
    // 没接回调就不出按钮。
    expect(mount(report({ findings: [proxy] })).section!.byClass('hidden-state-open-network')).toHaveLength(0)
  })

  it('接了重新检查就多一个按钮，客户出错后能自己走回闭环', async () => {
    const onRescan = vi.fn(async () => undefined)
    const mounted = mount(report({ findings: [finding(), finding({ id: 'b' })] }), { onRescan })
    await mounted.section!.byClass('hidden-state-rescan')[0].click()
    expect(onRescan).toHaveBeenCalled()
    expect(mount(report()).section!.byClass('hidden-state-rescan')).toHaveLength(0)
  })
})

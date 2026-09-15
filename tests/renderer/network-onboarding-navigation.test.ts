import { afterEach, expect, it, vi } from 'vitest'
import { buildNetworkOnboarding, renderNetworkOnboarding, type NetworkOnboardingView } from '../../app/renderer/src/ui/network-onboarding'

class Element {
  textContent = ''; className = ''; type = ''; id = ''; disabled = false
  dataset: Record<string, string> = {}; attributes = new Map<string, string>()
  children: Element[] = []; handlers = new Map<string, () => void>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler) }
  click() { if (!this.disabled) this.handlers.get('click')?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

const terms = { plans: [], toolbox: { id: 'toolbox', priceCents: 1990, subject: '来信 AI 工具箱' }, trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3 }
const firstStep = buildNetworkOnboarding({ state: 'signed-out', account: null, overview: null, code: '', message: '', terms }, undefined)

function setup(view = firstStep, busy = false) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const root = new Element('section')
  const run = vi.fn()
  let selectedStep = view.step
  const render = (): void => renderNetworkOnboarding(root as unknown as HTMLElement, view, busy, '', run, (step) => {
    selectedStep = step; render()
  }, selectedStep)
  render()
  return {
    root, run,
    select: (step: NetworkOnboardingView['step']) => root.all().find((node) => node.dataset.onboardingStep === String(step))!.click(),
    primary: () => root.all().find((node) => node.className === 'primary-action')!
  }
}

afterEach(() => vi.unstubAllGlobals())

it('四个步骤都能点击查看，切换不会触发注册、领取或连接', () => {
  const ui = setup()
  for (const [step, title] of [[2, '领取 5 GB 体验流量'], [3, '连接网络'], [4, '查看 Codex 下载与版本'], [1, '先注册账号']] as const) {
    ui.select(step)
    expect(ui.root.all().find((node) => node.tag === 'h2')?.textContent).toBe(title)
    expect(ui.root.all().filter((node) => node.attributes.get('aria-pressed') === 'true').map((node) => node.dataset.onboardingStep)).toEqual([String(step)])
    if (step !== 1) expect(ui.root.all().find((node) => node.className === 'onboarding-step-label')?.textContent).toBe(`第${step}步`)
    expect(ui.run).not.toHaveBeenCalled()
  }
  ui.primary().click()
  expect(ui.run).toHaveBeenCalledExactlyOnceWith('register')
})

it('查看后续步骤显示对应步骤名称，并保留实际进度', () => {
  const ui = setup()
  ui.select(4)
  expect(ui.root.all().find((node) => node.className === 'onboarding-count')?.textContent).toContain('当前第 1 步')
  expect(ui.root.all().find((node) => node.className === 'onboarding-step-label')?.textContent).toBe('第4步')
  expect(ui.primary()).toBeUndefined()
  ui.select(1)
  expect(ui.root.all().find((node) => node.tag === 'h2')?.textContent).toBe('先注册账号')
  expect(ui.run).not.toHaveBeenCalled()
})

it('当前操作处理中仍可查看其他步骤，返回后不会重复提交', () => {
  const ui = setup({ step: 2, title: '领取 5 GB 体验流量', description: '', label: '领取', action: 'claim', terms }, true)
  ui.select(3)
  ui.select(2)
  expect(ui.primary().disabled).toBe(true)
  ui.primary().click()
  expect(ui.run).not.toHaveBeenCalled()
})

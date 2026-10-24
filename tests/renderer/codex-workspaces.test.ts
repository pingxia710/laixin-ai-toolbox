import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiAccessApi } from '../../app/preload/api/ai-access'
import type { AiAccessStatus } from '../../app/main/ai-access/service'
import { codexWorkspaceOptions, codexWorkspaceResultMessage, createCodexWorkspaceViewState,
  readCodexWorkspaceOpenResult, renderCodexWorkspaces, restoreCodexWorkspaceFocus } from '../../app/renderer/src/platform/codex-workspaces'

class Element {
  textContent = ''; className = ''; type = ''; value = ''; placeholder = ''; disabled = false; required = false
  autocomplete = ''; maxLength = 0; minLength = 0; dataset: Record<string, string> = {}; children: Element[] = []
  onclick?: () => void
  oninput?: () => void
  onsubmit?: (event: { preventDefault(): void }) => void
  attributes: Record<string, string> = {}
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  append(...children: Element[]) { this.children.push(...children) }
  prepend(...children: Element[]) { this.children.unshift(...children) }
  reportValidity() { return !this.required || this.value.length >= this.minLength }
  focus() {}
  querySelector(selector: string): Element | undefined {
    const match = /^\[data-codex-focus="([^"]+)"\]$/.exec(selector)
    return match ? this.all().find(item => item.dataset.codexFocus === match[1]) : undefined
  }
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' ') },
    toggle: (name: string, force?: boolean) => {
      const names = this.className.split(' ').filter(Boolean)
      const next = force ?? !names.includes(name)
      this.className = [...new Set(next ? [...names, name] : names.filter(item => item !== name))].join(' ')
      return next
    }
  }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())] }
}

const providerKeys = { deepseek: true, 'zhipu-api': false, zhipu: false, moonshot: false, kimi: false }
function status(mode: 'single' | 'multi', models: NonNullable<AiAccessStatus['codexMultiModel']>['models'] = [
  { provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }
]): AiAccessStatus {
  return {
    codexMultiModel: { mode, models },
    shells: {
      codex: { selected: 'zhipu-api', officialAvailable: true, providerKeys },
      claude: { selected: null, officialAvailable: true, providerKeys },
      hermes: { selected: null, officialAvailable: false, providerKeys }
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new Element() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Codex 来信多模型入口', () => {
  it('只展示官方与单个来信多模型对话入口，不再暴露按来源固定的工作窗口', () => {
    expect(codexWorkspaceOptions.map(option => [option.id, option.title])).toEqual([
      ['official', 'OpenAI 官方套餐'],
      ['multi', '来信多模型']
    ])
  })

  it('只接受受控结果，并准确说明模型池为空和 GUI 真退出边界', () => {
    const opened = readCodexWorkspaceOpenResult('{"ok":true,"source":"multi","code":"opened"}')
    expect(codexWorkspaceResultMessage(opened, '来信多模型')).toContain('Codex 自带选择器')
    expect(codexWorkspaceResultMessage(opened, '来信多模型')).toContain('GUI 退出后')
    expect(codexWorkspaceResultMessage(opened, '来信多模型')).not.toContain('工具箱运行期间')
    const empty = readCodexWorkspaceOpenResult('{"ok":false,"source":"multi","code":"model_pool_empty"}')
    expect(codexWorkspaceResultMessage(empty, '来信多模型')).toContain('至少一个模型')
    const loginRequired = readCodexWorkspaceOpenResult('{"ok":false,"source":"official","code":"login_required"}')
    expect(codexWorkspaceResultMessage(loginRequired, 'OpenAI 官方套餐')).toContain('完成官方套餐登录')
    expect(readCodexWorkspaceOpenResult('{"ok":true,"source":"deepseek","code":"opened"}')).toBeNull()
  })

  it('多模型页只保留模式动作和模型来源，不常驻展示内部运行证据', () => {
    const state = createCodexWorkspaceViewState() as ReturnType<typeof createCodexWorkspaceViewState> & {
      runtime?: unknown
    }
    state.runtime = { running: true, modelCount: 1, catalog: { state: 'written' } }
    const api = {
      setCodexMode: vi.fn(), configureCodexMultiModel: vi.fn(), removeCodexMultiModel: vi.fn(),
      verifyAndAddCodexMultiModel: vi.fn(), openProviderConsole: vi.fn()
    } as unknown as AiAccessApi
    const root = renderCodexWorkspaces({ open: vi.fn() }, api, status('multi'), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    const texts = root.all().map(item => item.textContent)

    expect(texts).toContain('单模型切换')
    expect(texts).toContain('多模型共用')
    expect(texts).toContain('编辑池内模型')
    expect(texts).toContain('移出模型池')
    expect(texts).not.toContain('Codex 模型模式')
    expect(texts).not.toContain('Codex 来信多模型')
    expect(texts).not.toContain('后台路由可用')
    expect(texts).not.toContain('模型目录已写入')
    expect(texts).not.toContain('等待首次使用')
    expect(texts.some(text => text.startsWith('已验证并加入模型池：1 个'))).toBe(false)
    expect(texts.some(text => text.includes('官方订阅对话与来信多模型对话分开'))).toBe(false)
    expect(texts.some(text => text.includes('Key 已保存') && text.includes('实际使用'))).toBe(false)
    expect(root.all().find(item => item.textContent === '更换 Key 并验证')?.type).toBe('submit')
  })

  it('模式按钮调用主进程事务，失败时不在前端伪造模式切换', async () => {
    const state = createCodexWorkspaceViewState()
    const setCodexMode = vi.fn(async () => { throw new Error('fixture stop failure') })
    const render = vi.fn()
    const root = renderCodexWorkspaces({ open: vi.fn() }, { setCodexMode } as unknown as AiAccessApi,
      status('multi'), state, render, vi.fn(async () => undefined)) as unknown as Element
    root.all().find(item => item.textContent === '单模型切换')?.onclick?.()
    for (let index = 0; index < 5; index += 1) await Promise.resolve()

    expect(setCodexMode).toHaveBeenCalledWith({ mode: 'single' })
    expect(state.message).toContain('仍保持多模型共用')
    expect(state.focusTarget).toBe('mode-single')
  })

  it('single 空池进入多模型后直接展示来源，取消时不堆叠设置说明和内部状态', () => {
    const state = createCodexWorkspaceViewState()
    const setCodexMode = vi.fn()
    const api = { setCodexMode, openProviderConsole: vi.fn() } as unknown as AiAccessApi
    let root = renderCodexWorkspaces(undefined, api, status('single', []), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    root.all().find(item => item.textContent === '多模型共用')?.onclick?.()
    expect(state.setupRequested).toBe(true)

    root = renderCodexWorkspaces(undefined, api, status('single', []), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    const setupTexts = root.all().map(item => item.textContent)
    expect(setupTexts).not.toContain('设置多模型共用')
    expect(setupTexts).not.toContain('先验证并加入一个模型；成功后才会进入多模型共用。')
    expect(setupTexts).not.toContain('加入首个模型后由工具箱启动后台路由。')
    expect(setupTexts).not.toContain('模型目录尚未写入')
    expect(setupTexts).not.toContain('等待首次使用')
    expect(setupTexts.some(text => text.startsWith('已验证并加入模型池：0 个'))).toBe(false)
    expect(setupTexts).not.toContain('后台路由需要工具箱修复')
    expect(setupTexts).not.toContain('检查并修复后台路由')
    const single = root.all().find(item => item.textContent === '单模型切换')
    expect(single?.disabled).toBe(false)
    expect(single?.attributes['aria-pressed']).toBe('false')
    single?.onclick?.()

    expect(state.setupRequested).toBe(false)
    expect(setCodexMode).not.toHaveBeenCalled()
    expect(state.focusTarget).toBe('mode-multi')
    root = renderCodexWorkspaces(undefined, api, status('single', []), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    const multi = root.all().find(item => item.textContent === '多模型共用')!
    const focus = vi.spyOn(multi, 'focus')
    restoreCodexWorkspaceFocus(root as unknown as HTMLElement, state)
    expect(focus).toHaveBeenCalledOnce()
    expect(root.all().some(item => item.textContent === '设置多模型共用')).toBe(false)
  })

  it.each([
    ['not_running', '后台路由已停止', '启动后台路由'],
    ['stale_route', '后台路由需要工具箱修复', '检查并修复后台路由'],
    ['port_conflict', '后台路由需要工具箱修复', '检查并修复后台路由'],
    ['protocol_incompatible', '后台路由需要工具箱修复', '检查并修复后台路由']
  ] as const)('后台 %s 显示明确状态和可执行修复入口', async (error, label, action) => {
    const state = createCodexWorkspaceViewState()
    state.runtime = { running: false, modelCount: 1, error, catalog: { state: 'written' } }
    const repairCodexMultiModelRouter = vi.fn(async () => ({ snapshot: JSON.stringify({ repaired: error === 'not_running' }) }))
    const root = renderCodexWorkspaces(undefined, { repairCodexMultiModelRouter } as unknown as AiAccessApi,
      status('multi'), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    expect(root.all().map(item => item.textContent)).toContain(label)
    root.all().find(item => item.textContent === action)?.onclick?.()
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    expect(repairCodexMultiModelRouter).toHaveBeenCalledOnce()
  })

  it.each([
    ['port_conflict', '工具箱无法自动修复：本机后台服务被其他程序占用。请关闭占用本机服务的程序后重试。', /后台版本|控制协议|配置尚未完成/],
    ['protocol_incompatible', '工具箱无法自动修复：后台版本或控制协议不一致。请切回单模型继续使用；当前版本不会自动替换后台。', /占用本机服务|配置尚未完成/],
    ['not_configured', '后台配置尚未完成。请切回单模型，再重新进入多模型设置并验证加入模型。', /占用本机服务|后台版本|控制协议/]
  ] as const)('人工处理结果按 %s 给出互不混用的脱敏下一步', async (error, expected, forbidden) => {
    const state = createCodexWorkspaceViewState()
    state.runtime = { running: false, modelCount: 1, error, catalog: { state: 'written' } }
    const repairCodexMultiModelRouter = vi.fn(async () => ({
      snapshot: JSON.stringify({ repaired: false, reason: 'manual_intervention_required' })
    }))
    const root = renderCodexWorkspaces(undefined, { repairCodexMultiModelRouter } as unknown as AiAccessApi,
      status('multi'), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    root.all().find(item => item.textContent === '检查并修复后台路由')?.onclick?.()
    for (let index = 0; index < 6; index += 1) await Promise.resolve()

    expect(state.message).toBe(expected)
    expect(state.message).not.toMatch(forbidden)
    expect(state.message).not.toMatch(/PID|43210|\/private|token|secret/i)
  })

  it('修复进行中显示启动中，失败后保留原状态并把焦点还给修复按钮', async () => {
    const state = createCodexWorkspaceViewState()
    state.runtime = { running: false, modelCount: 1, error: 'not_running', catalog: { state: 'written' } }
    let rejectRepair: ((error: Error) => void) | undefined
    const repairCodexMultiModelRouter = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectRepair = reject }))
    const render = () => renderCodexWorkspaces(undefined, { repairCodexMultiModelRouter } as unknown as AiAccessApi,
      status('multi'), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    let root = render()
    root.all().find(item => item.textContent === '启动后台路由')?.onclick?.()
    root = render()
    expect(root.all().map(item => item.textContent)).toContain('后台路由正在启动')
    rejectRepair?.(new Error('fixture repair failure'))
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    expect(state.runtime?.error).toBe('not_running')
    expect(state.focusTarget).toBe('repair-router')
  })

  it('异步重绘按服务商隔离输入草稿，更新失败把焦点目标留在本次输入', async () => {
    const state = createCodexWorkspaceViewState()
    const api = {
      configureCodexMultiModel: vi.fn(async () => { throw new Error('fixture verify failed') }),
      openProviderConsole: vi.fn()
    } as unknown as AiAccessApi
    const render = () => renderCodexWorkspaces(undefined, api, status('multi'), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    let root = render()
    const inputs = root.all().filter(item => item.attributes['aria-label']?.endsWith('API Key'))
    inputs[0].value = 'sk-fixture-deepseek-draft-012345'; inputs[0].oninput?.()
    inputs[1].value = 'sk-fixture-zhipu-draft-01234567'; inputs[1].oninput?.()
    root = render()
    const restored = root.all().filter(item => item.attributes['aria-label']?.endsWith('API Key'))
    expect(restored[0].value).toBe('sk-fixture-deepseek-draft-012345')
    expect(restored[1].value).toBe('sk-fixture-zhipu-draft-01234567')

    const zhipu = restored[1]
    const form = root.all().find(item => item.children.includes(zhipu))
    form?.onsubmit?.({ preventDefault() {} })
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    expect(api.configureCodexMultiModel).toHaveBeenCalledWith({ provider: 'zhipu-api', key: 'sk-fixture-zhipu-draft-01234567', model: '' })
    expect(state.focusTarget).toBe('key-zhipu-api')
    expect(state.drafts.deepseek).toBe('sk-fixture-deepseek-draft-012345')
  })

  it('移除最后一项后把焦点目标交给多模型入口，并保留真实 single 回读', async () => {
    const next: AiAccessStatus = { ...status('single'), codexMultiModel: { mode: 'single', models: [] } }
    const state = createCodexWorkspaceViewState()
    const api = {
      removeCodexMultiModel: vi.fn(async () => ({ snapshot: JSON.stringify(next) })), openProviderConsole: vi.fn()
    } as unknown as AiAccessApi
    const root = renderCodexWorkspaces(undefined, api, status('multi'), state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
    root.all().find(item => item.textContent === '移出模型池')?.onclick?.()
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    expect(api.removeCodexMultiModel).toHaveBeenCalledWith({ provider: 'deepseek' })
    expect(state.focusTarget).toBe('mode-multi')
    expect(state.message).toContain('已回到单模型')
  })
})

// 创始人 2026-09-29 定案：OpenAI 官方套餐作为多模型池的第一条线，工具箱内可登录
//（桌面端直登同样探测得到），登录有效显示绿色「已启用」。
const officialAuth = (state: 'official' | 'login-required') => ({ codex: { state, reason: 'chatgpt-session' as const } })
const text = (root: Element): string => root.all().map(element => element.textContent).join('')
const buttonOf = (root: Element, label: string): Element | undefined =>
  root.all().find(element => element.textContent === label)

it('多模型视图：第一行是 OpenAI 官方套餐，登录有效时显示绿色“已启用”且无登录按钮', () => {
  const state = createCodexWorkspaceViewState()
  const root = renderCodexWorkspaces({ open: vi.fn() }, { startCodexOfficialLogin: vi.fn() } as unknown as AiAccessApi,
    { ...status('multi'), officialAuthentication: officialAuth('official') }, state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
  const pool = root.all().find(element => element.className.split(' ').includes('codex-multi-model-pool'))
  expect(pool?.children[0]?.dataset.workspaceSource).toBe('official')
  expect(pool?.children[0]?.all().some(element => element.textContent === 'OpenAI 官方套餐')).toBe(true)
  expect(text(root)).toContain('已启用')
  expect(buttonOf(root, '登录官方账号')).toBeUndefined()
  const badge = root.all().find(element => element.textContent === '已启用')
  expect(badge?.className.split(' ').includes('is-current')).toBe(true)
})

it('多模型视图：未登录时可从 OpenAI 官方套餐行发起登录', async () => {
  const state = createCodexWorkspaceViewState()
  const startCodexOfficialLogin = vi.fn(async () => ({ snapshot: '{"status":"pending"}' }))
  const root = renderCodexWorkspaces({ open: vi.fn() }, { startCodexOfficialLogin } as unknown as AiAccessApi,
    { ...status('multi'), officialAuthentication: officialAuth('login-required') }, state, vi.fn(), vi.fn(async () => undefined)) as unknown as Element
  const full = text(root)
  expect(root.all().some(element => element.textContent === 'OpenAI 官方套餐')).toBe(true)
  expect(full).toContain('Codex 桌面端')
  buttonOf(root, '登录官方账号')?.onclick?.()
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  expect(startCodexOfficialLogin).toHaveBeenCalledOnce()
  expect(buttonOf(root, '已启用')).toBeUndefined()
})

it('多模型视图：官方登录等待中可以从套餐行取消授权', async () => {
  const state = createCodexWorkspaceViewState()
  const cancelCodexOfficialLogin = vi.fn(async () => ({ snapshot: '{"status":"idle"}' }))
  const root = renderCodexWorkspaces({ open: vi.fn() }, { cancelCodexOfficialLogin } as unknown as AiAccessApi,
    { ...status('multi'), officialAuthentication: officialAuth('login-required') }, state, vi.fn(), vi.fn(async () => undefined), 'pending') as unknown as Element
  buttonOf(root, '取消授权')?.onclick?.()
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  expect(cancelCodexOfficialLogin).toHaveBeenCalledOnce()
  expect(buttonOf(root, '登录官方账号')).toBeUndefined()
})

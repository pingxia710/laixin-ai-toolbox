import { afterEach, expect, it, vi } from 'vitest'
import type { AiAccessApi } from '../../app/preload/api/ai-access'
import type { AiAccessShell, AiAccessStatus } from '../../app/main/ai-access/service'
import type { ApiUsageStage } from '../../app/shared/api-service-types'

const providerEditor = vi.hoisted(() => ({ open: vi.fn(() => () => undefined) }))
vi.mock('../../app/renderer/src/platform/provider-editor', () => ({ openProviderEditor: providerEditor.open }))

/**
 * API-11：登录等待/输登录码期间渲染层每 1.5 秒一轮全量 status，把电脑拖卡。
 * 轮询必须只调轻量登录态端点（codexOfficialStatus / claudeOfficialStatus），
 * 等待窗口内零次全量 status（≙ 主进程观察器零 spawn），登录出结果后全量刷一次对齐整页。
 */

type Doc = { activeElement: Element | null; createElement: (tag: string) => Element }
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document

class Element {
  tag = ''
  textContent = ''; className = ''; disabled = false; value = ''; type = ''
  dataset: Record<string, string> = {}; children: Element[] = []
  parent: Element | undefined
  onclick?: () => void
  onsubmit?: (event: { preventDefault: () => void }) => void
  private handlers: Record<string, (event?: unknown) => void> = {}
  setAttribute() {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child) } }
  prepend(...children: Element[]) { this.children.unshift(...children) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children) }
  addEventListener(event: string, handler: (event?: unknown) => void) { this.handlers[event] = handler }
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' ') },
    remove: (...names: string[]) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' ') },
    toggle: (name: string, force?: boolean) => {
      const has = this.className.split(' ').includes(name)
      const next = force === undefined ? !has : force
      if (next && !has) this.classList.add(name)
      if (!next && has) this.classList.remove(name)
      return next
    },
    contains: (name: string) => this.className.split(' ').includes(name)
  }
  focus() { doc().activeElement = this }
  querySelector(selector: string): Element | undefined { return this.querySelectorAll(selector)[0] }
  querySelectorAll(selector: string): Element[] { return this.all().filter(node => matches(node, selector)) }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())] }
}

function matches(node: Element, selector: string): boolean {
  return selector.split(',').some(part => {
    const rule = part.trim()
    if (rule.startsWith('.')) return node.className.split(' ').includes(rule.slice(1))
    if (rule.startsWith('[') && rule.endsWith(']')) {
      const attribute = rule.slice(1, -1)
      return Object.keys(node.dataset).includes(attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()))
    }
    return node.tag === rule
  })
}

const providerKeys = { deepseek: false, 'zhipu-api': false, zhipu: false, moonshot: false, kimi: false }
const statusSnapshot = (): string => JSON.stringify({
  legacyZaiKeySaved: false,
  codexMultiModel: { mode: 'single', models: [] },
  shells: {
    codex: { selected: null, officialAvailable: true, providerKeys },
    claude: { selected: null, officialAvailable: true, providerKeys },
    hermes: { selected: null, officialAvailable: true, providerKeys }
  }
})

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
let cleanup = () => undefined as void
afterEach(() => { cleanup(); providerEditor.open.mockClear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

async function setup(platform: 'codex' | 'claude-code' | 'hermes', login: { codex: string; claude: string }, overrides: Partial<AiAccessApi> = {}) {
  vi.useFakeTimers()
  vi.stubGlobal('document', { activeElement: null, createElement: (tag: string) => Object.assign(new Element(), { tag }) })
  vi.stubGlobal('window', { toolbox: {} })
  const api = {
    status: vi.fn(async () => ({ snapshot: statusSnapshot() })),
    serviceStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ usage: [], startupError: null }) })),
    aiRouterStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ running: false, modelCount: 0, error: 'not_configured', catalog: { state: 'missing' } }) })),
    codexOfficialStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ status: login.codex }) })),
    claudeOfficialStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ status: login.claude }) })),
    ...overrides
  }
  const { mountModelApi } = await import('../../app/renderer/src/platform/model-api')
  const root = new Element()
  const unmount = mountModelApi(root as unknown as HTMLElement, platform, api as unknown as AiAccessApi)
  cleanup = unmount
  await flush()
  return { api, login, root }
}

it('Codex 单模型页直接显示模式切换和 OpenAI 官方套餐', async () => {
  const x = await setup('codex', { codex: 'idle', claude: 'idle' })
  const texts = x.root.all().map(element => element.textContent)

  expect(texts).toContain('单模型切换')
  expect(texts).toContain('多模型共用')
  expect(texts).toContain('OpenAI 官方套餐')
  expect(texts).not.toContain('OpenAI 官方')
  expect(texts).not.toContain('Codex 模型模式')
})

it('Codex 多模型共用模式第一行显示可登录的 OpenAI 官方套餐，不渲染单模型服务卡', async () => {
  const base = JSON.parse(statusSnapshot()) as AiAccessStatus
  const multi: AiAccessStatus = { ...base,
    codexMultiModel: {
      mode: 'multi',
      models: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }]
    },
    shells: { ...base.shells,
      codex: { ...base.shells.codex, selected: 'zhipu-api', providerKeys: { ...providerKeys, deepseek: true, 'zhipu-api': true } }
    }
  }
  const x = await setup('codex', { codex: 'idle', claude: 'idle' }, {
    status: vi.fn(async () => ({ snapshot: JSON.stringify(multi) })),
    aiRouterStatus: vi.fn(async () => ({ snapshot: JSON.stringify({
      running: true, modelCount: 1, catalog: { state: 'written' },
      lastDesktopUse: { provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash', at: '2026-09-27T00:00:00.000Z' }
    }) }))
  })

  expect(x.root.all().some(element => element.dataset.provider !== undefined)).toBe(false)
  expect(x.root.all().some(element => element.textContent === 'OpenAI 官方套餐')).toBe(true)
  expect(x.root.all().some(element => element.textContent === '登录官方账号')).toBe(true)
  expect(x.root.all().some(element => element.textContent === '新建来信多模型对话')).toBe(true)
  expect(x.root.all().some(element => element.textContent === '启用' || element.textContent === '当前配置')).toBe(false)
})

it('Codex 登录等待期轮询只走登录态端点：窗口内零次全量 status，出结果后全量刷一次对齐', async () => {
  const x = await setup('codex', { codex: 'pending', claude: 'idle' })
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.codexOfficialStatus).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(1500)
  await vi.advanceTimersByTimeAsync(1500)
  await vi.advanceTimersByTimeAsync(1500)
  // 等待窗口内：只问登录态，全量 status（及其后的观察器 spawn、用量读取）一次都不发生。
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.serviceStatus).toHaveBeenCalledTimes(1)
  expect(x.api.codexOfficialStatus).toHaveBeenCalledTimes(4)

  x.login.codex = 'connected'
  await vi.advanceTimersByTimeAsync(1500)
  // 登录有了结果：恰好一次全量刷新把配置目标、用量与页面一起对齐（终刷自身再读一次登录态），然后轮询停止。
  expect(x.api.status).toHaveBeenCalledTimes(2)
  expect(x.api.serviceStatus).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(4500)
  expect(x.api.codexOfficialStatus).toHaveBeenCalledTimes(6)
  expect(x.api.status).toHaveBeenCalledTimes(2)
})

it('Claude 登录码等待期同样只轮询登录态；输码阶段不退轮询，登录完成即对齐', async () => {
  const x = await setup('claude-code', { codex: 'idle', claude: 'pending' })
  expect(x.api.status).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(3000)
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.claudeOfficialStatus).toHaveBeenCalledTimes(1 + 2)

  x.login.claude = 'code-required'
  await vi.advanceTimersByTimeAsync(1500)
  // pending → code-required 仍是等待：轮询继续，且不触发全量 status。
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.claudeOfficialStatus).toHaveBeenCalledTimes(4)

  x.login.claude = 'connected'
  await vi.advanceTimersByTimeAsync(1500)
  expect(x.api.status).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3000)
  expect(x.api.claudeOfficialStatus).toHaveBeenCalledTimes(6)
  expect(x.api.status).toHaveBeenCalledTimes(2)
})

async function setupUsage(shell: AiAccessShell = 'codex') {
  let status = JSON.parse(statusSnapshot()) as AiAccessStatus
  status = { ...status, shells: { ...status.shells, [shell]: { ...status.shells[shell], selected: 'deepseek', providerKeys: { ...providerKeys, deepseek: true } } } }
  const at = '2026-09-26T00:00:00.000Z'
  let usage: ApiUsageStage = {
    shell, provider: 'deepseek', tested: at, configured: at, observedClientCall: at, configuration: 'ok',
    ...(shell === 'codex' ? { codexDesktopRoute: { status: 'verified', at, reason: 'verified_socket_bound_desktop' } as const } : {})
  }
  const replaceRoute = () => {
    usage = { ...usage, observedClientCall: null,
      ...(shell === 'codex' ? { codexDesktopRoute: { status: 'unverified', at: null, reason: 'awaiting_desktop_request' } as const } : {}) }
    return { snapshot: JSON.stringify(status) }
  }
  const serviceStatus = vi.fn(async () => ({ snapshot: JSON.stringify({ usage: [usage], startupError: null }) }))
  const useProviderWithKey = vi.fn(async () => replaceRoute())
  const configureProvider = vi.fn(async () => replaceRoute())
  const x = await setup(shell === 'claude' ? 'claude-code' : shell, { codex: 'idle', claude: 'idle' }, {
    status: vi.fn(async () => ({ snapshot: JSON.stringify(status) })), serviceStatus, useProviderWithKey, configureProvider,
    startCodexOfficialLogin: vi.fn(async () => ({ snapshot: JSON.stringify({ status: 'connected' }) })),
    useOfficial: vi.fn(async () => {
      status = { ...status, shells: { ...status.shells, [shell]: { ...status.shells[shell], selected: 'official' } } }
      usage = { ...usage, provider: null }
      return replaceRoute()
    }),
    useProvider: vi.fn(async () => {
      status = { ...status, shells: { ...status.shells, [shell]: { ...status.shells[shell], selected: 'deepseek' } } }
      usage = { ...usage, provider: 'deepseek' }
      return replaceRoute()
    })
  })
  const row = (provider: string) => x.root.all().find(element => element.dataset.provider === provider)!
  const stages = () => x.root.querySelectorAll('.usage-stage').map(element => element.dataset.state)
  const saveKey = async () => {
    row('deepseek').all().find(element => element.textContent === '更换API key')!.onclick!()
    const form = row('deepseek').querySelector('.model-key-form')!
    form.querySelector('input')!.value = 'fixture-only-new-key-0001'
    form.onsubmit!({ preventDefault() {} })
    await flush()
  }
  return { ...x, row, stages, saveKey, status, usage, serviceStatus, useProviderWithKey, configureProvider }
}

it.each(['codex', 'claude', 'hermes'] as const)('%s 更换 Key 后立即显示新配置证据，不沿用旧调用成功', async shell => {
  const x = await setupUsage(shell)
  expect(x.stages()).toEqual(shell === 'codex' ? ['done', 'done', 'done', 'done'] : ['done', 'done', 'done'])
  await x.saveKey()
  expect(x.useProviderWithKey).toHaveBeenCalledWith({ shell, provider: 'deepseek', key: 'fixture-only-new-key-0001' })
  expect(x.stages()).toEqual(shell === 'codex' ? ['done', 'done', 'waiting', 'waiting'] : ['done', 'done', 'waiting'])
  expect(x.serviceStatus).toHaveBeenCalledTimes(2)
  expect(x.api.status).toHaveBeenCalledTimes(1)
})

it('候选 Key 失败保留旧配置时，保留后端返回的有效旧证据', async () => {
  const x = await setupUsage()
  const rejected: AiAccessStatus = {
    ...x.status, attempt: { shell: 'codex', provider: 'deepseek', ok: false, code: 'key_rejected', at: '2026-09-26T00:01:00.000Z' }
  }
  x.useProviderWithKey.mockImplementationOnce(async () => ({ snapshot: JSON.stringify(rejected) }))
  await x.saveKey()
  expect(x.stages()).toEqual(['done', 'done', 'done', 'done'])
  expect(x.serviceStatus).toHaveBeenCalledTimes(2)
  expect(x.root.all().some(element => element.textContent.includes('尚未完成接入。Key 未通过认证'))).toBe(true)
  expect(x.root.all().some(element => element.textContent.startsWith('切换未完成'))).toBe(false)
})

it('换 Key 成功但服务快照读取失败时，不把旧成功证据留在页面', async () => {
  const x = await setupUsage()
  x.serviceStatus.mockRejectedValueOnce(new Error('fixture snapshot unavailable'))
  await x.saveKey()
  expect(x.stages()).toEqual([])
  expect(x.root.all().some(element => element.textContent.includes('Key 已验证并更新'))).toBe(true)
})

it('切到官方再切回原服务商时，不复活此前已失效的调用证据', async () => {
  const x = await setupUsage()
  x.row('official').querySelector('.api-enable')!.onclick!()
  await flush()
  expect(x.stages()).toEqual([])
  x.row('deepseek').querySelector('.api-enable')!.onclick!()
  await flush()
  expect(x.stages()).toEqual(['done', 'done', 'waiting', 'waiting'])
  expect(x.serviceStatus).toHaveBeenCalledTimes(3)
  expect(x.api.status).toHaveBeenCalledTimes(1)
})

it('编辑器只改模型后同样重新读取当前配置证据', async () => {
  const x = await setupUsage()
  x.row('deepseek').querySelector('.api-edit')!.onclick!()
  const save = (providerEditor.open.mock.calls[0] as unknown as unknown[])[4] as (key: string, model: string) => Promise<{ ok: boolean }>
  expect(await save('', 'fixture-alternate-model')).toMatchObject({ ok: true })
  expect(x.configureProvider).toHaveBeenCalledWith({ shell: 'codex', provider: 'deepseek', key: '', model: 'fixture-alternate-model' })
  expect(x.stages()).toEqual(['done', 'done', 'waiting', 'waiting'])
  expect(x.serviceStatus).toHaveBeenCalledTimes(2)
})

it.each(['key', 'model'] as const)('%s 动作前已在途的全量刷新晚到时，不能把旧证据覆盖回来', async mode => {
  const x = await setupUsage()
  let finishLoginRead!: (value: { snapshot: string }) => void
  vi.mocked(x.api.codexOfficialStatus).mockImplementationOnce(() => new Promise(resolve => { finishLoginRead = resolve }))
  x.root.all().find(element => element.textContent === '登录官方账号')!.onclick!()
  await flush()
  expect(x.serviceStatus).toHaveBeenCalledTimes(2)
  if (mode === 'key') await x.saveKey()
  else {
    x.row('deepseek').querySelector('.api-edit')!.onclick!()
    const save = (providerEditor.open.mock.calls[0] as unknown as unknown[])[4] as (key: string, model: string) => Promise<{ ok: boolean }>
    await save('', 'fixture-alternate-model')
  }
  expect(x.stages()).toEqual(['done', 'done', 'waiting', 'waiting'])
  finishLoginRead({ snapshot: JSON.stringify({ status: 'connected' }) })
  await flush()
  expect(x.stages()).toEqual(['done', 'done', 'waiting', 'waiting'])
})

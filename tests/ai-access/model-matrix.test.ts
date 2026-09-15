import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessExtras, type AiAccessState } from '../../app/main/ai-access/service'
import { ModelMatrixStore, sanitizeMatrixReport } from '../../app/main/ai-access/model-matrix-store'
import { matrixLine, suggestDefaultModels, type ModelMatrixReport } from '../../app/shared/model-matrix-types'
import { isProviderShellSupported } from '../../app/shared/model-providers'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

function frames(shell: string): string {
  const body = shell === 'codex' ? [{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } }]
    : shell === 'claude' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }, { type: 'message_stop' }]
      : [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]
  return body.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
}
function toolCall(shell: string): unknown {
  return shell === 'codex' ? { status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] }
    : shell === 'claude' ? { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'probe-1', name: 'toolbox_probe', input: {} }] }
      : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'toolbox_probe', arguments: '{}' } }] } }] }
}

/** 桩上游按模型名决定结果：有的通过、有的被拒、有的卡住。 */
function fixture(initial: AiAccessState, behaviour: (model: string) => 'ok' | 'rejected' | 'hang' = () => 'ok', extras: AiAccessExtras = {}) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = String(url)
    const shell = endpoint.endsWith('/responses') ? 'codex' : endpoint.endsWith('/messages') ? 'claude' : 'hermes'
    const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean }
    const verdict = behaviour(body.model)
    if (verdict === 'rejected') return new Response('{"error":{"type":"authentication_error"}}', { status: 401 })
    if (verdict === 'hang') return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) })
    return body.stream === true ? new Response(frames(shell), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(toolCall(shell))
  })
  const adapters: AiAccessAdapter[] = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn(async () => undefined), captureConnection: vi.fn(async () => vi.fn(async () => undefined)) }))
  let state = initial
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters, new AiGateway({ fetch: fetcher, timeoutMs: 60 }), extras)
  services.push(service)
  return { service, fetcher, state: () => state }
}

const key = 'sk-fixture-matrix-0123456789'
const everywhere: AiAccessState = { version: 1, selected: {},
  shellKeys: { codex: { deepseek: key }, claude: { deepseek: key }, hermes: { deepseek: key } } }

describe('真 Key 验证矩阵', () => {
  it('按模型名逐格给出通过 / 失败判类，结果里没有 Key', async () => {
    const f = fixture(everywhere, (model) => model === 'deepseek-v4-pro' ? 'rejected' : 'ok')
    const report = await f.service.probeMatrix()
    const deepseek = report.entries.filter(entry => entry.provider === 'deepseek')
    expect(deepseek.filter(entry => entry.model === 'deepseek-v4-pro').every(entry => entry.state === 'failed' && entry.code === 'key_rejected')).toBe(true)
    expect(deepseek.filter(entry => entry.model === 'deepseek-flash').every(entry => entry.state === 'passed')).toBe(true)
    expect(deepseek.filter(entry => entry.state === 'passed').every(entry => typeof entry.firstTextMs === 'number')).toBe(true)
    expect(JSON.stringify(report)).not.toContain(key)
    expect(matrixLine(deepseek[0])).not.toContain(key)
  })

  it('没存 Key 的来源标「跳过」而不是「失败」，也不去打上游', async () => {
    const f = fixture({ version: 1, selected: {}, shellKeys: { codex: { deepseek: key } } })
    const report = await f.service.probeMatrix()
    const zhipu = report.entries.filter(entry => entry.provider === 'zhipu')
    // 智谱两种 Key 产品均已覆盖三壳；没存 Key 时每格都必须明确跳过，而不是悄悄丢掉 Codex。
    expect(zhipu).toHaveLength(aiAccessShells.length)
    expect(zhipu.every(entry =>
      isProviderShellSupported('zhipu', entry.shell) && entry.model === 'glm-5.3-flash' &&
      entry.state === 'skipped' && entry.skipped === 'key_missing')).toBe(true)
    const zhipuApi = report.entries.filter(entry => entry.provider === 'zhipu-api')
    expect(zhipuApi).toHaveLength(aiAccessShells.length)
    expect(zhipuApi.every(entry =>
      isProviderShellSupported('zhipu-api', entry.shell) && entry.model === 'glm-5.3-flash' &&
      entry.state === 'skipped' && entry.skipped === 'key_missing')).toBe(true)
    expect(f.fetcher.mock.calls.every(call => String(call[0]).includes('deepseek'))).toBe(true)
  })

  it('软件没装、版本被闸门拦住都算跳过，各有各的原因', async () => {
    const f = fixture(everywhere, () => 'ok', {
      shellInstalled: async (shell) => shell !== 'hermes',
      gate: async (shell) => shell === 'claude' ? '请安装 2.1.153 以上版本' : undefined
    })
    const report = await f.service.probeMatrix()
    const deepseek = report.entries.filter(entry => entry.provider === 'deepseek')
    expect(deepseek.filter(entry => entry.shell === 'hermes').every(entry => entry.skipped === 'shell_missing')).toBe(true)
    expect(deepseek.filter(entry => entry.shell === 'claude').every(entry => entry.skipped === 'version_gate')).toBe(true)
    expect(deepseek.some(entry => entry.shell === 'codex' && entry.state === 'passed')).toBe(true)
    // 没存 Key 的组合先被「跳过：没存 Key」拦下，⛔ 为了判断装没装去起命令行。
    for (const provider of ['zhipu-api', 'zhipu'] as const) {
      const entries = report.entries.filter(entry => entry.provider === provider)
      expect(entries).toHaveLength(aiAccessShells.length)
      expect(entries.every(entry => isProviderShellSupported(provider, entry.shell) && entry.skipped === 'key_missing')).toBe(true)
    }
  })

  it('一个模型卡住只让那一格超时，整张表照跑完', async () => {
    const f = fixture(everywhere, (model) => model === 'deepseek-v4-pro' ? 'hang' : 'ok')
    const report = await f.service.probeMatrix()
    const stuck = report.entries.filter(entry => entry.model === 'deepseek-v4-pro')
    expect(stuck.length).toBeGreaterThan(0)
    expect(stuck.every(entry => entry.state === 'failed')).toBe(true)
    expect(report.entries.filter(entry => entry.state === 'passed').length).toBeGreaterThan(0)
    expect(report.entries.filter(entry => entry.provider === 'kimi').length).toBeGreaterThan(0)
  })

  it('进度边跑边报，跑完 done 等于 total', async () => {
    const f = fixture(everywhere)
    const seen: { done: number; total: number; current?: string }[] = []
    const report = await f.service.probeMatrix(progress => {
      seen.push({ done: progress.done, total: progress.total, current: progress.current ? progress.current.model : undefined })
    })
    expect(seen[0]).toMatchObject({ done: 0 })
    expect(seen.at(-1)).toMatchObject({ done: report.entries.length, total: report.entries.length })
    expect(seen.some(item => item.current !== undefined)).toBe(true)
    expect(f.service.matrixStatus()).toMatchObject({ done: report.entries.length })
  })

  it('矩阵只读：⛔ 写壳配置、⛔ 改客户已选模型、⛔ 建本机路由', async () => {
    const before: AiAccessState = { ...everywhere, shellModels: { codex: { deepseek: 'deepseek-v4-pro' } } }
    const f = fixture(before)
    await f.service.probeMatrix()
    expect(f.state()).toEqual(before)
    expect((await f.service.serviceStatus()).routes).toEqual([])
  })

  it('异步留档尚未完成时不返回矩阵结果', async () => {
    let releaseArchive: () => void = () => undefined
    const archiveFinished = new Promise<void>(resolve => { releaseArchive = resolve })
    let archiveStarted: () => void = () => undefined
    const archiveStartedPromise = new Promise<void>(resolve => { archiveStarted = resolve })
    const f = fixture(everywhere, () => 'ok', { saveMatrix: () => {
      archiveStarted()
      return archiveFinished
    } })
    let returned = false
    const pending = f.service.probeMatrix().then(report => { returned = true; return report })

    await archiveStartedPromise
    await Promise.resolve()
    expect(returned).toBe(false)
    releaseArchive()
    await expect(pending).resolves.toMatchObject({ entries: expect.any(Array) })
  })
})

describe('标准默认模型的建议', () => {
  const entry = (shell: 'codex' | 'claude' | 'hermes', model: string, state: 'passed' | 'failed' | 'skipped', firstTextMs?: number) =>
    ({ provider: 'deepseek' as const, shell, model, state, at: '2026-09-12T09:00:00.000Z', ...(firstTextMs === undefined ? {} : { firstTextMs }) })

  it('取「测过的软件都通过、最慢那个也最快」的模型', () => {
    const report: ModelMatrixReport = { at: '2026-09-12T09:00:00.000Z', entries: [
      entry('codex', 'fast', 'passed', 300), entry('claude', 'fast', 'passed', 900), entry('hermes', 'fast', 'passed', 320),
      entry('codex', 'even', 'passed', 500), entry('claude', 'even', 'passed', 520), entry('hermes', 'even', 'passed', 510)
    ] }
    // fast 平均更快，但它最慢的那个壳要 900 ms；even 最慢也只要 520 ms。
    expect(suggestDefaultModels(report)).toEqual({ deepseek: 'even' })
  })

  it('有一个软件没通过就不建议这个模型；没装的软件不算数', () => {
    const broken: ModelMatrixReport = { at: '2026-09-12T09:00:00.000Z', entries: [
      entry('codex', 'partial', 'passed', 200), entry('claude', 'partial', 'failed'), entry('hermes', 'partial', 'passed', 200)
    ] }
    expect(suggestDefaultModels(broken)).toEqual({})

    const hermesMissing: ModelMatrixReport = { at: '2026-09-12T09:00:00.000Z', entries: [
      entry('codex', 'two-shells', 'passed', 200), entry('claude', 'two-shells', 'passed', 210), entry('hermes', 'two-shells', 'skipped')
    ] }
    expect(suggestDefaultModels(hermesMissing)).toEqual({ deepseek: 'two-shells' })

    expect(suggestDefaultModels({ at: '2026-09-12T09:00:00.000Z', entries: [entry('codex', 'none', 'skipped')] })).toEqual({})
  })
})

describe('矩阵留档', () => {
  it('读写都按清单过一遍，塞进来的 Key 与来路不明的字段都进不去', async () => {
    let saved: string | undefined
    const store = new ModelMatrixStore({ read: async () => saved, write: async (contents) => { saved = contents } })
    await store.save({ at: '2026-09-12T09:00:00.000Z', entries: [
      { provider: 'deepseek', shell: 'codex', model: 'deepseek-v4-flash', state: 'passed', firstTextMs: 300, at: '2026-09-12T09:00:00.000Z',
        key: 'sk-fixture-matrix-0123456789', prompt: '对话正文' } as never
    ] })
    expect(saved).not.toContain('sk-fixture-matrix')
    expect(saved).not.toContain('对话正文')
    expect((await store.read())?.entries[0]).toEqual({ provider: 'deepseek', shell: 'codex', model: 'deepseek-v4-flash', state: 'passed', firstTextMs: 300, at: '2026-09-12T09:00:00.000Z' })
    expect(sanitizeMatrixReport({ at: 'not-a-time', entries: [] })).toBeUndefined()
    expect(sanitizeMatrixReport({ at: '2026-09-12T09:00:00.000Z', entries: [{ provider: 'evil', shell: 'codex', model: 'x', state: 'passed', at: '2026-09-12T09:00:00.000Z' }] })?.entries).toEqual([])
  })

  it('留档只接受当前产品与壳的模型白名单，路径或 Key 形态不能进入客服摘要', () => {
    const at = '2026-09-12T09:00:00.000Z'
    const raw = { at, entries: [
      { provider: 'kimi', shell: 'claude', model: 'k3[1m]', state: 'passed', at },
      { provider: 'deepseek', shell: 'codex', model: '/private/customer/config.toml', state: 'passed', at },
      { provider: 'deepseek', shell: 'codex', model: 'sk-fixture-matrix-0123456789', state: 'passed', at },
      { provider: 'deepseek', shell: 'codex', model: 'deepseek-v3', state: 'passed', at },
      { provider: 'moonshot', shell: 'claude', model: 'k3[1m]', state: 'passed', at }
    ] }
    const safe = sanitizeMatrixReport(raw)

    expect(safe?.entries).toEqual([{ provider: 'kimi', shell: 'claude', model: 'k3[1m]', state: 'passed', at }])
    expect(JSON.stringify(safe)).not.toContain('/private/customer')
    expect(JSON.stringify(safe)).not.toContain('sk-fixture-matrix')
  })

  it('读取已被篡改的落盘报告时同样过滤非法模型', async () => {
    const at = '2026-09-12T09:00:00.000Z'
    const store = new ModelMatrixStore({
      read: async () => JSON.stringify({ at, entries: [
        { provider: 'deepseek', shell: 'codex', model: '/customer/private/key', state: 'passed', at },
        { provider: 'kimi', shell: 'claude', model: 'k3[1m]', state: 'passed', at }
      ] }),
      write: async () => undefined
    })

    await expect(store.read()).resolves.toEqual({
      at,
      entries: [{ provider: 'kimi', shell: 'claude', model: 'k3[1m]', state: 'passed', at }]
    })
  })

  it('留档写入失败时不给出完成结果，也不透传本机异常原文', async () => {
    const store = new ModelMatrixStore({ read: async () => undefined, write: async () => {
      throw new Error('/private/customer/matrix-output.json fixture-secret-key-1234567890')
    } })
    const f = fixture(everywhere, () => 'ok', { saveMatrix: report => store.save(report) })

    await expect(f.service.probeMatrix()).rejects.toThrow('AI_ACCESS_MATRIX_SAVE_FAILED')
  })
})

describe('配方换了标准默认模型', () => {
  it('只影响没自己选过的壳；客户显式选过的 ⛔ 被覆盖', async () => {
    const state: AiAccessState = { version: 1, selected: {},
      shellKeys: { codex: { deepseek: key }, claude: { deepseek: key } },
      shellModels: { codex: { deepseek: 'deepseek-v4-pro' } } }
    // 配方保留旧 alias；路由层会归一到当前正式 V4 ID。
    const f = fixture(state, () => 'ok', { resolveRoute: () => ({ endpoint: 'https://api.deepseek.com/responses', model: 'deepseek-flash' }) })
    expect((await f.service.providerConfiguration('codex', 'deepseek')).model).toBe('deepseek-v4-pro')
    expect((await f.service.providerConfiguration('claude', 'deepseek')).model).toBe('deepseek-flash')
    await f.service.testProvider('codex', 'deepseek')
    expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe('deepseek-v4-pro')
  })
})

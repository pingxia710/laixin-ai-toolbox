/**
 * 「接入恢复」与「运行中故障」的真实形态回归（0.4.10 包二）。
 * 用真实磁盘配置文件、真实本机 HTTP 网关与上游、真实端口占用者、真实文件权限来造，
 * ⛔ 用内存假文件或假 fetch——那几套桩正是 0.4.9 这几条缺陷没被测出来的原因。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createManagedTextFile } from '../../app/main/ai-access/file'
import { createDeepSeekAdapters } from '../../app/main/ai-access/adapters'
import { hermesManagedSection, managedFingerprint } from '../../app/main/ai-access/deepseek-config'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { AiAccessService, type AiAccessProvider, type AiAccessShell, type AiAccessState } from '../../app/main/ai-access/service'
import { modelProviders } from '../../app/shared/model-providers'
import type { FaultInput } from '../../app/main/diagnostics/fault-log'

const KEY = 'fixture-only-not-a-real-key-0123456789'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => undefined) })

/** 真实本机上游（按请求体识别 Codex/Claude 协议）：可切 401，user-agent 含 hold-me 的请求挂起到 release()。 */
async function startUpstream() {
  const held: { res: ServerResponse; body: string }[] = []
  const state = { mode: 'ok' as 'ok' | '401' }
  const reply = (res: ServerResponse, body: string): void => {
    if (state.mode === '401') {
      res.statusCode = 401; res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { message: 'fixture invalid api key' } })); return
    }
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(body) as Record<string, unknown> } catch { /* 空体按非流式处理 */ }
    const claude = Array.isArray(json.messages)
    if (json.stream === true) {
      res.setHeader('content-type', 'text/event-stream')
      const frames = claude
        ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }, { type: 'message_stop' }]
        : [{ type: 'response.output_text.delta', delta: 'OK' },
          { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }]
      res.end(frames
        .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(claude
      ? { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'probe-1', name: 'toolbox_probe', input: {} }] }
      : { status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] }))
  }
  const server: Server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      if (String(req.headers['user-agent']).includes('hold-me')) { held.push({ res, body }); return }
      reply(res, body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { url: `http://127.0.0.1:${String(port)}`, state, held, release: () => { for (const item of held.splice(0)) reply(item.res, item.body) } }
}

/** 真实家目录 + 真实文件适配器 + 真实网关 + 真实上游。 */
async function realSetup(timeoutMs = 5_000) {
  const home = await mkdtemp(join(tmpdir(), 'laixin-0410-p2-'))
  cleanups.push(async () => {
    await chmod(join(home, '.codex', 'config.toml'), 0o600).catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const upstream = await startUpstream()
  const hermes = new Map<string, string>()
  const adapters = createDeepSeekAdapters({
    home, platform: 'darwin', file: createManagedTextFile(), findHermesCommand: async () => 'hermes',
    runHermes: async (_command, args) => {
      if (args[0] === 'config' && args[1] === 'set') hermes.set(args[2], args[3])
      // 真实 hermes ≥0.21 语义：unset 本就未设置的键以非零退出（"Config key not set"）。
      if (args[0] === 'config' && args[1] === 'unset') {
        if (!hermes.has(args[2])) throw new Error(`Config key not set: ${args[2]}`)
        hermes.delete(args[2])
      }
    },
    readHermesConfig: async (_command, key) => hermes.get(key)
  })
  let state: AiAccessState = { version: 1, selected: {} }
  let rejectWrites = false
  const store = { read: async () => state, write: async (next: AiAccessState) => {
    if (rejectWrites) throw new Error('fixture state write failed')
    state = next
  } }
  const faults: FaultInput[] = []
  const gateway = new AiGateway({ timeoutMs })
  const extras = {
    recordFault: (fault: FaultInput) => { faults.push(fault) },
    resolveRoute: (shell: AiAccessShell, provider: AiAccessProvider) => ({ endpoint: `${upstream.url}/responses`, model: modelProviders[provider].models[shell] })
  }
  const service = new AiAccessService(store, adapters, gateway, extras)
  cleanups.push(() => service.stop())
  return { home, upstream, adapters, store, extras, faults, gateway, service, state: () => state,
    rejectWrites: () => { rejectWrites = true }, configPath: join(home, '.codex', 'config.toml') }
}

type Fixture = Awaited<ReturnType<typeof realSetup>>

async function connectCodex(f: Fixture): Promise<void> {
  const status = await f.service.configureProvider('codex', 'deepseek', KEY, 'deepseek-v4-pro')
  if (status.attempt?.ok !== true) throw new Error(`fixture connect failed: ${JSON.stringify(status.attempt)}`)
}

async function connectClaude(f: Fixture): Promise<void> {
  const status = await f.service.configureProvider('claude', 'deepseek', KEY, 'deepseek-v4-pro')
  if (status.attempt?.ok !== true) throw new Error(`fixture connect failed: ${JSON.stringify(status.attempt)}`)
}

/** 真实端口占用者：一个与工具箱无关的普通 TCP 监听。 */
async function occupyForeign(port: number): Promise<void> {
  const blocker = createNetServer(socket => socket.end())
  await new Promise<void>((resolve, reject) => { blocker.once('error', reject); blocker.listen(port, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>(resolve => { blocker.close(() => resolve()) }))
}

function post(url: string, token: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('端口被占后自动换端口：⛔ 顺手盖掉客户自己的改动', () => {
  it('Hermes 受信 venv 启动器被换成软链时，端口重绑不执行它并暂停路由', async () => {
    const home = await mkdtemp(join(tmpdir(), 'laixin-hermes-rebind-link-'))
    const hermesHome = join(home, '.hermes')
    const launcher = join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes')
    const wrapper = join(home, 'unknown-wrapper')
    const marker = join(home, 'wrapper-ran')
    const token = 'e'.repeat(64)
    const gateway = new AiGateway()
    cleanups.push(async () => { await gateway.stop(); await rm(home, { recursive: true, force: true }) })
    const oldPort = await gateway.start(0, token)
    await gateway.stop()
    await occupyForeign(oldPort)
    await mkdir(dirname(launcher), { recursive: true })
    await writeFile(wrapper, `#!/bin/sh\ntouch ${marker}\necho wrapper\n`)
    await chmod(wrapper, 0o755)
    await symlink(wrapper, launcher)
    const settings = {
      'model.provider': 'custom', 'model.default': 'deepseek-v4-flash',
      'model.base_url': `http://127.0.0.1:${String(oldPort)}/hermes/deepseek/v1`, 'model.api_key': token,
      'model.api_mode': 'chat_completions', 'model.context_length': '1048576'
    }
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:', '  provider: custom', '  default: deepseek-v4-flash',
      `  base_url: "${settings['model.base_url']}"`, `  api_key: "${token}"`,
      '  api_mode: chat_completions', '  context_length: 1048576'
    ].join('\n'))
    const fingerprint = managedFingerprint(hermesManagedSection(settings))!
    let state: AiAccessState = {
      version: 1, selected: { hermes: 'deepseek' }, shellKeys: { hermes: { deepseek: KEY } },
      relay: { port: oldPort, token }, relayShells: ['hermes'], shellFingerprints: { hermes: fingerprint }
    }
    const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
    const service = new AiAccessService(store, createDeepSeekAdapters({ home, hermesHome, platform: 'darwin', file: createManagedTextFile() }), gateway)
    cleanups.push(() => service.stop())

    const result = await service.recoverAccess('periodic')

    expect(result).toMatchObject({ outcome: 'still_failing', code: 'configuration_interrupted' })
    await expect(access(marker)).rejects.toThrow()
    expect((await service.serviceStatus()).routes).toEqual([])
    expect(state.pendingShells).toContain('hermes')
  })

  it('托管块被外部改过：这个壳不回写、保持暂停并报仍有问题，块内块外的改动一并保留', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const original = await readFile(f.configPath, 'utf8')
    // 两处外部改动：托管块内（推理强度 high → low）与块外客户自己的顶层键、表。
    await writeFile(f.configPath, `notify = ["laixin-user-own"]\n${original.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"')}\n[projects."/Users/laixin"]\ntrust_level = "trusted"\n`)
    expect((await f.service.verifyConfigurations()).codex).toBe('modified-externally')
    const oldPort = f.state().relay!.port
    await f.gateway.stop()
    await occupyForeign(oldPort)

    const result = await f.service.recoverAccess('periodic')
    const after = await readFile(f.configPath, 'utf8')
    expect(result.outcome).toBe('still_failing')
    expect(result.message).toContain('重新写入配置')
    expect(after).toContain('model_reasoning_effort = "low"')
    expect(after).toContain('notify = ["laixin-user-own"]')
    expect(after).toContain('[projects."/Users/laixin"]')
    expect(result.rewroteShells).toBeUndefined()
    // 没回写的壳留在暂停态，路由不上线——⛔ 一边说「已恢复」一边让客户端撞 409。
    expect(f.state().pendingShells).toEqual(['codex'])
    expect((await f.service.serviceStatus()).routes).toEqual([])
  })

  it('配置没被动过：照常换端口回写，并且换掉本机中继令牌', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const before = { port: f.state().relay!.port, token: f.state().relay!.token }
    await f.gateway.stop()
    await occupyForeign(before.port)

    const result = await f.service.recoverAccess('periodic')
    const after = await readFile(f.configPath, 'utf8')
    expect(result).toMatchObject({ outcome: 'repaired', rewroteShells: ['codex'] })
    expect(after).toContain(`127.0.0.1:${String(f.state().relay!.port)}/codex/deepseek/v1`)
    expect(after).not.toContain(`127.0.0.1:${String(before.port)}/`)
    // 旧端口现在归别的程序，旧令牌必须作废：否则拿到它的程序能直接打新端口。
    expect(f.state().relay!.token).not.toBe(before.token)
    expect(after).toContain(f.state().relay!.token)
    const rejected = await post(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, before.token, '{}')
    expect(rejected.status).toBe(401)
    const accepted = await post(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, f.state().relay!.token, JSON.stringify({ input: [] }))
    expect(accepted.status).toBe(200)
  })

  it('端口被占时点「重启本机 API 服务」直接换端口自愈，⛔ 让客户点一个永远不会成功的按钮（第 4 轮）', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const before = { port: f.state().relay!.port, token: f.state().relay!.token }
    await f.gateway.stop()
    await occupyForeign(before.port)

    const result = await f.service.remedy('codex', 'restartGateway')

    // 自验纪律：断言服务真的起来了（端口变了也算成功），⛔ 只断言「返回了某个错误码」。
    expect(result).toMatchObject({ action: 'restartGateway', outcome: 'recovered' })
    const newPort = Number(new URL(f.gateway.baseUrl!).port)
    expect(newPort).not.toBe(before.port)
    const live = await post(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, f.state().relay!.token, JSON.stringify({ input: [] }))
    expect(live.status).toBe(200)
    // 各壳配置也回写到新地址，⛔ 让三壳继续把请求发给占用者；旧令牌一并作废。
    const after = await readFile(f.configPath, 'utf8')
    expect(after).toContain(`127.0.0.1:${newPort}/codex/deepseek/v1`)
    expect(f.state().relay!.token).not.toBe(before.token)
  })

  it.each([
    ['历史直连 Codex 不在 relayShells', ['claude'], undefined, 'legacyDirect'],
    ['中断的 Codex 仍留在 relayShells', ['codex', 'claude'], ['codex'], 'interrupted']
  ] as const)('%s 时，已支持的 Coding Plan Codex 不阻断 DeepSeek Claude 换端口恢复', async (_label, relayShells, pendingShells, stateKind) => {
    const f = await realSetup()
    await connectClaude(f)
    const oldPort = f.state().relay!.port
    await f.store.write({
      ...f.state(),
      selected: { ...f.state().selected, codex: 'zhipu' },
      shellKeys: { ...f.state().shellKeys, codex: { zhipu: 'sk-fixture-paused-codex-zhipu-0123456789' } },
      relayShells: [...relayShells],
      ...(pendingShells === undefined ? {} : { pendingShells: [...pendingShells] })
    })
    await f.gateway.stop()
    await occupyForeign(oldPort)

    // Claude is a live route; Codex is either a retained direct record or an explicitly interrupted write.
    expect(await f.service.serviceStatus()).toMatchObject({ startupError: 'local_service_down' })
    const result = await f.service.recoverAccess('periodic')

    expect(result).toMatchObject({ outcome: 'repaired', rewroteShells: ['claude'] })
    expect(result.code).toBeUndefined()
    const codex = (await f.service.status()).shells.codex
    expect(codex.selected).toBeNull()
    if (stateKind === 'legacyDirect') {
      expect(codex.legacyDirect).toEqual({ provider: 'zhipu', reason: 'not-managed-by-current-gateway' })
      expect(codex.interrupted).toBeUndefined()
    } else {
      expect(codex.interrupted).toEqual({ provider: 'zhipu', reason: 'configuration-interrupted' })
      expect(codex.legacyDirect).toBeUndefined()
    }
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'claude', provider: 'deepseek' }])
    expect((await f.service.serviceStatus()).routes.find(route => route.shell === 'codex')).toBeUndefined()
    expect((await f.service.serviceStatus()).startupError).toBeUndefined()
    await expect(access(join(f.home, '.codex', 'config.toml'))).rejects.toThrow()
    expect(await readFile(join(f.home, '.claude', 'settings.json'), 'utf8')).toContain(`/claude/deepseek`)
  })

  it('pending 的 DeepSeek Codex 与活跃 Claude 同时存在时，端口重绑只回写 Claude', async () => {
    const f = await realSetup()
    await connectClaude(f)
    const codexPath = join(f.home, '.codex', 'config.toml')
    const customerCodex = 'model = "customer-direct-model"\nmodel_provider = "customer-direct"\n'
    await mkdir(dirname(codexPath), { recursive: true })
    await writeFile(codexPath, customerCodex)
    const oldPort = f.state().relay!.port
    await f.store.write({
      ...f.state(),
      selected: { ...f.state().selected, codex: 'deepseek' },
      shellKeys: { ...f.state().shellKeys, codex: { deepseek: 'sk-fixture-paused-codex-deepseek-0123456789' } },
      relayShells: ['codex', 'claude'],
      pendingShells: ['codex']
    })
    await f.gateway.stop()
    await occupyForeign(oldPort)

    const result = await f.service.recoverAccess('periodic')

    expect(result).toMatchObject({ outcome: 'repaired', rewroteShells: ['claude'] })
    expect(await readFile(codexPath, 'utf8')).toBe(customerCodex)
    expect(f.state().pendingShells).toEqual(['codex'])
    expect((await f.service.status()).shells.codex).toMatchObject({
      selected: null,
      interrupted: { provider: 'deepseek', reason: 'configuration-interrupted' }
    })
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'claude', provider: 'deepseek' }])
    expect((await f.service.serviceStatus()).routes.find(route => route.shell === 'codex')).toBeUndefined()
    // Codex remains a row-level interruption; the healthy Claude route must not inherit it.
    expect((await f.service.serviceStatus()).startupError).toBeUndefined()
    expect(await readFile(join(f.home, '.claude', 'settings.json'), 'utf8')).toContain(`/claude/deepseek`)
  })

  it('换端口的暂停状态写不进存储：新监听立即停掉，⛔ 留下未持久化的活动路由', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const oldPort = f.state().relay!.port
    await f.gateway.stop()
    await occupyForeign(oldPort)
    f.rejectWrites()

    const result = await f.service.recoverAccess('periodic')

    expect(result).toMatchObject({ outcome: 'still_failing', code: 'configuration_failed' })
    expect((await f.service.serviceStatus()).routes).toEqual([])
    expect(f.gateway.snapshot()).toMatchObject({ running: false, baseUrl: null, routes: [] })
  })

  it('配置文件读不出来：同样不回写、不报恢复，等客户重新写入', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const oldPort = f.state().relay!.port
    await f.gateway.stop()
    await occupyForeign(oldPort)
    await chmod(f.configPath, 0o000)

    const result = await f.service.recoverAccess('periodic')
    await chmod(f.configPath, 0o600)
    expect(result.outcome).toBe('still_failing')
    expect(result.code).toBe('configuration_interrupted')
    expect(result.configurations.codex).toBe('unknown')
    expect(f.state().pendingShells).toEqual(['codex'])
  })
})

describe('恢复结论：路由真的通了才算好', () => {
  it('上次配置没做完（壳仍在暂停名单）时，定时核对 ⛔ 报「正常」', async () => {
    const f = await realSetup()
    await connectCodex(f)
    await f.store.write({ ...f.state(), pendingShells: ['codex'] })
    await f.service.stop()
    const restarted = new AiAccessService(f.store, f.adapters, f.gateway, f.extras)
    cleanups.push(() => restarted.stop())
    await restarted.initialize()

    const result = await restarted.recoverAccess('periodic')
    const snapshot = await restarted.serviceStatus()
    expect(result.outcome).toBe('still_failing')
    expect(result.code).toBe('configuration_interrupted')
    expect(snapshot.routes).toEqual([])
    expect(snapshot.startupError).toBe('configuration_interrupted')
    // 客户端此刻确实连不上：结论必须跟这件事一致。
    expect((await post(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, f.state().relay!.token, '{}')).status).toBe(409)
  })

  it('一切正常仍报「对得上」，⛔ 因为新闸门把好的也拦下来', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const result = await f.service.recoverAccess('wake')
    expect(result).toMatchObject({ outcome: 'ok', configurations: { codex: 'ok' } })
  })
})

describe('没人管的故障态：⛔ 把最近故障刷成一色', () => {
  /** 落一个「上次配置没做完」的持续故障态：每次定时核对都会报 still_failing。 */
  async function stuckService(f: Fixture): Promise<AiAccessService> {
    await connectCodex(f)
    await f.store.write({ ...f.state(), pendingShells: ['codex'] })
    await f.service.stop()
    const service = new AiAccessService(f.store, f.adapters, f.gateway, f.extras)
    cleanups.push(() => service.stop())
    await service.initialize()
    return service
  }
  const failures = (f: Fixture) => f.faults.filter(fault => fault.outcome === 'still_failing')

  it('同一个原因持续 24 小时（144 次定时核对）只记一条', async () => {
    const f = await realSetup()
    const service = await stuckService(f)
    f.faults.length = 0

    for (let tick = 0; tick < 144; tick += 1) {
      const result = await service.recoverAccess('periodic')
      // 结论与状态照常每次都算，⛔ 因为不记录就跟着糊弄。
      expect(result).toMatchObject({ outcome: 'still_failing', code: 'configuration_interrupted' })
    }
    expect(failures(f)).toHaveLength(1)
    expect((await service.serviceStatus()).routes).toEqual([])
  })

  it('原因变了就再记一条：配置判不出来 → 配置不见了', async () => {
    const f = await realSetup()
    const service = await stuckService(f)
    f.faults.length = 0
    await service.recoverAccess('periodic')
    expect(failures(f)).toHaveLength(1)

    // 同一个故障态里，原因从「这次没能落定」换成「配置已不是工具箱写的那份」，是新信息。
    await rm(f.configPath)
    const changed = await service.recoverAccess('periodic')
    expect(changed).toMatchObject({ outcome: 'still_failing', code: 'configuration_failed' })
    expect(failures(f)).toHaveLength(2)
    // 换完原因之后继续坏着，照旧不再重复记。
    await service.recoverAccess('periodic')
    expect(failures(f)).toHaveLength(2)
  })

  it('恢复之后再坏，要重新记一条', async () => {
    const f = await realSetup()
    const service = await stuckService(f)
    f.faults.length = 0
    await service.recoverAccess('periodic')
    expect(failures(f)).toHaveLength(1)

    // 重新启用把它修好：这一次核对是 ok，记忆清掉。
    await service.configureProvider('codex', 'deepseek', KEY, 'deepseek-v4-pro')
    expect((await service.recoverAccess('periodic')).outcome).toBe('ok')
    expect(failures(f)).toHaveLength(1)

    // 再坏一次，是新的一段故障，要让客服看见。
    await f.store.write({ ...f.state(), pendingShells: ['codex'] })
    expect((await service.recoverAccess('periodic')).outcome).toBe('still_failing')
    expect(failures(f)).toHaveLength(2)
  })

  it('端口被占换到新端口是一次性事件，每次都照旧记', async () => {
    const f = await realSetup()
    await connectCodex(f)
    for (let round = 0; round < 2; round += 1) {
      const occupied = f.state().relay!.port
      await f.gateway.stop()
      await occupyForeign(occupied)
      const result = await f.service.recoverAccess('periodic')
      expect(result.outcome).toBe('repaired')
    }
    expect(f.faults.filter(fault => fault.outcome === 'recovered')).toHaveLength(2)
  })
})

describe('运行中故障：客户在 AI 里用起来之后才出的问题', () => {
  it('客户端真实调用被上游 401：进故障记录，⛔ 改写「客户自己测过」的结论', async () => {
    const f = await realSetup()
    await connectCodex(f)
    f.faults.length = 0
    f.upstream.state.mode = '401'

    const client = await post(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, f.state().relay!.token, JSON.stringify({ input: [{ role: 'user', content: 'hi' }] }))
    expect(client.status).toBe(400)
    expect(client.text).toContain('Key 未通过认证')
    expect(client.text).not.toContain('fixture invalid api key')
    expect(f.faults).toContainEqual({ shell: 'codex', provider: 'deepseek', code: 'key_rejected' })
    // attempt 是「客户点过测试」的事实，后台流量 ⛔ 把它抹掉。
    expect((await f.service.status()).attempt?.ok).toBe(true)
  })

  it('自测请求不进故障记录：那条路径已经有 attempt 和 markCheck 在记', async () => {
    const f = await realSetup()
    await connectCodex(f)
    f.faults.length = 0
    f.upstream.state.mode = '401'
    await f.service.testProvider('codex', 'deepseek')
    expect(f.faults.filter(fault => fault.action === undefined && fault.outcome === undefined)).toHaveLength(1)
  })
})

/** 开一条不等回复的请求，好在半途把它掐掉——客户在 AI 里按停止就是这个形态。 */
function openRequest(url: string, token: string, body: string, headers: Record<string, string> = {}) {
  const req = httpRequest(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers } })
  const settled = new Promise<void>(resolve => { req.on('error', () => resolve()); req.on('response', () => resolve()) })
  req.end(body)
  return { req, settled }
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 3_000; waited += 10) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等不到：${label}`)
}

describe('客户自己在 AI 里取消', () => {
  /** 连上网关、上游挂住、客户端半途 destroy —— 客户在 AI 里按停止就是这个形态。 */
  async function cancelMidFlight(f: Fixture): Promise<void> {
    const call = openRequest(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, f.state().relay!.token,
      JSON.stringify({ input: [] }), { 'user-agent': 'hold-me/1.0' })
    await until(() => f.upstream.held.length > 0, '上游收到请求')
    call.req.destroy()
    await call.settled
    await until(() => (f.gateway.snapshot().requests[0]?.source) === 'client', '网关记下这次调用')
  }

  it('客户端中途断开连接：⛔ 落进故障记录与客服摘要', async () => {
    const f = await realSetup()
    await connectCodex(f)
    f.faults.length = 0
    await cancelMidFlight(f)
    // 客户自己停下的不是故障。记了会让帮助页说「未连接到服务商，请检查网络」，把排查引到网络上去。
    expect(f.faults).toEqual([])
  })

  it('客户端中途断开连接：判类说清是「被取消」，⛔ 混进网络故障；内存面板照旧记', async () => {
    const f = await realSetup()
    await connectCodex(f)
    await cancelMidFlight(f)
    expect(f.gateway.snapshot().requests[0]).toMatchObject({ source: 'client', ok: false, code: 'client_aborted' })
  })

  it('真的超时仍然是故障，照旧进记录', async () => {
    const f = await realSetup(300)
    await connectCodex(f)
    f.faults.length = 0
    const call = openRequest(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, f.state().relay!.token,
      JSON.stringify({ input: [] }), { 'user-agent': 'hold-me/1.0' })
    await until(() => f.upstream.held.length > 0, '上游收到请求')
    await until(() => f.faults.length > 0, '超时被记下来')
    call.req.destroy()
    await call.settled

    expect(f.faults).toContainEqual({ shell: 'codex', provider: 'deepseek', code: 'timeout' })
    expect(f.gateway.snapshot().requests[0]).toMatchObject({ source: 'client', code: 'timeout' })
  })

  it('取消 ⛔ 影响「已观察到软件调用」，也 ⛔ 动别的判类', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const address = `${f.gateway.baseUrl!}/codex/deepseek/v1/responses`
    const token = f.state().relay!.token
    const call = openRequest(address, token, JSON.stringify({ input: [] }), { 'user-agent': 'hold-me/1.0' })
    await until(() => f.upstream.held.length > 0, '上游收到请求')
    call.req.destroy()
    await call.settled
    await until(() => f.gateway.snapshot().requests.length > 0, '网关记下这次调用')
    // 取消的那条没成功，⛔ 给这一家打「已观察到软件调用」的勾。
    expect((await f.service.serviceStatus()).usage.find(item => item.shell === 'codex')?.observedClientCall).toBeNull()

    // 紧接着上游真的拒了 Key：这条照旧是 key_rejected，也照旧进记录。
    f.faults.length = 0
    f.upstream.state.mode = '401'
    const rejected = await post(address, token, JSON.stringify({ input: [] }))
    expect(rejected.status).toBe(400)
    expect(rejected.text).toContain('Key 未通过认证')
    expect(f.faults).toContainEqual({ shell: 'codex', provider: 'deepseek', code: 'key_rejected' })
  })
})

describe('切换服务商后迟到的响应', () => {
  it('旧路由的响应 ⛔ 给刚换上的服务商打「已观察到调用」的勾', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const token = f.state().relay!.token
    const pendingCall = post(`${f.gateway.baseUrl!}/codex/deepseek/v1/responses`, token, JSON.stringify({ input: [] }), { 'user-agent': 'hold-me/1.0' })
    while (f.upstream.held.length === 0) await new Promise(resolve => setTimeout(resolve, 10))

    await f.service.configureProvider('codex', 'moonshot', KEY, 'kimi-k3')
    f.upstream.release()
    expect((await pendingCall).status).toBe(200)

    const stage = (await f.service.serviceStatus()).usage.find(item => item.shell === 'codex')
    expect(stage?.provider).toBe('moonshot')
    expect(stage?.observedClientCall).toBeNull()
  })

  it('工具调用不算完整回答；当前路由收到完整文本终态后才打勾', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const address = `${f.gateway.baseUrl!}/codex/deepseek/v1/responses`
    const toolTurn = await post(address, f.state().relay!.token, JSON.stringify({ input: [] }))
    expect(toolTurn.status).toBe(200)
    expect((await f.service.serviceStatus()).usage.find(item => item.shell === 'codex')?.observedClientCall).toBeNull()

    const answer = await post(address, f.state().relay!.token, JSON.stringify({ input: [{ role: 'user', content: 'hi' }], stream: true }))
    expect(answer.status).toBe(200)
    expect((await f.service.serviceStatus()).usage.find(item => item.shell === 'codex')?.observedClientCall).not.toBeNull()
  })
})

describe('只保存新 Key（还没点启用）', () => {
  it('路由不断线、状态仍是托管中，新 Key 立刻生效', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const address = `${f.gateway.baseUrl!}/codex/deepseek/v1/responses`
    const token = f.state().relay!.token

    await f.service.saveProviderKey('codex', 'deepseek', 'fixture-only-replacement-key-0123456789')
    // 壳里的 config 还指着本机网关：路由一摘，客户在 Codex 里就是一路 409。
    expect((await post(address, token, JSON.stringify({ input: [] }))).status).toBe(200)
    expect((await f.service.serviceStatus()).usage.find(item => item.shell === 'codex')?.configuration).toBe('ok')
  })

  it('新 Key 是错的、紧接着的启用失败，客户端也不该掉进 409', async () => {
    const f = await realSetup()
    await connectCodex(f)
    const address = `${f.gateway.baseUrl!}/codex/deepseek/v1/responses`
    const token = f.state().relay!.token

    await f.service.saveProviderKey('codex', 'deepseek', 'fixture-only-wrong-key-0123456789')
    f.upstream.state.mode = '401'
    const status = await f.service.useProvider('codex', 'deepseek')
    expect(status.attempt).toMatchObject({ ok: false, code: 'key_rejected' })

    // 启用失败后仍是「这个 AI 在用工具箱的模型 API」，恢复也不该说「无需恢复」。
    expect((await f.service.serviceStatus()).usage.find(item => item.shell === 'codex')?.configuration).toBe('ok')
    expect((await f.service.recoverAccess('manual')).outcome).not.toBe('not-managed')
    // 客户看到的是可行动的 Key 指引（400），⛔ 上游原样的 401 或没头没脑的 409。
    const rejected = await post(address, token, JSON.stringify({ input: [] }))
    expect(rejected.status).toBe(400)
    expect(rejected.text).toContain('Key 未通过认证')
  })
})

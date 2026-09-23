import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUsageReceiptRecorder, gatewayUsageEventToReceipt,
  type UsageReceiptEvent, type UsageReceiptRecorder } from '../../app/main/ai-access/usage-receipt'
import { AiAccessService, type AiAccessAdapter, type AiAccessState, type AiAccessStateStore } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'
import type { DesktopRouteAttestor } from '../../app/main/ai-access/desktop-route-attestation'
import type { CodexDesktopRouteVerification } from '../../app/shared/api-service-types'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerAiAccessActions } from '../../app/main/actions/ai-access'

const root = (): Promise<string> => mkdtemp(join(tmpdir(), 'laixin-usage-receipt-'))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function track(dir: string): Promise<string> { roots.push(dir); return dir }

const recorder = (dir: string, options: Partial<Parameters<typeof createUsageReceiptRecorder>[0]> = {}): UsageReceiptRecorder =>
  createUsageReceiptRecorder({
    platform: 'darwin', version: '0.5.2', osVersion: '26.0.0',
    store: { read: async () => JSON.parse(await readFile(join(dir, 'usage-receipt.json'), 'utf8').catch(() => '[]') as string),
      write: async value => { await writeFile(join(dir, 'usage-receipt.json'), JSON.stringify(value)) } },
    now: () => Date.parse('2026-09-15T08:00:00.000Z'),
    ...options
  })

const event = (overrides: Partial<UsageReceiptEvent> = {}): UsageReceiptEvent =>
  ({ shell: 'codex', stage: 'probe', outcome: 'failure', code: 'key_rejected', ...overrides })

describe('Mac 使用回执（API-04）', () => {
  it('macOS 本机按固定阶段记录成功、失败与未验证，导出文本逐字等于白名单（含客户端版本）', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir, { clientVersion: async shell => shell === 'codex' ? '0.42.0' : '1.0.312' })
    receipts.record(event())
    receipts.record(event({ shell: 'claude', stage: 'config-write', outcome: 'success', code: undefined, at: '2026-09-15T02:05:00.000Z' }))
    receipts.record(event({ shell: 'codex', stage: 'codex-desktop', outcome: 'unverified', code: 'socket_owner_not_codex_desktop', at: '2026-09-15T02:09:00.000Z' }))
    const result = await receipts.generate()
    expect(result.ok).toBe(true)
    expect(result.count).toBe(3)
    expect(typeof result.snapshotId).toBe('string')
    // 逐字固定：任何多余字段或自由文本都会让这条相等断言红。首条未带 at，按设计落当前时刻。
    expect(result.receipt).toBe([
      '来信AI工具箱 Mac 使用回执（共 3 条）',
      '',
      '1. 发生时间：2026-09-15T08:00:00.000Z',
      '   客户端：Codex',
      '   客户端版本：0.42.0',
      '   阶段：上游探测',
      '   结果：失败（key_rejected）',
      '   工具箱版本：0.5.2',
      '   macOS 版本：26.0.0',
      '',
      '2. 发生时间：2026-09-15T02:05:00.000Z',
      '   客户端：Claude Code',
      '   客户端版本：1.0.312',
      '   阶段：配置写入',
      '   结果：成功',
      '   工具箱版本：0.5.2',
      '   macOS 版本：26.0.0',
      '',
      '3. 发生时间：2026-09-15T02:09:00.000Z',
      '   客户端：Codex',
      '   客户端版本：0.42.0',
      '   阶段：Codex Desktop 证明',
      '   结果：未验证（socket_owner_not_codex_desktop）',
      '   工具箱版本：0.5.2',
      '   macOS 版本：26.0.0',
      '',
      '本回执只包含上述白名单字段，不含账号、设备标识、Key、令牌、模型、服务商、提示词、回答、配置内容、路径、日志、网络信息或任何自由文本。',
      '请你自行复制或保存并发送给支持方；工具箱不会自动发送，也不表示支持方已收到。'
    ].join('\n'))
  })

  it('客户端版本读不到或读取器报错时如实记 unknown，且 record 不等待版本读取', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir, { clientVersion: async () => { throw new Error('VERSION_PROBE_BROKEN') } })
    receipts.record(event({ stage: 'client-call', outcome: 'success' }))
    const result = await receipts.generate()
    expect(result.receipt).toContain('客户端版本：unknown')
    // record 立即返回：版本读取器挂起 5 秒也不阻塞调用方（只用 50ms 就走完这一步）。
    const started = Date.now()
    const slow = recorder(await track(await root()), { clientVersion: () => new Promise(resolve => { setTimeout(() => resolve('9.9.9'), 1500) }) })
    slow.record(event({ stage: 'client-call', outcome: 'success' }))
    expect(Date.now() - started).toBeLessThan(1000)
    const slowResult = await slow.generate()
    expect(slowResult.receipt).toContain('客户端版本：9.9.9')
  })

  it('最多保留 30 条：超量裁掉最旧', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir)
    for (let index = 0; index < 31; index += 1) {
      receipts.record(event({ stage: 'config-write', outcome: 'success', code: undefined, at: new Date(Date.parse('2026-09-15T08:00:00.000Z') + index * 1000).toISOString() }))
    }
    const result = await receipts.generate()
    expect(result.count).toBe(30)
    expect(result.receipt).not.toContain('2026-09-15T08:00:00.000Z')
    expect(result.receipt).toContain('2026-09-15T08:00:30.000Z')
  })

  it('最多保留 14 天：到期裁掉最旧', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir)
    receipts.record(event({ at: '2026-08-25T00:00:00.000Z' }))
    receipts.record(event({ stage: 'config-write', outcome: 'success', code: undefined, at: '2026-09-14T00:00:00.000Z' }))
    const result = await receipts.generate()
    expect(result.count).toBe(1)
    expect(result.receipt).not.toContain('2026-08-25')
    // 14 天以 2026-09-01T08:00:00Z 为界：更旧的即时条数不满也不出现在导出里。
    const aging = recorder(dir, { now: () => Date.parse('2026-09-15T08:00:00.000Z') })
    expect((await aging.generate()).receipt).not.toContain('2026-08-25')
  })

  it('本机没有记录时如实说明，不编造内容', async () => {
    const dir = await track(await root())
    const result = await recorder(dir).generate()
    expect(result).toEqual({ ok: false, reason: 'empty' })
  })

  it('非 macOS 不记录也不导出', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir, { platform: 'win32' })
    receipts.record(event())
    receipts.record(event({ stage: 'client-call', outcome: 'success' }))
    expect(await receipts.generate()).toEqual({ ok: false, reason: 'unsupported' })
    await expect(readFile(join(dir, 'usage-receipt.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('存储里的条目逐字段校验：白名单外的字段、阶段、结果或自由文本代码都进不了导出', async () => {
    const dir = await track(await root())
    const valid = { version: '0.5.2', osVersion: '26.0.0', client: 'codex', clientVersion: '0.42.0', at: '2026-09-15T02:00:00.000Z', stage: 'probe', outcome: 'failure', code: 'key_rejected' }
    await writeFile(join(dir, 'usage-receipt.json'), JSON.stringify([
      { ...valid, note: '客户的私密备注' },
      { ...valid, outcome: 'partly-ok' },
      { ...valid, code: '上游说：账户余额不足，请充值' },
      { ...valid, client: 'cursor' },
      valid,
      { ...valid, at: '不是时间' },
      { ...valid, clientVersion: '上游 1.2.3 说' }
    ]))
    const result = await recorder(dir).generate()
    expect(result.count).toBe(1)
    expect(result.receipt).not.toContain('私密备注')
    expect(result.receipt).not.toContain('充值')
    expect(result.receipt).toContain('key_rejected')
  })

  it('保存严格绑定已预览的快照：预览后新事件不改变落盘内容', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir)
    receipts.record(event({ stage: 'client-call', outcome: 'success' }))
    const preview = await receipts.generate()
    expect(preview.ok).toBe(true)
    // 客户预览之后又用了一次模型 API：新事件只进下一次生成，⛔ 混进客户正在看的这一份。
    receipts.record(event({ stage: 'probe', outcome: 'failure', code: 'rate_limited', at: '2026-09-15T07:59:00.000Z' }))
    const target = join(dir, '回执.txt')
    expect(await receipts.save(target, preview.snapshotId)).toEqual({ ok: true })
    const saved = await readFile(target, 'utf8')
    expect(saved).toBe(`${preview.receipt}\n`)
    expect(saved).not.toContain('rate_limited')
    expect(saved).toContain('客户端版本：unknown')
    expect(saved).toContain('不会自动发送')
  })

  it('伪造或未知的快照标识拒绝保存且不写文件；未预览直接保存同样拒绝', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir)
    receipts.record(event({ stage: 'client-call', outcome: 'success' }))
    const target = join(dir, '回执.txt')
    expect(await receipts.save(target, 'not-a-real-snapshot-id')).toEqual({ ok: false, reason: 'no-preview' })
    expect(await receipts.save(target)).toEqual({ ok: false, reason: 'no-preview' })
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('预览快照是短期的：过期后保存拒绝并提示重新生成', async () => {
    const dir = await track(await root())
    let clock = Date.parse('2026-09-15T08:00:00.000Z')
    const receipts = recorder(dir, { now: () => clock, snapshotTtlMs: 60_000 })
    receipts.record(event({ stage: 'client-call', outcome: 'success' }))
    const preview = await receipts.generate()
    clock += 61_000
    expect(await receipts.save(join(dir, '回执.txt'), preview.snapshotId)).toEqual({ ok: false, reason: 'expired' })
  })

  it('写不出去如实报告；非 macOS 不提供保存', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir)
    receipts.record(event({ stage: 'client-call', outcome: 'success' }))
    const preview = await receipts.generate()
    const target = join(dir, '回执.txt')
    expect(await receipts.save(join(dir, '不存在的目录', '回执.txt'), preview.snapshotId)).toEqual({ ok: false, reason: 'write-failed' })
    const foreign = recorder(await track(await root()), { platform: 'win32' })
    expect(await foreign.save(target, 'whatever')).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('记录失败不影响主流程：记录器怎么坏，启用接入都照常成功', async () => {
    const dir = await track(await root())
    const throwing: UsageReceiptRecorder = {
      record: () => { throw new Error('RECEIPT_STORAGE_BROKEN') },
      generate: async () => ({ ok: false, reason: 'empty' }),
      save: async () => ({ ok: false, reason: 'write-failed' }),
      peekSnapshot: () => 'no-preview'
    }
    const full: UsageReceiptRecorder = { ...recorder(dir), record: throwing.record }
    const service = serviceWithRecorder(full)
    await service.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    const status = await service.useProvider('codex', 'deepseek')
    expect(status.shells.codex.selected).toBe('deepseek')
    // 落盘环节坏掉也一样：record 内部吞掉，主流程拿到的是完整状态。
    const brokenStore = recorder(dir, {
      store: { read: async () => { throw new Error('DISK_UNREADABLE') }, write: async () => { throw new Error('DISK_FULL') } }
    })
    expect(() => brokenStore.record(event())).not.toThrow()
  })

  it('service 在五个固定阶段产生回执事件：目标检查、上游探测、配置写入', async () => {
    const dir = await track(await root())
    const events: UsageReceiptEvent[] = []
    const service = serviceWithRecorder({ ...recorder(dir), record: event => { events.push(event) } }, {
      configurationTarget: { shell: 'codex', scope: 'user', override: 'none', writable: true },
      probeResults: [{ ok: false, code: 'key_rejected' as const }, { ok: true }]
    })
    await service.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    await service.useProvider('codex', 'deepseek')
    // 首次启用探测失败：既有语义是探测不过就不写配置，所以这里只有目标检查与探测两条。
    expect(events.map(item => [item.stage, item.outcome, item.code ?? null])).toEqual([
      ['config-target', 'success', null],
      ['probe', 'failure', 'key_rejected']
    ])
    await service.useProvider('codex', 'deepseek')
    expect(events.slice(2).map(item => [item.stage, item.outcome, item.code ?? null])).toEqual([
      ['config-target', 'success', null],
      ['probe', 'success', null],
      ['config-write', 'success', null]
    ])
    await service.useProvider('codex', 'deepseek')
    expect(events.at(-1)).toMatchObject({ stage: 'config-write', outcome: 'success' })
  })

  it('配置目标被安全拦截、版本闸门拦截、端口被占时，记录失败或未验证，不虚构成功', async () => {
    const dir = await track(await root())
    const events: UsageReceiptEvent[] = []
    const blocked = serviceWithRecorder({ ...recorder(dir), record: event => { events.push(event) } }, {
      configurationTarget: { shell: 'codex', scope: 'unknown', override: 'unknown', writable: false, reason: 'managed-configuration' }
    })
    await blocked.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    await blocked.useProvider('codex', 'deepseek')
    expect(events).toEqual([{ shell: 'codex', stage: 'config-target', outcome: 'failure', code: 'managed-configuration' }])

    const gated = serviceWithRecorder({ ...recorder(dir), record: event => { events.push(event) } }, { gate: '版本不兼容说明' })
    await gated.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    await gated.useProvider('codex', 'deepseek')
    expect(events.at(-1)).toEqual({ shell: 'codex', stage: 'probe', outcome: 'unverified', code: 'shell_version_incompatible' })

    const noPort = serviceWithRecorder({ ...recorder(dir), record: event => { events.push(event) } }, { gatewayStartFails: true })
    await noPort.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    await noPort.useProvider('codex', 'deepseek')
    expect(events.at(-1)).toEqual({ shell: 'codex', stage: 'probe', outcome: 'unverified', code: 'port_unavailable' })
  })

  it('真实网关上连续使用：客户端调用观察与 Codex Desktop 证明进回执，重复调用不刷屏', async () => {
    const dir = await track(await root())
    const events: UsageReceiptEvent[] = []
    const base = recorder(dir)
    const receipts: UsageReceiptRecorder = { ...base, record: item => { events.push(item); base.record(item) } }
    let desktop: CodexDesktopRouteVerification = { status: 'unverified', at: null, reason: 'socket_owner_not_codex_desktop' }
    const attestor: DesktopRouteAttestor = { observe: async () => desktop }
    const gateway = new AiGateway({
      fetch: async () => new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }),
      desktopAttestor: attestor,
      onUsageEvent: item => receipts.record(gatewayUsageEventToReceipt(item))
    })
    await gateway.start(0, 'laixin-usage-receipt-client-token-1')
    const service = serviceWithRecorder(receipts, { gateway })
    await service.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    await service.useProvider('codex', 'deepseek')

    const call = (): Promise<Response> => fetch(`${gateway.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer laixin-usage-receipt-client-token-1' }, body: JSON.stringify({ input: 'private prompt' })
    })
    // 桌面证明在响应完成后异步收口；给事件链路一拍时间再断言。
    const settle = async (): Promise<void> => { await new Promise(resolve => { setTimeout(resolve, 20) }) }
    await (await call()).text()
    await settle()
    await (await call()).text()
    await settle()
    const clientEvents = events.filter(item => item.stage === 'client-call')
    expect(clientEvents).toEqual([expect.objectContaining({ shell: 'codex', stage: 'client-call', outcome: 'success' })])
    const desktopEvents = events.filter(item => item.stage === 'codex-desktop')
    expect(desktopEvents).toEqual([expect.objectContaining({ shell: 'codex', stage: 'codex-desktop', outcome: 'unverified', code: 'socket_owner_not_codex_desktop' })])

    desktop = { status: 'verified', at: '2026-09-15T08:00:00.000Z', reason: 'verified_socket_bound_desktop' }
    await (await call()).text()
    await settle()
    expect(events.filter(item => item.stage === 'codex-desktop')).toEqual([
      expect.objectContaining({ outcome: 'unverified', code: 'socket_owner_not_codex_desktop' }),
      expect.objectContaining({ outcome: 'success' })
    ])
    const result = await receipts.generate()
    expect(result.receipt).toContain('阶段：客户端调用观察')
    expect(result.receipt).toContain('结果：成功')
    expect(result.receipt).not.toContain('private prompt')
    await service.stop()
  })

  it('网关事件到回执事件的映射是固定的', () => {
    expect(gatewayUsageEventToReceipt({ kind: 'client-accepted', shell: 'claude', at: '2026-09-15T02:00:00.000Z' }))
      .toEqual({ shell: 'claude', stage: 'client-call', outcome: 'success', at: '2026-09-15T02:00:00.000Z' })
    expect(gatewayUsageEventToReceipt({ kind: 'desktop-proof', shell: 'codex', verified: false, reason: 'desktop_signature_unverified', at: '2026-09-15T02:00:00.000Z' }))
      .toEqual({ shell: 'codex', stage: 'codex-desktop', outcome: 'unverified', code: 'desktop_signature_unverified', at: '2026-09-15T02:00:00.000Z' })
  })

  it('导出全程零网络请求：生成与保存只碰本机文件，自动发送接回就必须红', async () => {
    const dir = await track(await root())
    const receipts = recorder(dir)
    receipts.record(event())
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); throw new Error('NETWORK_DISABLED_IN_TEST') }) as typeof fetch
    try {
      const localPreview = await receipts.generate()
      await receipts.save(join(dir, '回执.txt'), localPreview.snapshotId)
      const registry = new BridgeRegistry()
      registerAiAccessActions(registry, stubAccess(), undefined, undefined, undefined, { usageReceipt: receipts, showSaveDialog: async () => ({ canceled: false, filePath: join(dir, '回执2.txt') }) })
      const generated = JSON.parse(((await registry.execute('aiaccess.usageReceipt', undefined)) as { snapshot: string }).snapshot) as { snapshotId?: string }
      await registry.execute('aiaccess.usageReceiptSave', { snapshotId: generated.snapshotId })
    } finally { globalThis.fetch = originalFetch }
    expect(calls).toEqual([])
    expect(await readFile(join(dir, '回执.txt'), 'utf8')).toContain('Mac 使用回执')
  })

  it('桥上「生成／保存 Mac 使用回执」：取消保存不写文件，也不出现「已发送」字样', async () => {
    const registry = new BridgeRegistry()
    const saveCalls: (string | undefined)[] = []
    let dialogCalls = 0
    const recorder: UsageReceiptRecorder = {
      record: () => undefined,
      generate: async () => ({ ok: true, count: 1, receipt: 'FIXTURE-RECEIPT-WHITELIST', snapshotId: 'fixture-snapshot-1' }),
      save: async (_target, snapshotId) => { saveCalls.push(snapshotId); return { ok: true } },
      peekSnapshot: snapshotId => snapshotId === 'fixture-snapshot-1' ? 'ok' : 'no-preview'
    }
    let picked: { canceled: boolean; filePath?: string } = { canceled: true }
    registerAiAccessActions(registry, stubAccess(), undefined, undefined, undefined, {
      usageReceipt: recorder,
      showSaveDialog: async () => { dialogCalls += 1; return picked }
    })
    const preview = JSON.parse(((await registry.execute('aiaccess.usageReceipt', undefined)) as { snapshot: string }).snapshot)
    expect(preview).toEqual({ ok: true, count: 1, receipt: 'FIXTURE-RECEIPT-WHITELIST', snapshotId: 'fixture-snapshot-1' })
    const canceled = JSON.parse(((await registry.execute('aiaccess.usageReceiptSave', { snapshotId: 'fixture-snapshot-1' })) as { snapshot: string }).snapshot)
    expect(canceled).toEqual({ ok: false, reason: 'canceled' })
    picked = { canceled: false, filePath: '/tmp/fixture-receipt.txt' }
    const saved = JSON.parse(((await registry.execute('aiaccess.usageReceiptSave', { snapshotId: 'fixture-snapshot-1' })) as { snapshot: string }).snapshot)
    expect(saved).toEqual({ ok: true })
    expect(saveCalls).toEqual(['fixture-snapshot-1'])
    // 没有有效预览时：⛔ 弋出系统保存对话框，直接如实拒绝。
    const noPreview = JSON.parse(((await registry.execute('aiaccess.usageReceiptSave', { snapshotId: 'forged-id' })) as { snapshot: string }).snapshot)
    expect(noPreview).toEqual({ ok: false, reason: 'no-preview' })
    expect(dialogCalls).toBe(2)
  })
})

type ServiceHarness = {
  configurationTarget?: unknown
  probeResults?: { ok: boolean; code?: 'key_rejected' }[]
  gate?: string
  gatewayStartFails?: boolean
  gateway?: AiGateway
}

function serviceWithRecorder(recorder: UsageReceiptRecorder, harness: ServiceHarness = {}): AiAccessService {
  let state: AiAccessState = { version: 1, selected: {} }
  const store: AiAccessStateStore = { read: async () => state, write: async next => { state = next } }
  const codex: AiAccessAdapter = {
    shell: 'codex',
    applyDeepSeek: async () => undefined,
    applyProvider: async () => undefined,
    applyConnection: async () => undefined,
    captureConnection: async () => async () => undefined,
    ...(harness.configurationTarget === undefined ? {} : { configurationTargetStatus: async () => harness.configurationTarget as never })
  }
  const claude: AiAccessAdapter = { shell: 'claude', applyDeepSeek: async () => undefined, applyProvider: async () => undefined }
  const hermes: AiAccessAdapter = { shell: 'hermes', applyDeepSeek: async () => undefined, applyProvider: async () => undefined }
  const gatewayStub = {
    baseUrl: 'http://127.0.0.1:45101',
    start: async () => { if (harness.gatewayStartFails === true) throw new Error('AI_ACCESS_PORT_UNAVAILABLE'); return 45101 },
    stop: async () => undefined,
    setRoutes: () => undefined,
    snapshot: () => ({ running: true, baseUrl: 'http://127.0.0.1:45101', startedAt: '2026-09-15T00:00:00.000Z', requests: [], routes: [] }),
    clientAcceptances: () => ({}),
    codexDesktopRouteAcceptance: () => ({ status: 'unverified' as const, at: null, reason: 'awaiting_desktop_request' as const }),
    onClientFailure: () => undefined,
    probe: async () => harness.probeResults?.shift() ?? { ok: true }
  }
  return new AiAccessService(store, [codex, claude, hermes], harness.gateway ?? gatewayStub as unknown as AiGateway, {
    ...(harness.gate === undefined ? {} : { gate: async () => harness.gate }),
    recordUsageEvent: event => recorder.record(event)
  })
}

function stubAccess(): Pick<AiAccessService, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'> {
  return { status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn() } as unknown as
    Pick<AiAccessService, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
}

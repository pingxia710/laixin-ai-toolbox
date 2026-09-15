import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remedyOutcomeView, remedyPlan, readRemedyResult } from '../../app/renderer/src/platform/remedy'
import { configurationAlert, readUsageStages, usageStageFor, usageStageViews } from '../../app/renderer/src/platform/usage-stages'
import { FAULT_COLUMNS, faultEntry, faultListHead, readFaultRecords } from '../../app/renderer/src/recent-faults'
import { routeVerdict } from '../../app/renderer/src/pages/tunnel'
import { requestNetworkDiagnosticNavigation, requestedDiagnosticSoftware, requestedTab } from '../../app/renderer/src/navigation'
import { faultColumns, type FaultRecord } from '../../app/shared/fault-log-types'
import type { ApiUsageStage } from '../../app/shared/api-service-types'

const stage = (over: Partial<ApiUsageStage> = {}): ApiUsageStage => ({
  shell: 'codex', provider: 'deepseek', tested: null, configured: null, observedClientCall: null, configuration: 'ok', ...over
})

describe('失败行的处理按钮', () => {
  it('每个判类只给一个按钮，按 C5 的建议动作决定是哪一个', () => {
    expect(remedyPlan('key_rejected')).toMatchObject({ action: 'openConsole', label: '打开官方控制台' })
    expect(remedyPlan('request_invalid')).toMatchObject({ action: 'reapply', label: '重新写入配置' })
    expect(remedyPlan('local_service_down')).toMatchObject({ action: 'restartGateway', label: '重启本机 API 服务' })
    expect(remedyPlan('configuration_failed')).toMatchObject({ action: 'reapply' })
    expect(remedyPlan('shell_version_incompatible')).toMatchObject({ action: 'useOfficial' })
  })

  it('没有可自动执行的动作就不出按钮，客户按文案自己处理', () => {
    expect(remedyPlan('content_too_long')).toBeNull()
    expect(remedyPlan('network_error')).toBeNull()
  })

  it('复验三态各有说法与色调，⛔ 把没通过说成已恢复', () => {
    expect(remedyOutcomeView({ outcome: 'recovered', message: '重新测试后通过。' })).toMatchObject({ label: '已恢复', tone: 'positive' })
    expect(remedyOutcomeView({ outcome: 'still_failing', message: '仍然不通。', next: 'openConsole' }))
      .toMatchObject({ label: '仍有问题', tone: 'danger', nextLabel: '打开官方控制台' })
    expect(remedyOutcomeView({ outcome: 'unknown', message: '不能确认。' })).toMatchObject({ label: '不能确认', tone: 'neutral', nextLabel: null })
  })

  it('桥回来的结果先校验再上屏，来路不明的内容进不了界面', () => {
    const good = JSON.stringify({ shell: 'codex', provider: 'deepseek', action: 'retest', at: '2026-09-12T09:00:00Z', outcome: 'recovered', message: '好了。' })
    expect(readRemedyResult(good)).toMatchObject({ outcome: 'recovered' })
    for (const bad of [{ outcome: 'fixed', action: 'retest', message: 'x' }, { outcome: 'recovered', action: 'rm -rf', message: 'x' }, { outcome: 'recovered', action: 'retest' }]) {
      expect(() => readRemedyResult(JSON.stringify(bad))).toThrow('AI_REMEDY_INVALID')
    }
  })
})

describe('接入进度三态', () => {
  it('Codex 的普通调用与 Desktop 验证分开显示，两个都没发生时全是等待', () => {
    const views = usageStageViews(stage())
    expect(views.map(view => view.state)).toEqual(['waiting', 'waiting', 'waiting', 'waiting'])
    expect(views[2]).toMatchObject({ label: '已观察到 Codex 调用（CLI/桌面版）' })
    expect(views[2].detail).toContain('CLI')
    expect(views[3].detail).toContain('完全退出并重新打开 Codex 桌面版')
  })

  it('前两步完成、第三步空着 = 客户还没重开 AI，⛔ 显示成已经在用', () => {
    const views = usageStageViews(stage({ tested: '2026-09-12T09:00:00Z', configured: '2026-09-12T09:00:05Z' }))
    expect(views.map(view => view.state)).toEqual(['done', 'done', 'waiting', 'waiting'])
    expect(views[0].detail).not.toBe('')
    expect(views[2].detail).toContain('桌面版需看下一项')
  })

  it('普通 Codex 调用有完整时间也不能自动变成 Desktop 已验证', () => {
    const views = usageStageViews(stage({ tested: '2026-09-12T09:00:00Z', configured: '2026-09-12T09:00:05Z', observedClientCall: '2026-09-12T09:01:00Z' }))
    expect(views.map(view => view.state)).toEqual(['done', 'done', 'done', 'waiting'])
    expect(views[3].detail).toContain('桌面版')
  })

  it('只有严格 socket/签名证明才点亮 Codex Desktop，异常或伪造字段不上屏', () => {
    const verified = stage({
      observedClientCall: '2026-09-12T09:01:00Z',
      codexDesktopRoute: { status: 'verified', at: '2026-09-12T09:01:00Z', reason: 'verified_socket_bound_desktop' }
    })
    expect(usageStageViews(verified).at(-1)).toMatchObject({ label: 'Codex 桌面版已验证', state: 'done' })
    expect(readUsageStages([{ ...verified, codexDesktopRoute: { status: 'verified', at: null, reason: 'manual-claim' } }])).toEqual([])
    const projected = readUsageStages([{ ...verified, codexDesktopRoute: {
      status: 'verified', at: '2026-09-12T09:01:00Z', reason: 'verified_socket_bound_desktop',
      pid: 999, executable: '/private/Codex', socket: '127.0.0.1:1', headers: { authorization: 'secret' }
    } }])
    expect(projected).toHaveLength(1)
    expect(JSON.stringify(projected)).not.toContain('private/Codex')
    expect(JSON.stringify(projected)).not.toContain('authorization')
  })

  it('只有配置被外部改过或托管段不见了才提示，其余状态不打扰客户', () => {
    expect(configurationAlert(stage({ configuration: 'modified-externally' }))).toContain('工具箱以外的程序')
    expect(configurationAlert(stage({ configuration: 'missing' }))).toContain('不见了')
    for (const configuration of ['ok', 'unknown', 'not-managed'] as const) {
      expect(configurationAlert(stage({ configuration }))).toBeNull()
    }
  })

  it('账号总览卡片只显示「真正配置的那家」的三态：三种组合各对得上，看别家或官方就不显示', () => {
    const stages = [stage({ shell: 'codex', provider: 'deepseek', tested: '2026-09-12T09:00:00Z', configured: '2026-09-12T09:00:05Z' }),
      stage({ shell: 'claude', provider: 'moonshot' }),
      stage({ shell: 'hermes', provider: 'kimi', tested: '2026-09-12T09:00:00Z', configured: '2026-09-12T09:00:05Z', observedClientCall: '2026-09-12T09:01:00Z' })]
    // 三种组合：两步齐 / 一步都没有 / 三步齐
    expect(usageStageViews(usageStageFor(stages, 'codex', 'deepseek')!).map(view => view.state)).toEqual(['done', 'done', 'waiting', 'waiting'])
    expect(usageStageViews(usageStageFor(stages, 'claude', 'moonshot')!).map(view => view.state)).toEqual(['waiting', 'waiting', 'waiting'])
    expect(usageStageViews(usageStageFor(stages, 'hermes', 'kimi')!).map(view => view.state)).toEqual(['done', 'done', 'done'])
    // 在看的不是配置的那家、这个壳没有记录、官方套餐：都不显示，⛔ 把别家的勾挂过来
    expect(usageStageFor(stages, 'codex', 'kimi')).toBeUndefined()
    expect(usageStageFor([], 'codex', 'deepseek')).toBeUndefined()
    expect(usageStageFor([stage({ shell: 'codex', provider: null })], 'codex', 'deepseek')).toBeUndefined()
  })

  it('快照字段不合清单就整条丢掉，⛔ 让没校验的内容上屏', () => {
    expect(readUsageStages([stage(), { shell: 'evil', provider: 'deepseek', tested: null, configured: null, observedClientCall: null, configuration: 'ok' }]))
      .toHaveLength(1)
    expect(readUsageStages([{ ...stage(), configuration: 'whatever' }])).toEqual([])
    expect(readUsageStages([{ ...stage(), tested: '不是时间' }])).toEqual([])
    expect(readUsageStages('不是数组')).toEqual([])
  })
})

describe('从出错的软件直接进诊断', () => {
  it('跳到 AI网络页并带上是哪个软件', () => {
    for (const software of ['codex', 'claude', 'hermes'] as const) {
      let dispatched: Event | undefined
      const target = { dispatchEvent: (event: Event) => { dispatched = event; return true } } as Document
      requestNetworkDiagnosticNavigation(software, target)
      expect(requestedTab(dispatched!)).toBe('tunnel')
      expect(requestedDiagnosticSoftware(dispatched!)).toBe(software)
    }
  })

  it('不认未知软件，也不把别的页面的跳转当成诊断请求', () => {
    expect(requestedDiagnosticSoftware({ detail: { tab: 'tunnel', diagnosticSoftware: 'other' } } as unknown as Event)).toBeUndefined()
    expect(requestedDiagnosticSoftware({ detail: { tab: 'usage', diagnosticSoftware: 'codex' } } as unknown as Event)).toBeUndefined()
    expect(requestedDiagnosticSoftware({ detail: { tab: 'tunnel' } } as unknown as Event)).toBeUndefined()
  })
})

describe('分流说明', () => {
  const explanation = (outcome: 'direct' | 'tunnel' | 'kernel-check' | 'invalid', reasonCode: string) =>
    ({ outcome, reasonCode, title: '', detail: '', matchedRule: '' })

  it('三种结论各有说法：命中直连 / 命中通道 / 交内核判定', () => {
    expect(routeVerdict(explanation('direct', 'EXPLICIT_DIRECT_SUFFIX'))).toBe('直连')
    expect(routeVerdict(explanation('tunnel', 'SIGNED_TUNNEL_SUFFIX'))).toBe('走通道')
    expect(routeVerdict(explanation('kernel-check', 'XRAY_GEOSITE_OR_DEFAULT'))).toBe('交内核判定')
  })

  it('局域网名与私有地址单独说明是局域网直连', () => {
    expect(routeVerdict(explanation('direct', 'LOCAL_NETWORK_DIRECT'))).toBe('直连（局域网）')
    expect(routeVerdict(explanation('direct', 'PRIVATE_IP_DIRECT'))).toBe('直连（局域网）')
  })

  it('输入不合法时不给结论标签', () => {
    expect(routeVerdict(explanation('invalid', 'HOST_INVALID'))).toBe('')
  })
})

/** 假 DOM：只实现分列渲染用到的那几样，⛔ 为了测渲染就拖进整套 jsdom。 */
class FakeElement {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  className = ''
  textContent: string | null = null
  constructor(readonly tagName: string) {}
  append(...children: FakeElement[]): void { this.children.push(...children) }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
}
const fakeDocument = { createElement: (tagName: string) => new FakeElement(tagName) }
const cell = (item: FakeElement, key: string): FakeElement | undefined => item.children.find(child => child.className.includes(`fault-col-${key}`))

describe('最近故障分列', () => {
  const record = (over: Partial<FaultRecord> = {}): FaultRecord => ({ at: '2026-09-12T09:10:00.000Z', version: '0.4.9', ...over })
  // 桩 5 条：判类 + 试过 + 结果、只有网络码、已恢复、带模板说明与参数、只有判类。
  const faults: readonly FaultRecord[] = [
    record({ shell: 'codex', provider: 'deepseek', code: 'key_rejected', action: 'retest', outcome: 'still_failing' }),
    record({ at: '2026-09-12T09:05:00.000Z', network: 'AI_DIAG_TUNNEL_REQUIRED' }),
    record({ at: '2026-09-12T09:00:00.000Z', shell: 'claude', provider: 'moonshot', code: 'local_service_down', action: 'restartGateway', outcome: 'recovered' }),
    record({ at: '2026-09-12T08:55:00.000Z', network: 'AI_DIAG_STREAM_INTERRUPTED', note: 'stream_interrupted', noteParams: ['3'] }),
    record({ at: '2026-09-12T08:50:00.000Z', shell: 'hermes', code: 'timeout' })
  ]

  beforeEach(() => { vi.stubGlobal('document', fakeDocument) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('五条桩故障各渲染成五列，每列的字取自记录字段而不是拼好的句子', () => {
    const records = readFaultRecords(faults)
    expect(records).toHaveLength(5)
    const items = records.map(item => faultEntry(item) as unknown as FakeElement)
    for (const [index, item] of items.entries()) {
      const columns = faultColumns(records[index])
      for (const column of FAULT_COLUMNS) {
        expect(cell(item, column.key)?.textContent).toBe(columns[column.key] || '—')
      }
      expect(cell(item, 'when')?.tagName).toBe('time')
      expect(cell(item, 'when')?.attributes.get('datetime')).toBe(records[index].at)
    }
    // 没试过什么就是空位，⛔ 拿上一条的动作顶上
    expect(cell(items[1], 'tried')?.textContent).toBe('—')
    expect(cell(items[1], 'outcome')?.textContent).toBe('—')
    expect(cell(items[0], 'tried')?.textContent).toBe('重新测试')
    expect(cell(items[0], 'outcome')?.textContent).toBe('仍有问题')
    expect(cell(items[2], 'outcome')?.textContent).toBe('已恢复')
    expect(cell(items[0], 'category')?.textContent).toContain('key_rejected')
    expect(cell(items[1], 'software')?.textContent).toBe('工具箱')
    expect(cell(items[2], 'software')?.textContent).toBe('Claude Code/moonshot')
  })

  it('模板说明单独一列并带上参数，⛔ 混进类别列', () => {
    const item = faultEntry(readFaultRecords(faults)[3]) as unknown as FakeElement
    expect(cell(item, 'note')?.textContent).toBe('通道中断时打断了 3 条回答')
    expect(cell(item, 'category')?.textContent).not.toContain('打断')
  })

  it('表头就是那五列，读屏靠每条自己的说明所以表头隐藏', () => {
    const head = faultListHead() as unknown as FakeElement
    expect(head.children.map(child => child.textContent)).toEqual(['时间', '软件', '类别', '试过什么', '结果'])
    expect(head.attributes.get('aria-hidden')).toBe('true')
    const item = faultEntry(readFaultRecords(faults)[0]) as unknown as FakeElement
    for (const column of FAULT_COLUMNS) expect(item.attributes.get('aria-label')).toContain(`${column.label}：`)
  })

  it('只吃结构化记录：诊断文本、非数组与字段不合清单的条目都进不了界面', () => {
    expect(readFaultRecords('【最近故障与已试过的处理】\n- 2026/9/12 09:10:00 · Codex · key_rejected：Key 未通过认证。')).toEqual([])
    expect(readFaultRecords(undefined)).toEqual([])
    expect(readFaultRecords([{ at: '不是时间' }, '不是对象', null, { version: '0.4.9' }])).toEqual([])
    // 清单外的字段不带上屏，整条仍然可用
    expect(readFaultRecords([{ ...faults[0], shell: 'evil', note: '客户问：帮我写一封辞职信' }])[0])
      .toEqual({ at: faults[0].at, version: '0.4.9', provider: 'deepseek', code: 'key_rejected', action: 'retest', outcome: 'still_failing' })
  })

  it('最多 5 条，多的不上屏', () => {
    expect(readFaultRecords([...faults, ...faults])).toHaveLength(5)
    expect(readFaultRecords(faults, 2)).toHaveLength(2)
  })
})

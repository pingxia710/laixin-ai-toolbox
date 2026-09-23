// 甲-6 返工:桥层兜底(ACTION_FAILED)的本机故障要分得清「哪个模块、哪个动作」。
// 基线(36315e5)的毛病:任何模块的动作失败一律记 AI_DIAG_TUNNEL_ACTION_FAILED +「通道动作在本机
// 没能完成」——账号登录抛 TypeError 也被客服和数据当成网络问题。
// 隐私边界不变(甲-6):参数只进受控枚举/受控形状(模块名、「错误名:fs码」),⛔ 原始消息与路径。
import { describe, expect, it } from 'vitest'
import { ActionRegistry } from '../../app/main/bridge/action-registry'
import { actionLocalFault } from '../../app/main/bridge/local-fault'
import { schema } from '../../app/main/bridge/schema'
import { FaultLog } from '../../app/main/diagnostics/fault-log'
import { faultNoteText, sanitizeFaultRecord } from '../../app/shared/fault-log-types'

const NOW = '2026-09-17T00:00:00.000Z'
// 带路径的原始消息:钉死它进不了记录(甲-6 的形状用例同款现场)。
const fsError = Object.assign(new Error("ENOENT: open '/Users/laixin/secret/config.json'"), { code: 'ENOENT' })
const typeError = new TypeError('x is not a function')

describe('桥层动作失败按模块/动作归类(甲-6 返工)', () => {
  it('非网络模块(account)动作失败:⛔ 不带网络码,记模块+动作维度', () => {
    const fault = actionLocalFault('ACTION_FAILED', 'account.snapshot', typeError)
    expect(fault).toBeDefined()
    // 基线毛病就在这一条:账号模块的失败被记成网络码
    expect(fault?.network).toBeUndefined()
    expect(fault?.note).toBe('action_local_fault')
    expect(fault?.bridgeAction).toBe('account.snapshot')
    expect(fault?.noteParams?.[0]).toBe('account')
    expect(fault?.noteParams?.[1]).toBe('TypeError')
  })

  it('通道动作失败照旧记通道码 + tunnel_local_fault(网络路径一字不动)', () => {
    const fault = actionLocalFault('ACTION_FAILED', 'tunnel.start', fsError)
    expect(fault).toBeDefined()
    expect(fault?.network).toBe('AI_DIAG_TUNNEL_ACTION_FAILED')
    expect(fault?.note).toBe('tunnel_local_fault')
    expect(fault?.noteParams).toEqual(['Error:ENOENT'])
  })

  it('网络诊断模块前缀超参数闸,记短名 netdiag;动作维度仍是全名', () => {
    const fault = actionLocalFault('ACTION_FAILED', 'networkdiagnostics.run', typeError)
    expect(fault?.network).toBeUndefined()
    expect(fault?.noteParams?.[0]).toBe('netdiag')
    expect(fault?.bridgeAction).toBe('networkdiagnostics.run')
  })

  it('不是 ACTION_FAILED 或没有原始错误,不记故障(ACTION_RESULT_INVALID 维持甲-6 行为)', () => {
    expect(actionLocalFault('ACTION_RESULT_INVALID', 'app.info', undefined)).toBeUndefined()
    expect(actionLocalFault('SHUTDOWN_TIMEOUT', 'desktop', undefined)).toBeUndefined()
    expect(actionLocalFault('ACTION_FAILED', 'app.info', undefined)).toBeUndefined()
  })

  it('清洗形状:新模板与新字段过白名单,渲染成人话;路径与原始消息进不了记录', () => {
    const fault = actionLocalFault('ACTION_FAILED', 'aiaccess.testProvider', fsError)
    const record = sanitizeFaultRecord({ at: NOW, version: '9.9.9-test', ...(fault ?? {}) })
    expect(record).toBeDefined()
    expect(record?.bridgeAction).toBe('aiaccess.testProvider')
    expect(record?.note).toBe('action_local_fault')
    expect(record?.noteParams).toEqual(['aiaccess', 'Error:ENOENT'])
    expect(record?.network).toBeUndefined()
    const text = faultNoteText('action_local_fault', record?.noteParams ?? [])
    expect(text).toContain('aiaccess')
    expect(text).toContain('Error:ENOENT')
    // ⛔ 原始消息(带路径)出境:整条记录的 JSON 里不许出现
    const json = JSON.stringify(record)
    expect(json).not.toContain('/Users/laixin')
    expect(json).not.toContain('open')
  })

  it('去重签名带动作维度:同模块两个不同动作先后失败,两条都留(⛔ 在窗口里互相顶掉)', async () => {
    const lines: string[] = []
    const memory = {
      list: async () => ['2026-09-17.jsonl'],
      read: async () => lines.join('\n'),
      write: async (_: string, contents: string) => { lines.splice(0, lines.length, ...contents.split('\n').filter((l) => l !== '')) },
      append: async (_: string, line: string) => { lines.push(line) },
      remove: async () => undefined
    }
    const log = new FaultLog({ files: memory, version: () => '9.9.9-test', now: () => Date.parse(NOW) })
    await log.record(actionLocalFault('ACTION_FAILED', 'account.snapshot', typeError)!)
    await log.record(actionLocalFault('ACTION_FAILED', 'account.sessions', typeError)!)
    await log.record(actionLocalFault('ACTION_FAILED', 'tunnel.start', fsError)!)
    expect(lines).toHaveLength(3)
    const parsed = lines.map((line) => JSON.parse(line) as { bridgeAction?: string })
    expect(parsed.map((record) => record.bridgeAction)).toEqual(['account.snapshot', 'account.sessions', undefined])
  })

  it('桥层兜底接线:registry 把动作名+原始错误交出来,归类后各归各码', async () => {
    let captured: { code: string; name: string; error: unknown } | undefined
    const registry = new ActionRegistry({ diagnostic: (code, name, error) => { captured = { code, name, error } } })
    registry.registerAction({ name: 'account.redeemInviteRewards', paramsSchema: schema.undefined(), resultSchema: schema.undefined(),
      handler: () => { throw typeError } })
    registry.registerAction({ name: 'tunnel.stop', paramsSchema: schema.undefined(), resultSchema: schema.undefined(),
      handler: () => { throw fsError } })

    await expect(registry.execute('account.redeemInviteRewards', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(captured?.code).toBe('ACTION_FAILED')
    const accountFault = actionLocalFault(captured!.code, captured!.name, captured!.error)
    expect(accountFault?.network).toBeUndefined()
    expect(accountFault?.bridgeAction).toBe('account.redeemInviteRewards')

    await expect(registry.execute('tunnel.stop', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    const tunnelFault = actionLocalFault(captured!.code, captured!.name, captured!.error)
    expect(tunnelFault?.network).toBe('AI_DIAG_TUNNEL_ACTION_FAILED')
    expect(tunnelFault?.bridgeAction).toBeUndefined()
  })
})

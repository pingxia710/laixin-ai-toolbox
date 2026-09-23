import { describe, expect, it, vi } from 'vitest'
import { ActionRegistry, BridgeError } from '../../app/main/bridge/action-registry'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { schema } from '../../app/main/bridge/schema'
import { registerDiscoveredActions } from '../../app/main/bridge/action-loader'

describe('受限动作注册表', () => {
  it('只执行已登记、参数和返回均合规的动作', async () => {
    const registry = new BridgeRegistry()
    registry.registerAction({
      name: 'app.echo',
      paramsSchema: schema.object({ text: schema.string({ maxLength: 3 }) }),
      resultSchema: schema.object({ text: schema.string({ maxLength: 3 }) }),
      handler: (params) => ({ text: (params as { readonly text: string }).text })
    })

    await expect(registry.execute('app.echo', { text: '好' })).resolves.toEqual({ text: '好' })
    await expect(registry.execute('missing.action', {})).rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' })
    await expect(registry.execute('app.echo', { text: '过长文本' })).rejects.toMatchObject({
      code: 'ACTION_PARAMS_INVALID'
    })
  })

  it('拒绝不合 schema 的返回，且诊断不含原始参数或异常', async () => {
    const diagnostic = vi.fn()
    const registry = new ActionRegistry({ diagnostic })
    registry.registerAction({
      name: 'app.bad-result',
      paramsSchema: schema.undefined(),
      resultSchema: schema.object({ ok: schema.boolean() }),
      handler: () => ({ ok: '不是布尔值' })
    })

    await expect(registry.execute('app.bad-result', undefined)).rejects.toMatchObject({
      code: 'ACTION_RESULT_INVALID'
    })
    // 诊断要说清「哪个字段、怎么不合」——只丢一个动作名，接手的人只能靠猜（真撞上过：
    // 组件清单变长把某个 message 顶出上限，两个窗口都在猜是哪个字段）。
    expect(diagnostic).toHaveBeenCalledWith('ACTION_RESULT_INVALID', expect.stringContaining('app.bad-result'))
    const detail = String((diagnostic.mock.calls[0] as [string, string])[1])
    expect(detail).toContain('ok')       // 哪个字段
    expect(detail).toContain('boolean')  // 本该是什么
    // 但 ⛔ 把原始值带进诊断:那可能是客户数据
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('不是布尔值')
  })

  it('业务异常只回受控错误码，不把异常正文带到桥上', async () => {
    const diagnostic = vi.fn()
    const registry = new ActionRegistry({ diagnostic })
    registry.registerAction({
      name: 'app.fails',
      paramsSchema: schema.undefined(),
      resultSchema: schema.undefined(),
      handler: () => {
        throw new Error('参数和内部异常都不能外泄')
      }
    })

    await expect(registry.execute('app.fails', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    // 甲-6:兜底仍只回受控码到桥上(上面那行钉着),但原始错误要交到诊断通道留证——
    // 之前 catch 不接收 error,唯一诊断进 console.error(打包 GUI 蒸发),本地故障记录里查不到真因。
    expect(diagnostic).toHaveBeenCalledWith('ACTION_FAILED', 'app.fails', expect.any(Error))
    const carried = diagnostic.mock.calls[0]?.[2]
    expect(carried).toBeInstanceOf(Error)
    // 桥上抛出的仍是裸码,⛔ 异常正文进客户可见面
    const thrown = await registry.execute('app.fails', undefined).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ code: 'ACTION_FAILED', message: 'ACTION_FAILED' })
  })

  it('拒绝重复动作名', () => {
    const registry = new ActionRegistry()
    const action = {
      name: 'app.info',
      paramsSchema: schema.undefined(),
      resultSchema: schema.object({ ok: schema.boolean() }),
      handler: () => ({ ok: true })
    }

    registry.registerAction(action)
    expect(() => registry.registerAction(action)).toThrow('ACTION_ALREADY_REGISTERED')
  })

  it('自动加载动作时拒绝无效模块', () => {
    const registry = new BridgeRegistry()
    expect(() =>
      registerDiscoveredActions(registry, {
        './bad.ts': {}
      })
    ).toThrow(BridgeError)
  })
})

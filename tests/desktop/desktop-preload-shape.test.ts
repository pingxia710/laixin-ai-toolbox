// preload 的 desktop 命名空间：读回来的形状必须和桥上真正返回的形状对得上。
//
// 这一条是照着真实缺陷补的：桥上大部分 desktop 动作返回 { snapshot: JSON 字符串 }，
// 所以 preload 有个 read() 帮忙 JSON.parse；但 loginItem / setLoginItem（以及新加的
// residentEnabled / setResidentEnabled）返回的是普通对象 { enabled, supported }，
// 走 read() 就变成 JSON.parse(undefined) —— 每次都抛。设置页把它 catch 住显示
// 「暂时无法读取…状态」，开关一直是灰的，客户永远开不了，**而且不报任何错**。
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('electron', () => ({ ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args) as unknown, on: () => undefined, removeListener: () => undefined } }))

afterEach(() => { invoke.mockReset() })

describe('desktop preload 取值形状', () => {
  it('开关类动作直接拿对象，⛔ 当成 { snapshot } 去解析', async () => {
    const { api } = await import('../../app/preload/api/desktop')
    for (const [method, params, call] of [
      // 读:无参(桥上 paramsSchema 就是 undefined);写:带 { enabled }
      ['desktop.loginItem', undefined, () => api.loginItem()],
      ['desktop.residentEnabled', undefined, () => api.residentEnabled()],
      ['desktop.setLoginItem', { enabled: true }, () => api.setLoginItem({ enabled: true })],
      ['desktop.setResidentEnabled', { enabled: true }, () => api.setResidentEnabled({ enabled: true })]
    ] as const) {
      // 桥上真正会返回的东西（app/main/desktop/bridge.ts 的 loginItemSchema）
      invoke.mockResolvedValueOnce({ enabled: true, supported: true })
      await expect(call(), `${method} 应当原样拿到对象`).resolves.toEqual({ enabled: true, supported: true })
      expect(invoke).toHaveBeenLastCalledWith('toolbox:action', method, params)
    }
  })

  it('快照类动作照旧走 JSON 解析（⛔ 顺手把它们也改直通）', async () => {
    const { api } = await import('../../app/preload/api/desktop')
    invoke.mockResolvedValueOnce({ snapshot: JSON.stringify({ state: 'current', version: '0.5.0' }) })
    await expect(api.checkUpdate()).resolves.toMatchObject({ state: 'current', version: '0.5.0' })
  })
})

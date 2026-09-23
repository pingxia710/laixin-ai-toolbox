// 设置页开关「工具箱意外退出时，网络不断」（0.5.0）。
// 它控制的是：工具箱不在的时候，系统要不要把网络守护拉起来。两个方向不对称——
// 打开只记选择（真正装上归主进程的连接路径），关掉要**当场**把已装的撤掉。
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {} }))
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerDesktopActions } from '../../app/main/desktop/bridge'
import type { DesktopRuntime } from '../../app/main/desktop/runtime'
import {
  RESIDENT_DEFAULT_ENABLED, applyResidentChoice, residentToggleStatus, setResidentEnabled,
  type ResidentController, type ResidentPreference
} from '../../app/main/desktop/resident-preference'

function preference(initial?: boolean): ResidentPreference & { value: boolean | undefined } {
  const store = { value: initial } as { value: boolean | undefined }
  return {
    get value() { return store.value },
    set value(next: boolean | undefined) { store.value = next },
    read: () => store.value ?? RESIDENT_DEFAULT_ENABLED,
    write: (enabled: boolean) => { store.value = enabled }
  }
}

// installed = 盘上还有没有残留(卸载确认用);loaded = 此刻真的武装着(给客户看的 active 用)。
// 两者可以不一致:描述文件在、但被 bootout 过 ⇒ installed 真、loaded 假。
function controller(options: { installed?: boolean; loaded?: boolean; uninstallFails?: boolean; stubborn?: boolean } = {}) {
  const state = { installed: options.installed ?? true, loaded: options.loaded ?? options.installed ?? true, uninstalls: 0 }
  const api: ResidentController = {
    installed: async () => state.installed,
    loaded: async () => state.loaded,
    uninstall: async () => {
      state.uninstalls += 1
      if (options.uninstallFails) throw new Error('权限不足')
      if (!options.stubborn) { state.installed = false; state.loaded = false }
    }
  }
  return { api, state }
}

describe('常驻开关', () => {
  it('关掉时当场把已装的常驻撤掉，撤干净了才记下客户的选择', async () => {
    const store = preference(true)
    const resident = controller({ installed: true })

    expect(await setResidentEnabled(store, resident.api, false, true)).toEqual({ enabled: false, supported: true, active: false, staleResidentTask: false })

    expect(resident.state.uninstalls).toBe(1)
    expect(resident.state.installed).toBe(false)
    expect(store.value).toBe(false)
  })

  it('撤不掉就如实说「没生效」，⛔ 把选择记成已关闭', async () => {
    // 记下来但没撤掉 = 开关显示关着、常驻其实还在，下次开机网络照旧自己连上，客户会觉得关了个寂寞。
    for (const broken of [controller({ uninstallFails: true }), controller({ stubborn: true })]) {
      const store = preference(true)
      expect(await setResidentEnabled(store, broken.api, false, true)).toMatchObject({ enabled: true, supported: false })
      expect(store.value).toBe(true)
    }
  })

  it('打开只记选择，⛔ 在这里装常驻（守护要用什么参数起，只有连接那条路知道）', async () => {
    const store = preference(false)
    const resident = controller({ installed: false })

    // 这一刻常驻还没装上(装在主进程的校准那一步),所以 active 如实是 false
    expect(await setResidentEnabled(store, resident.api, true, true)).toEqual({ enabled: true, supported: true, active: false, staleResidentTask: false })

    expect(store.value).toBe(true)
    expect(resident.state.uninstalls).toBe(0)
  })

  it('这台机器用不了（开发态没有常驻可装）：开关置灰，读写都如实报不支持', async () => {
    const store = preference(true)
    const resident = controller()
    expect(await residentToggleStatus(store, resident.api, false)).toEqual({ enabled: false, supported: false, active: false, staleResidentTask: false })
    expect(await setResidentEnabled(store, resident.api, false, false)).toEqual({ enabled: false, supported: false, active: false, staleResidentTask: false })
    expect(resident.state.uninstalls).toBe(0)
    expect(store.value).toBe(true)
  })

  it('客户没选过时用的是那一个默认常量（默认值是产品取舍，改一行即可）', async () => {
    const armed = controller({ installed: true, loaded: true }).api
    expect(await residentToggleStatus(preference(undefined), armed, true)).toMatchObject({ enabled: RESIDENT_DEFAULT_ENABLED })
    expect(await residentToggleStatus(preference(!RESIDENT_DEFAULT_ENABLED), armed, true)).toMatchObject({ enabled: !RESIDENT_DEFAULT_ENABLED })
  })

  it('桥上读写两个动作都在，参数与结果形状固定', async () => {
    const registry = new BridgeRegistry()
    const calls: boolean[] = []
    registerDesktopActions(registry, {
      residentEnabled: async () => ({ enabled: true, supported: true, active: true, staleResidentTask: false }),
      setResidentEnabled: async (enabled: boolean) => { calls.push(enabled); return { enabled, supported: true, active: enabled, staleResidentTask: false } },
      loginItem: () => ({ enabled: false, supported: true }),
      setLoginItem: () => ({ enabled: false, supported: true }),
      ready: async () => undefined, status: async () => ({}), launcher: { list: () => [], open: () => ({ opened: false, message: '' }) },
      checkUpdate: async () => ({}), updater: { download: async () => ({}), install: async () => ({}) }, configure: async () => ({})
    } as unknown as DesktopRuntime)

    expect(await registry.execute('desktop.residentEnabled', undefined)).toEqual({ enabled: true, supported: true, active: true, staleResidentTask: false })
    expect(await registry.execute('desktop.setResidentEnabled', { enabled: false })).toEqual({ enabled: false, supported: true, active: false, staleResidentTask: false })
    expect(calls).toEqual([false])
    await expect(registry.execute('desktop.setResidentEnabled', { enabled: 'yes' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })
})

describe('常驻此刻到底武装着没有（给客户看的 active）', () => {
  const store = () => preference(true)

  it('客户选了开、但常驻没武装 → active 为假（设置页据此说「这次没生效」）', async () => {
    // 来路一：这次就没装上（目录不可写、系统限制）
    const failed = controller({ installed: false, loaded: false })
    expect(await residentToggleStatus(store(), failed.api, true)).toEqual({ enabled: true, supported: true, active: false, staleResidentTask: false })

    // 来路二：装过，但描述文件被外力弄掉了（客户手工删、清理软件扫走）
    const wiped = controller({ installed: true, loaded: true })
    expect(await residentToggleStatus(store(), wiped.api, true)).toMatchObject({ active: true }) // 正向证据：本来是武装着的
    wiped.state.installed = false; wiped.state.loaded = false
    expect(await residentToggleStatus(store(), wiped.api, true)).toMatchObject({ enabled: true, active: false })
  })

  it('描述文件还在、但没被系统加载 → active 必须是假（⛔ 拿「残留判据」去答，那是一句假承诺）', async () => {
    // 这一态真实存在：更新换 bundle 前助手 bootout 过、或 bootstrap 失败。
    // 此刻系统并不会在工具箱崩掉后拉起守护，拿 installed()(plist 在就算) 去答就是骗客户。
    const bootedOut = controller({ installed: true, loaded: false })
    expect(await bootedOut.api.installed()).toBe(true) // 正向证据：残留判据确实说「还在」
    expect(await residentToggleStatus(store(), bootedOut.api, true)).toMatchObject({ enabled: true, active: false })
  })

  it('问不出来按「没武装」报，⛔ 报成功', async () => {
    const broken: ResidentController = {
      installed: async () => true,
      loaded: async () => { throw new Error('launchctl 不可用') },
      uninstall: async () => undefined
    }
    expect(await residentToggleStatus(store(), broken, true)).toMatchObject({ enabled: true, active: false })
  })

  it('客户就没选开：active 一律为假，⛔ 去问系统（没选开就谈不上武装）', async () => {
    const resident = controller({ installed: true, loaded: true })
    let asked = 0
    const counted: ResidentController = { ...resident.api, loaded: async () => { asked += 1; return true } }
    expect(await residentToggleStatus(preference(false), counted, true)).toEqual({ enabled: false, supported: true, active: false, staleResidentTask: false })
    expect(asked).toBe(0)
  })
})

describe('拨开关的完整一次：记选择 → 校准 → 重读', () => {
  it('校准之后必须重读，⛔ 把「装之前」的快照回给界面', async () => {
    const store = preference(false)
    const resident = controller({ installed: false, loaded: false })
    const order: string[] = []
    // 校准 = 主进程那一侧真正去装;装成功后系统里就武装着了
    const calibrate = async (enabled: boolean) => {
      order.push(`calibrate:${String(enabled)}`)
      if (enabled) { resident.state.installed = true; resident.state.loaded = true }
    }

    const status = await applyResidentChoice(store, resident.api, true, true, calibrate)

    // 装上了 ⇒ 回给界面的必须是「已生效」。不重读的话这里会是 false，客户会看到一句
    // 「这次没能生效」，而它其实刚刚装好了 —— 反过来也一样会骗人。
    expect(status).toEqual({ enabled: true, supported: true, active: true, staleResidentTask: false })
    expect(order).toEqual(['calibrate:true']) // 正向证据：校准确实跑了，且只跑一次
    expect(store.value).toBe(true)
  })

  it('校准装不上：如实回 active 假，⛔ 抛异常、⛔ 把客户的选择撤销', async () => {
    const store = preference(false)
    const resident = controller({ installed: false, loaded: false })
    const calibrate = async () => { throw new Error('目录不可写') }

    const status = await applyResidentChoice(store, resident.api, true, true, calibrate)

    expect(status).toEqual({ enabled: true, supported: true, active: false, staleResidentTask: false })
    expect(store.value).toBe(true) // 选择留着：下次打开工具箱的启动校准还会再试
  })

  it('这台机器用不了：⛔ 去校准', async () => {
    const store = preference(true)
    const resident = controller()
    let calibrated = 0
    const status = await applyResidentChoice(store, resident.api, true, false, async () => { calibrated += 1 })
    expect(status).toEqual({ enabled: false, supported: false, active: false, staleResidentTask: false })
    expect(calibrated).toBe(0)
  })
})

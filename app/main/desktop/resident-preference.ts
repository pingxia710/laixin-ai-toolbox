/** 「工具箱意外退出时，网络不断」的开关（0.5.0）。
 *
 * 开关控制的是：要不要让系统在工具箱不在的时候，也把网络守护拉起来。它解决的是**意外**——
 * 崩溃、被系统或安全软件关掉、开机后客户还没打开工具箱；⛔ 客户主动「退出工具箱」，
 * 那条路仍然按托盘上写的断网并完整还原（那是客户明示的意愿，语义一个字不改）。
 *
 * 两个方向不对称，⛔ 做成「一次写入就完事」：
 *  · 打开 = 记下客户的选择，随后由桌面片调 calibrateResident 当场装上（⛔ 让客户等到下次重连；
 *    此刻正连着也照装，当前连接不断）。这里不自己装：只有通道片知道守护要用什么可执行文件、
 *    什么参数起，这边硬装会装出一份参数不对的。
 *  · 关掉 = **当场**把已经装上的常驻撤掉，⛔ 等下次连接。撤的只是「以后自动拉起」这件事，
 *    ⛔ 动此刻正连着的网络：客户关的是「我不在时还连着」，不是「现在断开」。
 *
 * 写完一律回读确认。撤不掉就如实降级为「不支持」，由设置页显示真实状态并让客户重试，
 * ⛔ 假装成功——那会变成「开关显示关着、常驻其实还在」，下次开机网络照旧自己连上。
 */
import { existsSync } from 'node:fs'
import {
  RESIDENT_LABEL, macAgentPath, macResidentLoaded, uninstallMacResident, uninstallWinResident, winResidentArmed, winResidentResidue
} from '../tunnel/platform/resident'

/** 客户还没选过时用的默认值。**这是产品取舍，不是技术裁决**——创始人拍了改这一行，其余代码不用动。 */
export const RESIDENT_DEFAULT_ENABLED = true

/** 客户的选择存在哪里由调用方决定（现在跟其余设置项同处一个偏好文件）。 */
export interface ResidentPreference {
  read(): boolean
  write(enabled: boolean): void
}

/** 常驻项本身。装由主进程的连接路径负责，这里只管「在不在」「武装着没有」与「撤掉」。
 *  **两个判据 ⛔ 混用**（它们在「描述文件在、但没被系统加载」这一态上答案相反）：
 *   · `installed()` = 还有没有**残留**（mac：plist 在 ‖ 已加载；win：新旧任务路径任一还在）。
 *     卸载确认用它——任何一样还在都算没卸干净。
 *   · `loaded()`    = 此刻**真的武装着**（mac：已加载；win：任务在且未被禁用，见 winResidentArmed）。
 *     给客户看的 `active` 用它——plist 在而没加载（被 bootout 过、bootstrap 失败、更新换完 bundle
 *     还没走到启动校准）时，系统此刻并不会在工具箱崩掉后把守护拉起来；任务在却停用/残破同理。
 *     拿 `installed()` 去答就是给客户一句假承诺（2026-09-14 真机第 8 条：「任务在、active:true、
 *     而守护永远不会被拉起」就是这么造出来的）。 */
export interface ResidentController {
  installed(): Promise<boolean>
  loaded(): Promise<boolean>
  uninstall(): Promise<void>
}

export interface ResidentToggleStatus {
  /** 开关该显示在哪一档 = 客户的选择。 */
  enabled: boolean
  /** 这台机器上这个开关能不能用；false 时设置页置灰并说明，⛔ 让客户点了没反应。 */
  supported: boolean
  /** 常驻此刻真的武装着。`enabled && !active` = 客户选了开、但这次没生效 ——
   *  设置页必须把这一态说出来：开关显示着开而那件事并没有发生，就是假装成功。
   *  ⛔ 因此把开关拨回去（那是替客户改了他的选择），也 ⛔ 弹窗（网络本身好好的）。 */
  active: boolean
}

export async function residentToggleStatus(
  preference: ResidentPreference,
  controller: ResidentController,
  supported: boolean
): Promise<ResidentToggleStatus> {
  if (!supported) return { enabled: false, supported: false, active: false }
  let enabled: boolean
  try { enabled = preference.read() } catch { return { enabled: false, supported: false, active: false } }
  // 没选开就谈不上武装;选了开才去问系统「此刻到底武装着没有」(⛔ 拿内存缓存当事实:
  // 客户手工删掉描述文件、清理软件扫走,缓存不会知道,读盘会)。问不出来按「没武装」报,⛔ 报成功。
  const active = enabled ? await controller.loaded().catch(() => false) : false
  return { enabled, supported: true, active }
}

export async function setResidentEnabled(
  preference: ResidentPreference,
  controller: ResidentController,
  enabled: boolean,
  supported: boolean
): Promise<ResidentToggleStatus> {
  if (!supported) return { enabled: false, supported: false, active: false }
  const fallback = async (): Promise<ResidentToggleStatus> => {
    const active = await controller.loaded().catch(() => false)
    try { return { enabled: preference.read(), supported: false, active } } catch { return { enabled: false, supported: false, active } }
  }
  if (!enabled) {
    // 先撤、回读确认撤干净了，才记下选择。顺序反了就会出现「开关关着、常驻还在」。
    try {
      await controller.uninstall()
      // 卸载确认用 installed()(任何残留都算没卸干净),⛔ 用 loaded()——plist 留在盘上、
      // 只是此刻没加载,下次登录它照样会回来,那不叫卸掉了。
      if (await controller.installed()) return fallback()
    } catch { return fallback() }
  }
  try {
    preference.write(enabled)
    return { enabled: preference.read(), supported: true, active: await controller.loaded().catch(() => false) }
  } catch { return fallback() }
}

/**
 * 客户拨开关的完整一次：记下选择 → 当场校准（装 / 卸）→ **重新读一次**再回给界面。
 * 三步的顺序是硬的：
 *  · 校准必须在记下选择之后（校准读的就是这个选择）；
 *  · **必须重读**——`setResidentEnabled` 返回的 `active` 是「校准之前」的，直接回给界面
 *    等于告诉客户一件还没发生的事（客户刚打开开关，装没装上就在这一瞬间决定）。
 * 校准失败 ⛔ 抛：装不上不是客户的错，也 ⛔ 因此不给他连网——重读会如实把 `active: false` 带回去，
 * 界面据此说「这次没能生效」。
 */
export async function applyResidentChoice(
  preference: ResidentPreference,
  controller: ResidentController,
  enabled: boolean,
  supported: boolean,
  calibrate: (enabled: boolean) => Promise<unknown>
): Promise<ResidentToggleStatus> {
  const status = await setResidentEnabled(preference, controller, enabled, supported)
  if (!status.supported) return status
  await calibrate(status.enabled).catch(() => undefined)
  return residentToggleStatus(preference, controller, supported)
}

/** 真机上的常驻项。mac = LaunchAgent（描述文件在就算装着：没加载也会在下次登录加载）；Windows = 登录计划任务。
 *  Windows 的 loaded() 走 winResidentArmed（任务在且未停用才算武装），与 installed()（任一路径有残留）分开——
 *  ⛔ 因为「任务在」不等于「会拉起」，混用就是 2026-09-14 真机第 8 条那个假承诺。 */
export function systemResidentController(platform: NodeJS.Platform | string = process.platform): ResidentController {
  if (platform === 'win32') {
    return {
      installed: winResidentResidue,
      loaded: winResidentArmed,
      uninstall: () => uninstallWinResident()
    }
  }
  return {
    installed: async () => existsSync(macAgentPath(RESIDENT_LABEL)) || await macResidentLoaded(),
    loaded: () => macResidentLoaded(),
    uninstall: () => uninstallMacResident()
  }
}

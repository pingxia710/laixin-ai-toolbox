/** 开机自启登录项:读写系统登录项并回读确认;不可用(未打包、系统拒绝)时
 * 如实降级为「不支持」,由设置页显示真实状态,不假装成功。 */
export interface LoginItemController {
  get(): { openAtLogin: boolean }
  set(options: { openAtLogin: boolean }): void
}
export interface LoginItemStatus { enabled: boolean; supported: boolean }

export function loginItemStatus(controller: LoginItemController): LoginItemStatus {
  try {
    return { enabled: controller.get().openAtLogin === true, supported: true }
  } catch {
    return { enabled: false, supported: false }
  }
}

export function setLoginItem(controller: LoginItemController, enabled: boolean): LoginItemStatus {
  try {
    controller.set({ openAtLogin: enabled })
  } catch {
    return { enabled: false, supported: false }
  }
  const status = loginItemStatus(controller)
  return enabled && !status.enabled ? { enabled: false, supported: false } : status
}

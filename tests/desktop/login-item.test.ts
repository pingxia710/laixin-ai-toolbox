import { describe, expect, it, vi } from 'vitest'
import { loginItemStatus, setLoginItem, type LoginItemController } from '../../app/main/desktop/login-item'

const controller = (get = { openAtLogin: false }): { api: LoginItemController; set: ReturnType<typeof vi.fn> } => {
  const set = vi.fn((options: { openAtLogin: boolean }) => { get.openAtLogin = options.openAtLogin })
  return { api: { get: () => get, set }, set }
}

describe('开机自启登录项', () => {
  it('读系统当前状态,未开启为 false', () => {
    expect(loginItemStatus(controller({ openAtLogin: true }).api)).toEqual({ enabled: true, supported: true })
    expect(loginItemStatus(controller().api)).toEqual({ enabled: false, supported: true })
  })

  it('读取失败(未打包等)如实报不支持', () => {
    const broken: LoginItemController = { get: () => { throw new Error('no') }, set: () => undefined }
    expect(loginItemStatus(broken)).toEqual({ enabled: false, supported: false })
  })

  it('开启与关闭都写入系统并回读确认', () => {
    const first = controller()
    expect(setLoginItem(first.api, true)).toEqual({ enabled: true, supported: true })
    expect(first.set).toHaveBeenCalledWith({ openAtLogin: true })
    expect(setLoginItem(first.api, false)).toEqual({ enabled: false, supported: true })
    expect(first.set).toHaveBeenLastCalledWith({ openAtLogin: false })
  })

  it('系统拒绝写入或写入未生效时报不支持,不假装成功', () => {
    const refusing: LoginItemController = { get: () => ({ openAtLogin: false }), set: () => { throw new Error('denied') } }
    expect(setLoginItem(refusing, true)).toEqual({ enabled: false, supported: false })
    const silent: LoginItemController = { get: () => ({ openAtLogin: false }), set: () => undefined }
    expect(setLoginItem(silent, true)).toEqual({ enabled: false, supported: false })
  })
})

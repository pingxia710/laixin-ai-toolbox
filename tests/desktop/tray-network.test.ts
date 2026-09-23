import { describe, expect, it } from 'vitest'
import { TRAY_NETWORK_OPERATION_INCOMPLETE, trayNetworkFailureMessage, trayNetworkPresentation } from '../../app/main/desktop/tray-network'

describe('菜单栏 AI网络控制', () => {
  it('已连、连接中和待确认状态只提供断开，不会由状态刷新重复连接', () => {
    for (const state of ['已连', '连接中', '通道待确认']) {
      expect(trayNetworkPresentation({ state, currentConfig: '版本 2', unrestored: '' }, false)).toEqual({
        statusLabel: `AI网络 · ${state}`, action: 'stop', actionLabel: '断开 AI网络', actionEnabled: true
      })
    }
  })

  it('暂停态恢复入口换「恢复」措辞，未配置或需要恢复时只打开状态页', () => {
    // N-26:已停止并恢复原设置 = 暂停落定,托盘恢复入口明说「恢复」。
    expect(trayNetworkPresentation({ state: '已停止并恢复原设置', currentConfig: '版本 2', unrestored: '' }, false)).toMatchObject({
      action: 'start', actionLabel: '恢复 AI网络'
    })
    expect(trayNetworkPresentation({ state: '未配置', currentConfig: '', unrestored: '' }, false)).toMatchObject({
      action: 'show', actionLabel: '打开 AI网络设置'
    })
    expect(trayNetworkPresentation({ state: '异常', currentConfig: '版本 2', unrestored: 'Wi-Fi/web-proxy:未恢复' }, false)).toMatchObject({
      action: 'show', actionLabel: '查看 AI网络状态'
    })
  })

  it('异常但仍保持已连接意图时可以从菜单栏断开，停止自动恢复', () => {
    expect(trayNetworkPresentation({ state: '异常', currentConfig: '版本 2', unrestored: '' }, false)).toEqual({
      statusLabel: 'AI网络 · 异常', action: 'stop', actionLabel: '断开 AI网络', actionEnabled: true
    })
  })

  it('暂停态托盘明说「已暂停使用」,恢复入口换「恢复」措辞(N-26 轻暂停)', () => {
    expect(trayNetworkPresentation({ state: '已停止并恢复原设置', currentConfig: '版本 2', unrestored: '' }, false)).toEqual({
      statusLabel: 'AI网络 · 已暂停使用', action: 'start', actionLabel: '恢复 AI网络', actionEnabled: true
    })
    expect(trayNetworkPresentation({ state: '用户主动断开', currentConfig: '版本 2', unrestored: '' }, false)).toEqual({
      statusLabel: 'AI网络 · 已暂停使用', action: 'start', actionLabel: '恢复 AI网络', actionEnabled: true
    })
  })

  it('动作执行中禁用重复操作，无法读到状态时不猜测连接状态', () => {
    expect(trayNetworkPresentation({ state: '已连', currentConfig: '版本 2', unrestored: '' }, true)).toMatchObject({
      action: 'stop', actionEnabled: false
    })
    expect(trayNetworkPresentation(undefined, false)).toEqual({
      statusLabel: 'AI网络 · 状态读取中', action: 'show', actionLabel: '查看 AI网络状态', actionEnabled: true
    })
  })

  it('正常被拒绝的连接结果保留为可见反馈，成功或畸形结果不误报', () => {
    expect(TRAY_NETWORK_OPERATION_INCOMPLETE).toContain('状态页')
    expect(trayNetworkFailureMessage({ outcome: 'rejected', message: '尚未导入配置包' })).toBe('尚未导入配置包')
    expect(trayNetworkFailureMessage({ outcome: 'started', message: '连接中' })).toBeUndefined()
    expect(trayNetworkFailureMessage({ outcome: 'rejected', message: 'x'.repeat(301) })).toBeUndefined()
  })
})

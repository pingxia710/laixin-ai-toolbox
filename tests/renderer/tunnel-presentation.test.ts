import { describe, expect, it } from 'vitest'
import { buildTunnelPresentation } from '../../app/renderer/src/pages/tunnel'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'

function status(partial: Partial<TunnelStatusView>): TunnelStatusView {
  return {
    currentConfig: '', pendingConfig: '', canApplyPending: false, state: '未配置', message: '', source: '', authorization: '', backend: '',
    nodeLabel: '', exitIp: '', pathSource: '' as const, lastVerifiedAt: '', configVersion: '', expiresAt: '', pendingAvailable: false, unrestored: '', componentMissing: '',
    ...partial
  }
}

describe('网络页状态呈现', () => {
  it('读取失败或加载中不把状态描绘成已连接', () => {
    expect(buildTunnelPresentation(undefined)).toMatchObject({ headline: '正在读取通道状态', tone: 'neutral', primaryAction: 'none' })
    expect(buildTunnelPresentation(status({ state: '未配置' }))).toMatchObject({ headline: '国外AI需要配置网络', primaryAction: 'guide', primaryLabel: '开始设置网络' })
  })

  it('只有 bridge 明确报告已连时才显示已连接和断开动作', () => {
    expect(buildTunnelPresentation(status({ state: '已连', currentConfig: '版本 1' }))).toMatchObject({ headline: '已连接', tone: 'positive', primaryAction: 'stop' })
    expect(buildTunnelPresentation(status({ state: '连接中', currentConfig: '版本 1' }))).toMatchObject({ headline: '正在连接', tone: 'warning', primaryAction: 'stop' })
  })

  it('异常与已停止状态都保留实际的下一步，不伪造权益或线路数据', () => {
    expect(buildTunnelPresentation(status({ state: '异常', currentConfig: '版本 1', message: '守护进程意外退出' }))).toMatchObject({ tone: 'danger', primaryAction: 'start' })
    expect(buildTunnelPresentation(status({ state: '已停止并恢复原设置', currentConfig: '' }))).toMatchObject({ primaryAction: 'import' })
  })
})

it('恢复失败优先显示恢复入口；不诱导重连，损坏账本指向客服', () => {
  expect(buildTunnelPresentation(status({ state: '异常', currentConfig: '版本 1', unrestored: 'Wi-Fi/socks-proxy:未恢复:失败' }))).toMatchObject({ primaryAction: 'stop', headline: '原设置尚未恢复' })
  expect(buildTunnelPresentation(status({ state: '异常', unrestored: '恢复记录损坏或无法读取' }))).toMatchObject({ primaryAction: 'support' })
  expect(buildTunnelPresentation(status({ state: '异常', authorization: '等待重新确认账号权益' }))).toMatchObject({ primaryAction: 'stop', headline: '通道已暂时暂停' })
})

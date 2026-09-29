import { describe, expect, it } from 'vitest'
import { buildTunnelPresentation } from '../../app/renderer/src/pages/tunnel'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'

function status(partial: Partial<TunnelStatusView>): TunnelStatusView {
  return {
    pauseReason: '',
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
    expect(buildTunnelPresentation(status({ state: '异常', currentConfig: '版本 1', message: '原网络设置已恢复，但后台通道未能停止' }))).toMatchObject({
      tone: 'danger', headline: '通道需要处理', primaryAction: 'repair', primaryLabel: '检测并修复连接'
    })
    expect(buildTunnelPresentation(status({ state: '已停止并恢复原设置', currentConfig: '' }))).toMatchObject({ primaryAction: 'import' })
  })

  it('后台拒绝导致的自主暂停明确说明权益原因，仍保留恢复入口', () => {
    const denied = status({
      state: '已停止并恢复原设置', currentConfig: '版本 1', pauseReason: 'entitlement-denied',
      message: '账号权益校验未通过，来信已暂停网络并恢复原设置。请到「我的账号」核对套餐、流量和有效期。'
    } as Partial<TunnelStatusView>)
    expect(buildTunnelPresentation(denied)).toMatchObject({
      tone: 'warning', headline: '权益校验未通过，网络已暂停',
      description: expect.stringContaining('我的账号'), primaryAction: 'start'
    })
    expect(buildTunnelPresentation(status({
      state: '用户主动断开', currentConfig: '版本 1', pauseReason: 'entitlement-denied',
      message: '后台权益校验未通过；守护未在运行，本次恢复完成状态尚未确认。'
    } as Partial<TunnelStatusView>))).toMatchObject({
      headline: '权益校验未通过，网络已暂停', description: expect.stringContaining('尚未确认'), primaryAction: 'start'
    })
    expect(buildTunnelPresentation(status({ state: '已停止并恢复原设置', currentConfig: '版本 1' }))).toMatchObject({
      tone: 'neutral', headline: '已暂停使用'
    })
  })

  it('断开意图在途只说正在恢复原设置，权益拒绝也不给立即恢复入口', () => {
    expect(buildTunnelPresentation(status({ state: '断开中', currentConfig: '版本 1' }))).toMatchObject({
      tone: 'warning', headline: '正在断开网络', primaryAction: 'none'
    })
    expect(buildTunnelPresentation(status({ state: '断开中', currentConfig: '版本 1',
      authorization: '等待重新确认账号权益', pauseReason: 'entitlement-denied' }))).toMatchObject({
      tone: 'warning', headline: '权益校验未通过，正在暂停网络', primaryAction: 'none'
    })
  })

  it.each([
    ['examining', '正在取证'], ['reusing', '正在复用'], ['taking-over', '正在接管'],
    ['reclaiming', '正在夺回'], ['recovering', '正在恢复'], ['recovered', '已恢复']
  ] as const)('N-55 控制器阶段 %s 稳定显示 %s，不能提前描绘成已连接', (availabilityStatus, headline) => {
    expect(buildTunnelPresentation(status({ state: '已连', availabilityStatus }))).toMatchObject({ headline })
  })

  it('N-55 无法安全自动处理只显示已证实原因，不泄露冲突对象或快照', () => {
    expect(buildTunnelPresentation(status({ state: '已连', availabilityStatus: 'limited',
      availabilityReason: '无法安全自动处理：设置写入后读回不一致' }))).toMatchObject({
      tone: 'danger', headline: '无法安全自动处理', primaryAction: 'support'
    })
  })

  it('N-55 接管失败后即使旧设置已恢复，也不以“已恢复”覆盖连接异常', () => {
    expect(buildTunnelPresentation(status({ state: '异常', availabilityStatus: 'recovered',
      availabilityReason: '无法安全自动处理：设置读回一致，但目标服务仍不可达' }))).toMatchObject({
      tone: 'danger', headline: '通道需要处理', hint: '无法安全自动处理：设置读回一致，但目标服务仍不可达'
    })
  })

  it('无当前连接动作的遗留 examining 不覆盖停止态或真实连接错误', () => {
    expect(buildTunnelPresentation(status({ state: '用户主动断开', availabilityStatus: '' }))).toMatchObject({
      headline: '已暂停使用'
    })
    expect(buildTunnelPresentation(status({ state: '异常', availabilityStatus: '', message: '连接端口被其他软件占用' }))).toMatchObject({
      headline: '通道需要处理', hint: '连接端口被其他软件占用'
    })
  })
})

it('恢复失败优先显示恢复入口；不诱导重连，损坏账本指向客服', () => {
  expect(buildTunnelPresentation(status({ state: '异常', currentConfig: '版本 1', unrestored: 'Wi-Fi/socks-proxy:未恢复:失败' }))).toMatchObject({ primaryAction: 'stop', headline: '原设置尚未恢复' })
  expect(buildTunnelPresentation(status({ state: '异常', unrestored: '恢复记录损坏或无法读取' }))).toMatchObject({ primaryAction: 'support' })
  expect(buildTunnelPresentation(status({ state: '异常', authorization: '等待重新确认账号权益' }))).toMatchObject({ primaryAction: 'stop', headline: '通道已暂时暂停' })
})

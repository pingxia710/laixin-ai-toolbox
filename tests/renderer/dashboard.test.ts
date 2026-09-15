import { describe, expect, it } from 'vitest'
import { apiKeyGuideEntries, buildDashboardView } from '../../app/renderer/src/pages/dashboard'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'

const connectedStatus: TunnelStatusView = {
  currentConfig: '', pendingConfig: '', canApplyPending: false,
  state: '已连',
  message: '出口已复验',
  source: '来源:来信配置包',
  authorization: '授权:本地包载明,未经后台确认',
  backend: '后台:未接入',
  nodeLabel: 'node-a',
  exitIp: '203.0.113.8',
  pathSource: 'laixin' as const,
  lastVerifiedAt: '2026-09-07 20:00',
  configVersion: '3',
  expiresAt: '未知',
  pendingAvailable: false,
  unrestored: '',
  componentMissing: ''
}

describe('仪表盘状态映射', () => {
  it('保留 API KEY 三个壳的整行接入引导，并按既定顺序展示', () => {
    expect(apiKeyGuideEntries).toEqual([
      { id: 'codex', label: 'Codex', description: '用自己的 API KEY 接入 Codex。' },
      { id: 'claude-code', label: 'Claude Code', description: '用自己的 API KEY 接入 Claude Code。' },
      { id: 'hermes', label: 'Hermes', description: '用自己的 API KEY 接入 Hermes。' }
    ])
  })

  it('读取中或读取失败不伪造网络成功、流量或账号数据', () => {
    expect(buildDashboardView({ kind: 'loading' })).toMatchObject({
      title: '正在读取当前状态',
      actionTab: 'tunnel',
      configVersion: '尚未取得'
    })
    expect(buildDashboardView({ kind: 'unavailable' })).toMatchObject({
      title: '暂时无法确认网络状态',
      actionTab: 'tunnel',
      lastVerifiedAt: '尚未取得'
    })
  })

  it('真实连接状态引导客户查看 Codex 的官方下载和版本信息', () => {
    expect(buildDashboardView({ kind: 'ready', status: connectedStatus })).toEqual({
      eyebrow: '网络状态',
      title: '网络已连接',
      description: '出口已复验',
      actionLabel: '查看 Codex 下载/版本',
      actionTab: 'usage',
      configVersion: '3',
      lastVerifiedAt: '2026-09-07 20:00'
    })
  })

  it('未配置时保留账号领取和来信配置包两个入口', () => {
    const view = buildDashboardView({
      kind: 'ready',
      status: { ...connectedStatus, state: '未配置', message: '', configVersion: '', lastVerifiedAt: '' }
    })
    expect(view).toMatchObject({
      title: '还没有配置网络',
      actionLabel: '前往配置网络',
      actionTab: 'tunnel',
      configVersion: '尚未应用'
    })
    expect(view.description).toContain('登录来信账号')
    expect(view.description).toContain('来信配置包')
  })
})

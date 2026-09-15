import { describe, expect, it } from 'vitest'
import type { AccountView } from '../../app/account-types'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'
import type { NetworkUsageView } from '../../app/shared/network-usage-types'
import { buildNetworkOnboarding } from '../../app/renderer/src/ui/network-onboarding'

const terms = { plans: [], toolbox: { id: 'toolbox', priceCents: 1990, subject: '来信 AI 工具箱' }, trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3 }
const signedOut: AccountView = { state: 'signed-out', account: null, overview: null, code: '', message: '', terms }
const account: AccountView = { ...signedOut, state: 'signed-in', account: { id: 'local-customer', username: '体验客户' }, overview: {
  trial: { available: true, usage: null }, recoveryReady: true, subscription: null, plans: [], networkAvailable: true, paymentChannels: []
} }
const status: TunnelStatusView = { state: '未配置', message: '', currentConfig: '', pendingConfig: '', canApplyPending: false,
  source: '', authorization: '', backend: '', nodeLabel: '', exitIp: '', pathSource: '' as const, lastVerifiedAt: '', configVersion: '', expiresAt: '',
  pendingAvailable: false, unrestored: '', componentMissing: '' }
const usage: NetworkUsageView = { authorizationId: 'local-authorization', kind: 'trial', planId: 'trial-5g', state: 'active',
  measurement: 'current', totalBytes: 5 * 1024 ** 3, usedBytes: 0, remainingBytes: 5 * 1024 ** 3, expiresAt: 1_800_000_000_000,
  observedAt: 1_799_900_000_000, reasonCode: '' }
const withTrial = (state: NetworkUsageView['state']): AccountView => ({ ...account, overview: { ...account.overview!, trial: { available: false, usage: { ...usage, state } } } })

describe('首次使用按真实状态给出下一步', () => {
  it('新用户直接去注册；登录不会自动领取或开始计时', () => {
    expect(buildNetworkOnboarding(signedOut, status)).toMatchObject({ step: 1, action: 'register' })
    expect(buildNetworkOnboarding(account, status)).toMatchObject({ step: 2, action: 'claim' })
    expect(buildNetworkOnboarding(account, status).description).toContain('领取时开始计时')
  })
  it('领取页写明一份配置最多 3 台设备同时使用、流量总额另计', () => {
    const claim = buildNetworkOnboarding(account, status)
    expect(claim).toMatchObject({ step: 2, action: 'claim' })
    expect(claim.description).toContain('一份配置最多 3 台设备同时使用')
    expect(claim.description).toContain('流量总额另计')
  })
  it('服务未配置与读取失败都不给领取或连接按钮', () => {
    expect(buildNetworkOnboarding({ ...signedOut, code: 'ACCOUNT_NOT_CONFIGURED' }, status).action).toBe('support')
    expect(buildNetworkOnboarding({ ...account, overview: { ...account.overview!, networkAvailable: false } }, status).action).toBe('refresh')
    expect(buildNetworkOnboarding({ ...account, overview: null }, status).action).toBe('refresh')
    expect(buildNetworkOnboarding(withTrial('active'), null).action).toBe('refresh')
    expect(buildNetworkOnboarding(withTrial('active'), undefined).action).toBe('none')
  })
  it('已领取但未拿到配置时先准备；拿到配置后才允许显式连接', () => {
    expect(buildNetworkOnboarding(withTrial('provisioning'), status).action).toBe('claim')
    expect(buildNetworkOnboarding(withTrial('active'), status)).toMatchObject({ step: 3, action: 'sync' })
    expect(buildNetworkOnboarding(withTrial('active'), { ...status, state: '用户主动断开', currentConfig: 'current' })).toMatchObject({ step: 3, action: 'start' })
    expect(buildNetworkOnboarding(withTrial('active'), { ...status, currentConfig: 'current', state: '连接中' }).action).toBe('none')
  })
  it('配置存在不等于已连，异常或原设置未恢复时不引导直接连接', () => {
    expect(buildNetworkOnboarding(withTrial('active'), { ...status, currentConfig: 'current', unrestored: '恢复未完成' }).action).toBe('tunnel')
    expect(buildNetworkOnboarding(withTrial('active'), { ...status, currentConfig: 'current', componentMissing: '缺少运行组件' }).action).toBe('tunnel')
    expect(buildNetworkOnboarding(withTrial('active'), { ...status, currentConfig: 'current', state: '异常' }).action).toBe('tunnel')
  })
  it.each(['expired', 'exhausted', 'disabled'] as const)('体验 %s 不能重新领取或凭旧配置直接连接', (state) => {
    expect(buildNetworkOnboarding(withTrial(state), { ...status, currentConfig: 'old' }).action).toBe('account')
  })
  it('未知权益先重查；已开通付费套餐不强迫再领体验', () => {
    expect(buildNetworkOnboarding(withTrial('unknown'), status).action).toBe('refresh')
    const paid = { ...account, overview: { ...account.overview!, subscription: { ...usage, kind: 'subscription' as const } } }
    expect(buildNetworkOnboarding(paid, status)).toMatchObject({ step: 3, action: 'sync' })
  })
  it.each([
    ['pending', '网络套餐申请待确认', '付款与开通尚未确认'],
    ['provisioning', '套餐正在开通', '正在准备网络配置']
  ] as const)('新账号有 %s 套餐时说明实际下一步，不误报已领体验', (state, title, nextStep) => {
    const fresh: AccountView = { ...account, overview: { ...account.overview!,
      trial: { available: false, usage: null, retryable: false },
      subscription: { ...usage, kind: 'subscription', state }
    } }
    const view = buildNetworkOnboarding(fresh, status)
    expect(view).toMatchObject({ step: 2, action: 'account', title })
    expect(view.description).toContain(nextStep)
    expect(view.description).not.toContain('已领取')
  })
  it.each(['expired', 'exhausted', 'disabled'] as const)('仅套餐 %s、没有体验记录时不声称已领取体验', (state) => {
    const fresh: AccountView = { ...account, overview: { ...account.overview!,
      trial: { available: false, usage: null }, subscription: { ...usage, kind: 'subscription', state }
    } }
    const view = buildNetworkOnboarding(fresh, status)
    expect(view).toMatchObject({ step: 2, action: 'account' })
    expect(view.description).not.toContain('已领取')
  })
  it('待确认套餐不妨碍符合条件的账号主动领取体验', () => {
    const pending: AccountView = { ...account, overview: { ...account.overview!,
      subscription: { ...usage, kind: 'subscription', state: 'pending' }
    } }
    expect(buildNetworkOnboarding(pending, status)).toMatchObject({ step: 2, action: 'claim' })
  })
  it('没有领取记录但资格暂不可用时先重查，不引导先买工具箱', () => {
    const unavailable: AccountView = { ...account, overview: { ...account.overview!, trial: { available: false, usage: null } } }
    const view = buildNetworkOnboarding(unavailable, status)
    expect(view).toMatchObject({ step: 2, action: 'refresh' })
    expect(view.description).toContain('注册登录后可免费领取')
    expect(view.description).not.toContain('购买工具箱')
  })
  it('网络实际已连后显示 Codex 官方下载与版本入口', () => {
    const view = buildNetworkOnboarding(account, { ...status, currentConfig: 'current', state: '已连' })
    expect(view).toMatchObject({ step: 4, title: '查看 Codex 下载与版本', label: '查看下载/版本', action: 'download' })
    expect(view.description).toContain('Codex 的“下载/版本信息”')
  })
})

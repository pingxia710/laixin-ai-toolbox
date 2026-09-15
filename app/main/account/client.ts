import type { AccountDevice, AccountLogin, AccountOverview, AccountRegistration, AccountSession, AccountView, CommercialTerms, CustomerProfile, InstallationRecord, PaymentChannelName, PaymentOrderView, RecoveryResult } from '../../account-types'
import { trialClaimedCopy } from '../../commercial-copy'
import type { InstallationReportView } from './installation-report'
import type { NetworkAccountAccess } from '../tunnel/account-client'
import { NetworkAccountClient } from '../tunnel/account-client'
import { subscriptionMessages, type SubscriptionOperation } from '../../subscription-types'
import { sharingMessages, type SharingOperation } from '../../sharing-types'
import { validDeviceReceipt, type DeviceFacts } from '../../customer-ops-types'
import type { DownloadTaskSnapshot } from '../download/types'
import { loadCatalog } from '../download/catalog'

export class AccountClientError extends Error {
  constructor(code: string, readonly detail?: string) { super(code) }
}
export interface SessionStore {
  deviceId?(): Promise<string>
  read(): Promise<AccountSession | null>
  write(session: AccountSession | null): Promise<void>
  /** 损坏隔离后的一次性提示;无提示返回 undefined(与 read 的 null 配套)。 */
  consumeCorruptionNote?: () => string | undefined
}
export const accountMessages: Record<string, string> = {
  ...subscriptionMessages,
  ...sharingMessages,
  ACCOUNT_NOT_CONFIGURED: '账号服务尚未连接，请联系来信客服。',
  ACCOUNT_LOGIN_REQUIRED: '请先登录来信账号。',
  ACCOUNT_LOGIN_FAILED: '账号或密码不正确。',
  ACCOUNT_ALREADY_EXISTS: '这个账号已注册，请登录或换一个账号。',
  ACCOUNT_USERNAME_INVALID: '请填写账号名。',
  ACCOUNT_PASSWORD_INVALID: '请填写密码。',
  ACCOUNT_PASSWORD_INCORRECT: '当前密码不正确。',
  ACCOUNT_RECOVERY_FAILED: '账号或恢复码不正确，或恢复码已经失效。',
  ACCOUNT_RATE_LIMITED: '操作过于频繁，请稍后再试。',
  ACCOUNT_SERVICE_UNAVAILABLE: '暂时无法连接账号服务，请稍后重试。',
  ACCOUNT_RESPONSE_INVALID: '暂时无法确认账号状态，请稍后重试。',
  ACCOUNT_REQUEST_INVALID: '账号服务暂不支持这项操作，请更新后重试。',
  ACCOUNT_STORAGE_UNAVAILABLE: '本机无法安全保存登录状态，请稍后重试。',
  ACCOUNT_BUSY: '正在处理账号操作，请稍候。',
  NETWORK_NOT_CONFIGURED: '网络开通服务暂未开放。',
  APPLICATION_ALREADY_EXISTS: '已有网络套餐，请刷新查看当前套餐后重试。',
  ALLOCATION_BUSY: '开通服务正在处理其他申请，请稍后重试。',
  ACCOUNT_LOGOUT_PENDING: '网络暂不可用，尚未完成退出，请恢复连接后重试。',
  PAYMENT_NOT_CONFIGURED: '在线支付暂时无法使用，请稍后重试或联系来信客服。',
  PAYMENT_ALREADY_PAID: '原订单已付款，已保留原套餐。请查看当前套餐，无需重复购买。',
  PAYMENT_CHANNEL_UNREADY: '该支付渠道暂未就绪，请换一种支付方式。',
  PAYMENT_ORDER_NOT_FOUND: '订单不存在或已失效。',
  PAYMENT_ORDER_BUSY: '正在处理支付，请稍候。',
  PLAN_INVALID: '套餐不存在或已下架。',
  ACCOUNT_SESSION_NOT_FOUND: '这次登录已退出，请刷新设备列表。',
  ACCOUNT_CLOSE_PENDING: '账号还有未完成订单或仍有效的网络，请先处理或到期后再注销。',
  TOOLBOX_PAYMENT_CONFLICT: '该笔购买已确认，请刷新查看原收款记录。',
  TOOLBOX_ALREADY_OWNED: '此账号已购买工具箱，无需重复付款。',
  PAYMENT_CHANNEL_CONFLICT: '已有待付订单，请先取消原订单，再选择其他支付方式。',
  PAYMENT_PLAN_CONFLICT: '已有待付套餐，请先取消原订单，再换套餐。',
  PAYMENT_CANCEL_PENDING: '正在等待支付渠道确认取消结果。请稍后重试，确认关闭后即可更换套餐或支付方式。',
  PAYMENT_ORDER_REFUNDED: '此订单有退款记录，请查看原订单或联系售后。',
  TOOLBOX_RECEIPT_USED: '这笔收款已关联其他账号，请核对原购买账号。',
  INVITE_CODE_INVALID: '邀请码无效，请核对后重试；不需要邀请码可清空后直接注册。',
  INVITE_REWARD_LIMIT: '该邀请码的本月邀请奖励已达上限，暂时无法使用；可清空邀请码直接注册。'
}
const signedOut = (code = '', message = ''): AccountView => ({ state: 'signed-out', account: null, code, message, overview: null })

export function validSession(value: unknown): value is AccountSession {
  const s = value as AccountSession | null
  return Boolean(s && typeof s === 'object' && s.account && /^acct_[a-f0-9]{32}$/.test(s.account.id) &&
    typeof s.account.username === 'string' && s.account.username.length > 0 &&
    typeof s.accessToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s.accessToken) && Number.isSafeInteger(s.expiresAt))
}

export class AccountClient {
  private session: AccountSession | null = null
  private restored = false
  private busy = false
  private statusRequest?: Promise<AccountView>
  private statusController?: AbortController
  private boundDevice?: { token: string; id: string }
  private deviceBinding?: { token: string; id: string; pending: Promise<void> }
  private controller = new AbortController()
  private readonly base: URL | null
  private view: AccountView = signedOut()
  private readonly installationStates = new Map<string, { token: string; state: 'syncing' | 'synced' | 'failed'; version: number }>()
  private installationWrites: Promise<void> = Promise.resolve()
  private readonly downloadReports = new Map<string, { token: string; signature: string }>()
  private deviceReport: { token: string; state: 'syncing' | 'synced' | 'failed'; at: number; receipt?: string } | undefined
  private terms?: CommercialTerms
  private termsFailedAt = 0
  private readonly device: AccountDevice = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'unknown'
  constructor(origin: string, private readonly store: SessionStore,
    private readonly setNetwork: (access: NetworkAccountAccess | undefined, reason?: 'temporary-unavailable' | 'login-expired') => Promise<unknown>,
    private readonly collectDevice?: () => Promise<DeviceFacts>) {
    this.base = origin ? new URL(origin) : null
    // 允许挂在单个路径前缀下（如 https://laixin.net.cn/AI-tools/）；请求一律相对解析。
    const basePathOk = this.base !== null && (this.base.pathname === '/' || /^\/[A-Za-z0-9_-]+\/$/.test(this.base.pathname))
    if (this.base && (!basePathOk ||
      (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(this.base.hostname))) ||
      this.base.username || this.base.password || this.base.hash || this.base.search)) throw new AccountClientError('ACCOUNT_NOT_CONFIGURED')
  }

  /** 相对解析：'/v1/x' 归一成 'v1/x'，保住基础路径前缀（如 /AI-tools/）。 */
  private resolve(path: string): URL {
    return new URL(path.replace(/^\/+/, ''), this.base!)
  }

  private async request(path: string, body?: unknown, token?: string, maxBytes = 128 * 1024, signal?: AbortSignal): Promise<unknown> {
    if (!this.base) throw new AccountClientError('ACCOUNT_NOT_CONFIGURED')
    try {
      const response = await fetch(this.resolve(path), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]),
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      if (response.status >= 500) {
        await response.body?.cancel(); throw new AccountClientError('ACCOUNT_SERVICE_UNAVAILABLE')
      }
      if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/json') {
        await response.body?.cancel(); throw new AccountClientError([401, 403].includes(response.status) ? 'ACCOUNT_LOGIN_REQUIRED' : 'ACCOUNT_RESPONSE_INVALID')
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          size += value.length
          if (size > maxBytes) { await reader.cancel(); throw new AccountClientError('ACCOUNT_RESPONSE_INVALID') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      let data: unknown
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new AccountClientError('ACCOUNT_RESPONSE_INVALID') }
      if (!response.ok) {
        const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : ''
        throw new AccountClientError(Object.hasOwn(accountMessages, code) ? code : [401, 403].includes(response.status) ? 'ACCOUNT_LOGIN_REQUIRED' : 'ACCOUNT_SERVICE_UNAVAILABLE')
      }
      return data
    } catch (error) {
      if (error instanceof AccountClientError) throw error
      throw new AccountClientError('ACCOUNT_SERVICE_UNAVAILABLE')
    }
  }

  private async run(action: () => Promise<AccountView>, refreshing = false): Promise<AccountView> {
    if (!refreshing && this.statusRequest) {
      // A user operation supersedes a background read; never merge writes into it.
      this.statusController?.abort()
      await this.statusRequest
    }
    if (this.busy) return { ...this.view, code: 'ACCOUNT_BUSY', message: accountMessages.ACCOUNT_BUSY }
    this.busy = true
    try {
      this.view = this.withTerms(await action())
      return this.view
    }
    catch (error) {
      const code = error instanceof AccountClientError ? error.message : 'ACCOUNT_SERVICE_UNAVAILABLE'
      if (code === 'ACCOUNT_LOGIN_REQUIRED') {
        // 登录过期 ≠ 用户退出:通道按本地配置有效期继续,只是之后领新配置要先登录。
        await this.setNetwork(undefined, 'login-expired')
        this.session = null
        try { await this.store.write(null) } catch {
          return this.view = signedOut('ACCOUNT_STORAGE_UNAVAILABLE', '登录已失效，本机记录未能清理，请重试。')
        }
        this.view = signedOut()
      }
      const detail = error instanceof AccountClientError && error.detail ? error.detail : undefined
      return this.view = { ...this.view, code, message: detail ?? accountMessages[code] ?? accountMessages.ACCOUNT_SERVICE_UNAVAILABLE }
    } finally { this.busy = false }
  }

  snapshot(): AccountView { return this.view }

  /** 后台商业参数(价格/体验额度/设备上限):尽力拉取并缓存;失败十分钟内不重试,期间用通用文案。 */
  private async ensureTerms(signal?: AbortSignal): Promise<void> {
    if (this.terms || Date.now() < this.termsFailedAt + 10 * 60_000) return
    try {
      const data = await this.request('/v1/account/plans', undefined, undefined, undefined, signal)
      this.terms = readTerms(data)
    } catch { this.termsFailedAt = Date.now() }
  }

  private withTerms(view: AccountView): AccountView {
    return { ...view, terms: this.terms ?? null }
  }

  status(): Promise<AccountView> {
    if (this.statusRequest) return this.statusRequest
    const controller = new AbortController()
    this.statusController = controller
    const pending = this.run(() => this.readStatus(controller.signal), true).finally(() => {
      if (this.statusRequest === pending) { this.statusRequest = undefined; this.statusController = undefined }
    })
    this.statusRequest = pending
    return pending
  }

  private async readStatus(signal: AbortSignal): Promise<AccountView> {
    const current = () => { if (signal.aborted || this.controller.signal.aborted) throw new AccountClientError('ACCOUNT_BUSY') }

    if (!this.base) return signedOut('ACCOUNT_NOT_CONFIGURED', accountMessages.ACCOUNT_NOT_CONFIGURED)
    if (!this.restored) {
      try {
        const saved = await this.store.read() as (AccountSession & { serviceOrigin?: string }) | null
        if (saved && saved.serviceOrigin !== this.base.href) throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
        current(); this.session = saved; this.restored = true
      }
      catch { throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE') }
    }
    if (!this.session) {
      await this.ensureTerms(signal)
      const note = this.store.consumeCorruptionNote?.()
      if (note) return this.withTerms(signedOut('ACCOUNT_STORAGE_CORRUPT', note))
      return this.withTerms(signedOut())
    }
    try {
      const data = await this.request('/v1/account/session', undefined, this.session.accessToken, undefined, signal) as Omit<AccountSession, 'accessToken'>
      current()
      if (!validSession({ ...data, accessToken: this.session.accessToken }) || data.account.id !== this.session.account.id) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      this.session = { ...data, accessToken: this.session.accessToken }
      await this.bindDevice(this.session, signal)
      current()
      // Both reads use the validated session, allowing the backend to share current usage I/O.
      const deviceId = await this.store.deviceId?.()
      current()
      // 商业参数串行预取:⛔ 与通道同步请求并发,避免扰动后台按客户的用量串行化。
      await this.ensureTerms(signal)
      const [network, overview] = await Promise.allSettled([
        this.setNetwork({ client: new NetworkAccountClient(new URL('v1/network/', this.base).href),
          session: { accountId: this.session.account.id, accessToken: this.session.accessToken, deviceId } }),
        this.overview(signal)
      ])
      current()
      if (network.status === 'rejected') throw network.reason
      if (overview.status === 'rejected') throw overview.reason
      return overview.value
    } catch (error) {
      if (signal.aborted || this.controller.signal.aborted) return this.view
      const loginExpired = error instanceof AccountClientError && error.message === 'ACCOUNT_LOGIN_REQUIRED'
      // 后台打不通、回包无效、本机存储忙……都是「暂时问不到」,⛔ 按退出账号处理(那会把客户正在用的网拆掉)。
      if (loginExpired) await this.setNetwork(undefined, 'login-expired')
      else await this.setNetwork(undefined, 'temporary-unavailable')
      if (loginExpired) {
        await this.store.write(null); this.session = null
        return signedOut('ACCOUNT_LOGIN_REQUIRED', '登录已失效，请重新登录。')
      }
      this.view = { state: 'unavailable', account: null, code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: '暂时无法确认登录状态，网络页会显示连接是否仍在授权期限内。', overview: null }
      throw error
    }
  }

  authenticate(mode: 'register' | 'login', username: string, password: string, onRecovery: (code: string) => void = () => undefined,
    inviteCode?: string): Promise<AccountView> { return this.run(async () => {
    if (this.session) throw new AccountClientError('ACCOUNT_BUSY')
    // 邀请码仅在注册时提交；归一化交给后台，这里只截断明显的粘贴噪声。
    const normalizedInvite = mode === 'register' && typeof inviteCode === 'string' && inviteCode.trim() ? inviteCode.trim().toUpperCase() : undefined
    let data: unknown
    let droppedInvite = false
    const payload = (base: Record<string, unknown>) => normalizedInvite ? { ...base, inviteCode: normalizedInvite } : base
    try { data = await this.request(`/v1/account/${mode}`, payload({ username, password, device: this.device, deviceId: await this.store.deviceId?.() })) }
    catch (error) {
      // Older deployed servers reject unknown fields before creating an account/session.
      if (!(error instanceof AccountClientError) || error.message !== 'ACCOUNT_REQUEST_INVALID') throw error
      try { data = await this.request(`/v1/account/${mode}`, payload({ username, password })) }
      catch (fallbackError) {
        // 旧后台不认识邀请码字段：不带码完成注册，但如实告知没有奖励，⛔ 静默假装有。
        if (!(fallbackError instanceof AccountClientError) || fallbackError.message !== 'ACCOUNT_REQUEST_INVALID' || !normalizedInvite) throw fallbackError
        droppedInvite = true
        data = await this.request(`/v1/account/${mode}`, { username, password })
      }
    }
    if (!validSession(data) || data.expiresAt <= Date.now()) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
    if (mode === 'register' && !validRecovery((data as AccountRegistration).recoveryCode)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
    // Explicit projection: the one-time recovery code must never enter the session store.
    const session = { account: data.account, accessToken: data.accessToken, expiresAt: data.expiresAt }
    const saved = { ...session, serviceOrigin: this.base!.href }
    try { await this.store.write(saved) } catch {
      // Do not leave an undisclosed newly issued server session after local storage fails.
      await this.request('/v1/account/logout', {}, data.accessToken)
      throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
    }
    this.session = session; this.restored = true
    if (mode === 'register') onRecovery((data as AccountRegistration).recoveryCode)
    this.view = { state: 'signed-in', account: data.account, code: '', message: '已登录', overview: null }
    await this.ensureTerms()
    await this.setNetwork({ client: new NetworkAccountClient(new URL('v1/network/', this.base!).href),
      session: { accountId: data.account.id, accessToken: data.accessToken, deviceId: await this.store.deviceId?.() } })
    const view = await this.overview()
    return droppedInvite ? { ...view, message: '已登录。当前账号服务版本暂不支持邀请码，本次注册未获得邀请奖励。' } : view
  }) }

  private async overview(signal?: AbortSignal): Promise<AccountView> {
    if (!this.session) return signedOut()
    const view: AccountView = { state: 'signed-in', account: this.session.account, code: '', message: '', overview: null }
    try {
      const data = await this.request('/v1/account/overview', undefined, this.session.accessToken, undefined, signal) as AccountOverview
      if (!data || !Array.isArray(data.plans) || typeof data.networkAvailable !== 'boolean' || !data.trial ||
          typeof data.recoveryReady !== 'boolean' || typeof data.trial.available !== 'boolean' ||
          (data.trial.usage !== null && (!validUsage(data.trial.usage) || data.trial.usage.kind !== 'trial')) ||
          (data.subscription !== null && (!validUsage(data.subscription) || data.subscription.kind !== 'subscription')) ||
          !Array.isArray(data.paymentChannels) || !data.paymentChannels.every((name) => ['alipay', 'wechat'].includes(name))) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      // 邀请块可选（旧版后台不下发时界面不渲染邀请卡）。邀请码由客户手动填入注册页；
      // 账号服务本身没有客户注册链接，不能把后台地址伪装成带码链接。
      if (data.invite !== undefined) {
        if (!validInvite(data.invite)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      }
      const profile = data.profile === undefined ? undefined : readProfile(data.profile, this.session.account.id, this.terms)
      return { ...view, overview: { ...data, profile } }
    } catch (error) {
      if (error instanceof AccountClientError && error.message === 'ACCOUNT_LOGIN_REQUIRED') throw error
      return { ...view, code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: '已登录，暂时无法获取账号权益与安装记录。' }
    }
  }

  /** 开通名下待开通的邀请奖励；逐笔幂等，失败停留在可重试状态，随后回读账号页展示真实进度。 */
  redeemInviteRewards(): Promise<AccountView> { return this.run(async () => {
    if (!this.session) return signedOut('ACCOUNT_LOGIN_REQUIRED', accountMessages.ACCOUNT_LOGIN_REQUIRED)
    let incomplete: boolean | undefined
    try {
      const result = await this.request('/v1/account/invite/redeem', {}, this.session.accessToken) as { ok?: unknown; redeemed?: unknown; remaining?: unknown }
      const remainingCount = result && typeof result.remaining === 'number' && Number.isSafeInteger(result.remaining) ? result.remaining : null
      if (!result || result.ok !== true || remainingCount === null) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      incomplete = remainingCount > 0
    } catch (error) {
      if (error instanceof AccountClientError && error.message === 'ACCOUNT_LOGIN_REQUIRED') throw error
      incomplete = undefined
    }
    const view = await this.overview()
    if (incomplete === undefined) return { ...view, message: '暂时无法开通奖励流量，可稍后重试。' }
    return { ...view, message: incomplete ? '部分奖励已开通，其余可稍后重试。' : '奖励流量已开通。' }
  }) }

  apply(planId: string): Promise<AccountView> { return this.run(async () => {
    if (!this.session) return signedOut('ACCOUNT_LOGIN_REQUIRED', accountMessages.ACCOUNT_LOGIN_REQUIRED)
    await this.request('/v1/network/application', { planId }, this.session.accessToken)
    return { ...await this.overview(), message: '申请已提交，确认付款并开通后可领取配置。' }
  }) }

  async sessions(): Promise<AccountLogin[]> {
    const session = this.session
    if (!session || this.view.state !== 'signed-in') throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    const data = await this.request('/v1/account/sessions', undefined, session.accessToken) as { sessions: AccountLogin[] }
    if (this.session?.accessToken !== session.accessToken) throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    if (!Array.isArray(data.sessions) || data.sessions.length > 10 || data.sessions.some((s) =>
      !s || !/^session_[a-f0-9]{32}$/.test(s.id) || !['macos', 'windows', 'linux', 'web', 'unknown'].includes(s.device) ||
      (s.createdAt !== null && !Number.isSafeInteger(s.createdAt)) || !Number.isSafeInteger(s.expiresAt) || typeof s.current !== 'boolean')) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
    return data.sessions.map(({ id, device, deviceId, createdAt, expiresAt, current }) => ({ id, device, deviceId, createdAt, expiresAt, current }))
  }

  revokeSession(sessionId: string): Promise<AccountView> { return this.run(async () => {
    if (!this.session) return signedOut('ACCOUNT_LOGIN_REQUIRED', accountMessages.ACCOUNT_LOGIN_REQUIRED)
    await this.request('/v1/account/sessions/revoke', { sessionId }, this.session.accessToken)
    return { ...await this.overview(), message: '已退出所选登录。' }
  }) }

  changePassword(currentPassword: string, password: string): Promise<AccountView> { return this.run(async () => {
    if (!this.session) return signedOut('ACCOUNT_LOGIN_REQUIRED', accountMessages.ACCOUNT_LOGIN_REQUIRED)
    const data = await this.request('/v1/account/password', { currentPassword, password, device: this.device }, this.session.accessToken)
    if (!validSession(data) || data.account.id !== this.session.account.id) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
    const session = { account: data.account, accessToken: data.accessToken, expiresAt: data.expiresAt }
    this.session = session
    const saved = { ...session, serviceOrigin: this.base!.href }
    try { await this.store.write(saved) }
    catch {
      this.session = null; this.view = signedOut('', '密码已修改，请使用新密码重新登录。')
      try { await this.setNetwork(undefined) } catch { /* The new session is not enabled; report incomplete local cleanup below. */ }
      try { await this.request('/v1/account/logout', {}, data.accessToken) } catch { /* Local storage failure is reported; reopening revalidates the saved old token. */ }
      return { ...this.view, code: 'ACCOUNT_STORAGE_UNAVAILABLE', message: '密码已修改，但本机未能保存新登录。请使用新密码重新登录。' }
    }
    try {
      await this.setNetwork(undefined)
      await this.setNetwork({ client: new NetworkAccountClient(new URL('v1/network/', this.base!).href),
        session: { accountId: data.account.id, accessToken: data.accessToken, deviceId: await this.store.deviceId?.() } })
    } catch {
      return { state: 'unavailable', account: null, overview: null, code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: '密码已修改；本机网络状态暂未确认，请重新读取账号。' }
    }
    return { ...await this.overview(), message: '密码已修改，其他登录已退出。' }
  }) }

  closeAccount(password: string, confirmed: boolean): Promise<AccountView> { return this.run(async () => {
    if (!this.session) return signedOut('ACCOUNT_LOGIN_REQUIRED', accountMessages.ACCOUNT_LOGIN_REQUIRED)
    await this.request('/v1/account/close', { password, confirmed }, this.session.accessToken)
    this.session = null; this.restored = true; this.view = signedOut('', '账号已注销，历史订单保留供售后核对。')
    const cleanup = await Promise.allSettled([this.setNetwork(undefined), this.store.write(null)])
    if (cleanup.some((result) => result.status === 'rejected')) return { ...this.view, code: 'ACCOUNT_STORAGE_UNAVAILABLE', message: '账号已注销；本机状态未能完全清理，请关闭工具箱后重开。历史订单保留供售后核对。' }
    return this.view
  }) }

  deviceReportStatus(): { state: string; message: string } {
    if (!this.session || this.view.state !== 'signed-in') return { state: 'local', message: '登录后可把基本电脑配置发送给来信客服。' }
    const report = this.deviceReport?.token === this.session.accessToken ? this.deviceReport : undefined
    if (!report) return { state: 'local', message: '基本电脑配置尚未发送。' }
    return { state: report.state, message: report.state === 'synced'
      ? `基本电脑配置已发送给来信客服（回执号 ${report.receipt}，${new Date(report.at).toLocaleString('zh-CN')}）。`
      : report.state === 'failed' ? '基本电脑配置发送未完成，可重试；你也可以继续使用工具箱。' : '正在发送基本电脑配置…' }
  }

  private async bindDevice(session: AccountSession, signal?: AbortSignal): Promise<string | undefined> {
    const id = await this.store.deviceId?.()
    const current = () => this.session?.accessToken === session.accessToken && !signal?.aborted && !this.controller.signal.aborted
    if (!id || !current()) return undefined
    if (this.boundDevice?.token === session.accessToken && this.boundDevice.id === id) return id
    let binding = this.deviceBinding
    if (!binding || binding.token !== session.accessToken || binding.id !== id) {
      const pending = this.request('/v1/account/device', { deviceId: id }, session.accessToken, undefined, signal).then(() => {
        if (current()) this.boundDevice = { token: session.accessToken, id }
      })
      binding = { token: session.accessToken, id, pending }
      this.deviceBinding = binding
    }
    try { await binding.pending } finally { if (this.deviceBinding === binding) this.deviceBinding = undefined }
    return current() ? id : undefined
  }

  /** 客户主动发送：只有本人点击才上报。同步中与已成功的再次点击不重复上报，失败后才允许重试。 */
  sendDeviceReport(): { state: string; message: string } {
    const session = this.session
    if (!session || this.view.state !== 'signed-in' || !this.collectDevice || !this.store.deviceId) return this.deviceReportStatus()
    const previous = this.deviceReport?.token === session.accessToken ? this.deviceReport : undefined
    if (previous && previous.state !== 'failed') return this.deviceReportStatus()
    const report: { token: string; state: 'syncing' | 'synced' | 'failed'; at: number; receipt?: string } = { token: session.accessToken, state: 'syncing', at: Date.now() }
    this.deviceReport = report
    const current = () => this.deviceReport === report && this.session?.accessToken === session.accessToken && this.view.state === 'signed-in' && !this.controller.signal.aborted
    void (async () => {
      try {
        const facts = await this.collectDevice!()
        if (!current()) return
        if (!await this.bindDevice(session) || !current()) return
        const result = await this.request('/v1/account/device-report', facts, session.accessToken) as { ok?: boolean; receipt?: string }
        if (result?.ok !== true || !validDeviceReceipt(result.receipt)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
        if (current()) { report.state = 'synced'; report.at = Date.now(); report.receipt = result.receipt }
      } catch { if (current()) { report.state = 'failed'; report.at = Date.now() } }
    })()
    return this.deviceReportStatus()
  }

  captureInstallationReport(customerConfirmed = false): (view: InstallationReportView) => void {
    const session = this.view.state === 'signed-in' ? this.session : null
    return (view) => {
      if (!session || this.session?.accessToken !== session.accessToken || this.view.state !== 'signed-in') return
      const platform = view.platform === 'mac' || view.platform === 'windows' ? view.platform : undefined
      if ((view.software !== 'hermes' && view.software !== 'codex' && view.software !== 'claude') || platform === undefined) return
      // 存在本机的确认记录可能属于这台机器的上一个使用者。
      const evidence = customerConfirmed ? 'customer-confirmation'
        : view.detectors.some((d) => d.state === 'complete') ? 'reliable-detection' : 'unknown'
      const errorCode = /(?:error|failure)/.test(view.stageCode) ? view.stageCode : null
      this.reportInstallation(session, { software: view.software, platform, stage: view.stageCode, evidence, errorCode })
    }
  }

  captureDownloadReport(passive = false): (task: DownloadTaskSnapshot | undefined) => void {
    const session = this.view.state === 'signed-in' ? this.session : null
    return (task) => {
      if (!task || !session || this.session?.accessToken !== session.accessToken || this.view.state !== 'signed-in') return
      const previous = this.downloadReports.get(task.taskId)
      // Merely viewing an old local download must not attribute it to the next customer.
      if (passive && previous?.token !== session.accessToken) return
      const resource = loadCatalog().resources.find((r) => r.id === task.resourceId)
      const software = resource?.software.toLowerCase()
      if (!resource || (software !== 'hermes' && software !== 'codex' && software !== 'claude') || !['macos', 'windows'].includes(resource.platform)) return
      const signature = `${task.state}:${task.reason}`
      if (passive && previous?.signature === signature) return
      this.downloadReports.set(task.taskId, { token: session.accessToken, signature })
      if (this.downloadReports.size > 100) this.downloadReports.delete(this.downloadReports.keys().next().value!)
      const failed = !['', 'cancelled', 'existing-installation'].includes(task.reason)
      const errorCode = failed && /^[a-z][a-z0-9-]{0,79}$/.test(task.reason) ? task.reason : null
      this.reportInstallation(session, { software, platform: resource.platform === 'macos' ? 'mac' : 'windows',
        stage: `download-${task.state}`, evidence: 'unknown', errorCode })
    }
  }

  private reportInstallation(session: AccountSession, report: Pick<InstallationRecord, 'software' | 'platform' | 'stage' | 'evidence' | 'errorCode'>): void {
    const version = (this.installationStates.get(report.software)?.version ?? 0) + 1
    this.installationStates.set(report.software, { token: session.accessToken, state: 'syncing', version })
    const current = () => this.session?.accessToken === session.accessToken && this.installationStates.get(report.software)?.version === version
    this.installationWrites = this.installationWrites.then(async () => {
      // Keep ordered error reports even if the next local step completes before this write starts.
      if (this.session?.accessToken !== session.accessToken || this.view.state !== 'signed-in') return
      let state: 'synced' | 'failed' = 'synced'
      try { await this.request('/v1/account/installation', report, session.accessToken) } catch { state = 'failed' }
      if (current()) this.installationStates.set(report.software, { token: session.accessToken, state, version })
    })
  }

  installationStatus(software: string): { state: string; message: string } {
    const report = this.installationStates.get(software)
    if (!this.session || this.view.state !== 'signed-in') return { state: 'local', message: '安装进度保存在这台电脑。登录后继续操作，可把进度同步到自己的来信账号。' }
    if (!report || report.token !== this.session.accessToken) return { state: 'local', message: '当前进度保存在本机；点击“重新检查”后同步到当前账号。' }
    return { state: report.state, message: report.state === 'synced' ? '安装进度已同步到你的来信账号，客服可据此协助。'
      : report.state === 'failed' ? '本机进度已保留，账号同步未完成。可继续安装，或点击“重新检查”重试同步。' : '本机进度已保留，正在同步账号…' }
  }

  /** 创建支付订单（幂等复用未结订单）；支付宝的跳转由主进程用返回的 URL 打开系统浏览器。 */
  async pay(planId: string, channel: PaymentChannelName): Promise<{ view: AccountView; order: PaymentOrderView | null }> {
    let order: PaymentOrderView | null = null
    const view = await this.run(async () => {
      if (!this.session) return signedOut('ACCOUNT_LOGIN_REQUIRED', accountMessages.ACCOUNT_LOGIN_REQUIRED)
      await this.prepareNetworkPurchase(planId, channel)
      const data = await this.request('/v1/payment/orders', { planId, channel }, this.session.accessToken) as PaymentOrderView
      if (!validPaymentOrder(data)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      order = data
      return { ...await this.overview(), message: '订单已创建，完成支付后自动开通。' }
    })
    return { view, order }
  }

  private async prepareNetworkPurchase(planId: string, channel: PaymentChannelName): Promise<void> {
    this.view = await this.overview()
    const overview = this.view.overview
    if (!overview) throw new AccountClientError('ACCOUNT_SERVICE_UNAVAILABLE')
    if (!overview.plans.some((plan) => plan.id === planId)) throw new AccountClientError('PLAN_INVALID')
    if (!overview.networkAvailable) throw new AccountClientError('NETWORK_NOT_CONFIGURED')
    if (!overview.paymentChannels.includes(channel)) throw new AccountClientError('PAYMENT_CHANNEL_UNREADY')
    const usage = overview.subscription
    if (usage?.state !== 'pending' || usage.planId === planId) return
    const orders = (await this.paymentOrders()).filter((order) => order.applicationId === usage.authorizationId && order.status !== 'cancelled')
    for (const existing of orders) {
      const result = await this.request(`/v1/payment/orders/${encodeURIComponent(existing.orderId)}/cancel`, {}, this.session!.accessToken) as PaymentOrderView
      if (!validPaymentOrder(result)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      if (result.status !== 'cancelled') {
        this.view = await this.overview()
        throw new AccountClientError('PAYMENT_ALREADY_PAID')
      }
    }
    // The server rechecks order ownership and cancellation before releasing the old selection.
    await this.request('/v1/account/network-cancel', { applicationId: usage.authorizationId }, this.session!.accessToken)
  }

  /** 轮询订单状态；不动账号视图，由调用方在确认后刷新，避免轮询噪音写进界面消息。 */
  async pollPayment(orderId: string): Promise<PaymentOrderView | null> {
    if (!this.session) return null
    try {
      const data = await this.request(`/v1/payment/orders/${encodeURIComponent(orderId)}`, undefined, this.session.accessToken) as PaymentOrderView
      return validPaymentOrder(data) ? data : null
    } catch (error) {
      if (error instanceof AccountClientError && error.message === 'ACCOUNT_LOGIN_REQUIRED') throw error
      return null
    }
  }

  async paymentOrders(): Promise<PaymentOrderView[]> {
    const session = this.session
    if (!session) throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    const data = await this.request('/v1/payment/orders', undefined, session.accessToken) as { orders: PaymentOrderView[] }
    if (this.session?.accessToken !== session.accessToken || !Array.isArray(data.orders) || !data.orders.every(validPaymentOrder)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
    return data.orders
  }

  cancelPayment(orderId: string): Promise<AccountView> { return this.run(async () => {
    if (!this.session) throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    const data = await this.request(`/v1/payment/orders/${encodeURIComponent(orderId)}/cancel`, {}, this.session.accessToken) as PaymentOrderView
    if (!validPaymentOrder(data)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
    return { ...await this.overview(), message: data.status === 'cancelled' ? '订单已取消，可以重新选择支付方式。' : '渠道确认此订单已付款，已更新交付状态。' }
  }) }

  cancelNetwork(applicationId: string): Promise<AccountView> { return this.run(async () => {
    if (!this.session) throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    await this.request('/v1/account/network-cancel', { applicationId }, this.session.accessToken)
    return { ...await this.overview(), message: '未付款的套餐申请已取消，可重新选择套餐。' }
  }) }

  async supportContext(): Promise<{ customerId: string; purchaseId: string; deviceId: string }> {
    return { customerId: this.view.account?.id ?? '', purchaseId: this.view.overview?.profile?.toolbox?.id ?? '', deviceId: await this.store.deviceId?.() ?? '' }
  }

  /** Fixed business routes only; neither renderer-supplied URLs nor session tokens cross this boundary. */
  async subscription(operation: SubscriptionOperation, input: Record<string, string> = {}): Promise<unknown> {
    if (operation === 'catalog') return this.request('/v1/subscription/catalog', undefined, undefined, 1024 * 1024)
    const session = this.session
    if (!session || this.view.state !== 'signed-in') throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    const base = '/v1/subscription/orders'
    let path: string; let body: unknown
    if (operation === 'list') {
      if (input.cursor && !/^lx-[a-f0-9]{32}$/.test(input.cursor)) throw new AccountClientError('SUBSCRIPTION_INVALID')
      path = `${base}${input.cursor ? `?before=${input.cursor}` : ''}`
    }
    else if (operation === 'create') { path = base; body = input }
    else {
      if (!/^lx-[a-f0-9]{32}$/.test(input.orderId ?? '')) throw new AccountClientError('SUBSCRIPTION_INVALID')
      if (!['detail', 'pay', 'reveal', 'complete', 'cancel', 'report'].includes(operation)) throw new AccountClientError('SUBSCRIPTION_INVALID')
      path = `${base}/${input.orderId}${operation === 'detail' ? '' : `/${operation}`}`
      body = operation === 'detail' ? undefined : operation === 'report' ? { issue: input.issue } : {}
    }
    const data = await this.request(path, body, session.accessToken, 1024 * 1024)
    if (this.session?.accessToken !== session.accessToken || this.view.state !== 'signed-in') throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    return data
  }

  /** 与 subscription() 同一约束:固定业务路由,渲染进程不提供 URL,会话 token 不过桥。 */
  async sharing(operation: SharingOperation, input: Record<string, string> = {}): Promise<unknown> {
    if (operation === 'catalog') return this.request('/v1/sharing/catalog', undefined, undefined, 1024 * 1024)
    if (operation === 'standards') return this.request('/v1/sharing/standard-products', undefined, undefined, 1024 * 1024)
    if (operation === 'posts') return this.request('/v1/sharing/posts', undefined, undefined, 1024 * 1024)
    const session = this.session
    if (!session || this.view.state !== 'signed-in') throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    const orderId = /^lx-[a-f0-9]{32}$/
    const postId = /^sp-[a-f0-9]{32}$/
    const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const integer = (value: string | undefined, nullable = false): number | null => {
      if (nullable && value === '') return null
      if (!value || !/^\d+$/.test(value)) throw new AccountClientError('SHARING_POST_INVALID')
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed)) throw new AccountClientError('SHARING_POST_INVALID')
      return parsed
    }
    const orders = '/v1/sharing/orders'
    let path: string; let body: unknown
    if (operation === 'list') {
      if (input.cursor && !orderId.test(input.cursor)) throw new AccountClientError('SHARING_INVALID')
      path = `${orders}${input.cursor ? `?before=${input.cursor}` : ''}`
    }
    else if (operation === 'create') {
      if (!requestId.test(input.requestId ?? '')) throw new AccountClientError('SHARING_INVALID')
      path = orders; body = { listingId: input.listingId, channel: input.channel, requestId: input.requestId }
    }
    else if (operation === 'intentions') { path = '/v1/sharing/intentions' }
    else if (operation === 'myPosts') { path = '/v1/sharing/posts/mine' }
    else if (operation === 'publish') {
      if (!requestId.test(input.requestId ?? '')) throw new AccountClientError('SHARING_POST_INVALID')
      path = '/v1/sharing/posts'
      body = {
        side: input.side, productId: input.productId, software: input.software,
        accountPlan: input.accountPlan || null, apiProvider: input.apiProvider || null, apiModel: input.apiModel || null,
        termDays: integer(input.termDays), quotaAmount: integer(input.quotaAmount, true), quotaUnit: input.quotaUnit || null,
        usageTier: input.usageTier || null, priceCents: integer(input.priceCents), availableCount: integer(input.availableCount, true),
        deliveryHours: integer(input.deliveryHours, true), requestId: input.requestId
      }
    }
    else if (operation === 'closePost') {
      if (!postId.test(input.postId ?? '')) throw new AccountClientError('SHARING_NOT_FOUND')
      path = `/v1/sharing/posts/${input.postId}/close`; body = {}
    }
    else if (operation === 'share') {
      if (!['codex', 'claude'].includes(input.software ?? '') || !requestId.test(input.requestId ?? '')) throw new AccountClientError('SHARING_INVALID')
      path = '/v1/sharing/intentions'
      body = { software: input.software, plan: input.plan, availableNote: input.availableNote, contact: input.contact, requestId: input.requestId }
    }
    else {
      if (!orderId.test(input.orderId ?? '')) throw new AccountClientError('SHARING_INVALID')
      if (!['detail', 'pay', 'reveal', 'complete', 'cancel', 'report'].includes(operation)) throw new AccountClientError('SHARING_INVALID')
      path = `${orders}/${input.orderId}${operation === 'detail' ? '' : `/${operation}`}`
      body = operation === 'detail' ? undefined : operation === 'report' ? { issue: input.issue } : {}
    }
    const data = await this.request(path, body, session.accessToken, 1024 * 1024)
    if (this.session?.accessToken !== session.accessToken || this.view.state !== 'signed-in') throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
    return data
  }

  claimTrial(): Promise<AccountView> { return this.run(async () => {
    if (!this.session) return signedOut('ACCOUNT_LOGIN_REQUIRED', accountMessages.ACCOUNT_LOGIN_REQUIRED)
    let failed = false
    try { await this.request('/v1/account/trial', {}, this.session.accessToken) }
    catch (error) {
      if (error instanceof AccountClientError && error.message === 'ACCOUNT_LOGIN_REQUIRED') throw error
      failed = true
    }
    await this.setNetwork({ client: new NetworkAccountClient(new URL('v1/network/', this.base!).href),
      session: { accountId: this.session.account.id, accessToken: this.session.accessToken, deviceId: await this.store.deviceId?.() } })
    const view = await this.overview()
    return { ...view, message: failed ? '暂时无法完成领取，后台已保留领取状态。可重试；从未开通成功且过期的体验可补发一次。'
      : trialClaimedCopy(this.terms) }
  }) }

  async recover(username: string, recoveryCode: string, password: string): Promise<RecoveryResult> {
    let replacement = ''
    const view = await this.run(async () => {
      if (this.session) throw new AccountClientError('ACCOUNT_BUSY')
      const data = await this.request('/v1/account/recover', { username, recoveryCode, password }) as { recoveryCode: string }
      if (!validRecovery(data?.recoveryCode)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      replacement = data.recoveryCode
      return signedOut('', '密码已重设，旧登录已失效。请保存新恢复码，再使用新密码登录。')
    })
    return { view, recoveryCode: replacement }
  }

  async rotateRecovery(password: string): Promise<RecoveryResult> {
    let replacement = ''
    const view = await this.run(async () => {
      if (!this.session) throw new AccountClientError('ACCOUNT_LOGIN_REQUIRED')
      const data = await this.request('/v1/account/recovery-code', { password }, this.session.accessToken) as { recoveryCode: string }
      if (!validRecovery(data?.recoveryCode)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
      replacement = data.recoveryCode
      return { ...await this.overview(), message: '新的恢复码已生成，旧恢复码已失效。' }
    })
    return { view, recoveryCode: replacement }
  }

  async logout(): Promise<AccountView> {
    if (this.statusRequest) {
      this.statusController?.abort()
      try { await this.setNetwork(undefined) } catch { return { ...this.view, code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: accountMessages.ACCOUNT_SERVICE_UNAVAILABLE } }
    }
    return this.run(async () => {
      await this.setNetwork(undefined)
      if (this.session) {
        try { await this.request('/v1/account/logout', {}, this.session.accessToken) }
        catch (error) {
          if (!(error instanceof AccountClientError) || error.message !== 'ACCOUNT_LOGIN_REQUIRED') throw new AccountClientError('ACCOUNT_LOGOUT_PENDING')
        }
      }
      try { await this.store.write(null) } catch { throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE') }
      this.session = null; this.restored = true
      return signedOut('', '已退出登录。')
    })
  }

  dispose(): void { this.statusController?.abort(); this.controller.abort() }
}

function validRecovery(code: unknown): code is string { return typeof code === 'string' && /^[A-F0-9]{8}(?:-[A-F0-9]{8}){5}$/.test(code) }

/** 校验 /v1/account/plans 下发的商业参数;结构不符视为无效响应,由调用方退回通用文案。 */
function validTerms(data: unknown): data is CommercialTerms {
  const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  if (!data || typeof data !== 'object') return false
  const v = data as Partial<CommercialTerms> & Record<string, unknown>
  return Boolean(Array.isArray(v.plans) && v.plans.every((plan) => !!plan && typeof plan.id === 'string' && plan.id !== '' &&
      typeof plan.label === 'string' && positiveInt(plan.bytes) && positiveInt(plan.priceCents)) &&
    !!v.toolbox && typeof v.toolbox.id === 'string' && v.toolbox.id !== '' && positiveInt(v.toolbox.priceCents) &&
    typeof v.toolbox.subject === 'string' && v.toolbox.subject !== '' &&
    !!v.trial && positiveInt(v.trial.bytes) && positiveInt(v.trial.hours) && Number.isSafeInteger(v.trial.perAccount) && v.trial.perAccount >= 1 &&
    positiveInt(v.deviceLimit) && v.deviceLimit <= 32 &&
    (v.invite === undefined || !!v.invite && positiveInt(v.invite.bytes) && positiveInt(v.invite.hours) &&
      Number.isSafeInteger(v.invite.perMonth) && v.invite.perMonth >= 1))
}

/** 账号页邀请块的后台响应校验：字段白名单 + 取值范围，⛔ 未知状态进界面。 */
function validInvite(value: unknown): value is NonNullable<AccountOverview['invite']> {
  const v = value as NonNullable<AccountOverview['invite']> | undefined
  if (!v || (v.code !== null && (typeof v.code !== 'string' || !/^[A-Z0-9]{8}$/.test(v.code))) ||
      (v.invitedBy !== null && typeof v.invitedBy !== 'string') || !Array.isArray(v.rewards) || v.rewards.length > 10) return false
  const states = ['pending', 'provisioning', 'active', 'exhausted', 'expired', 'disabled', 'unknown', 'unavailable']
  const numberOrNull = (n: unknown) => n === null || (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
  return v.rewards.every((reward) => !!reward && /^lx-[a-f0-9]{32}$/.test(reward.id) &&
    ['inviter', 'invitee'].includes(reward.role) && Number.isSafeInteger(reward.bytes) && reward.bytes > 0 &&
    Number.isSafeInteger(reward.grantedAt) && Number.isSafeInteger(reward.expiresAt) && states.includes(reward.state) &&
    numberOrNull(reward.remainingBytes) && numberOrNull(reward.usedBytes))
}

function readTerms(data: unknown): CommercialTerms {
  if (!validTerms(data)) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
  return data
}

function readProfile(profile: CustomerProfile, accountId: string, terms?: CommercialTerms): CustomerProfile {
  const date = (v: unknown) => v === null || (Number.isSafeInteger(v) && Number(v) > 0)
  if (!profile || profile.id !== accountId || typeof profile.username !== 'string' || !profile.username ||
    ![profile.createdAt, profile.lastLoginAt, profile.closedAt].every(date) || !Array.isArray(profile.installations) ||
    profile.installations.some((r) => !r || !['hermes', 'codex', 'claude'].includes(r.software) || !['mac', 'windows'].includes(r.platform) ||
      typeof r.stage !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(r.stage) || (r.stageLabel !== undefined && (typeof r.stageLabel !== 'string' || r.stageLabel.length > 120)) ||
      !['unknown', 'reliable-detection', 'customer-confirmation'].includes(r.evidence) || !date(r.updatedAt) || r.updatedAt === null)) {
    throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
  }
  const purchase = profile.toolbox
  if (purchase !== null && (!purchase || !/^lx-[a-f0-9]{32}$/.test(purchase.id) || !['pending', 'paid', 'refunded'].includes(purchase.status) ||
    (purchase.refundedFen !== undefined && (!Number.isSafeInteger(purchase.refundedFen) || purchase.refundedFen < 0 || purchase.refundedFen > purchase.amountFen)) ||
    // 待付款记录按后台当前价校验;已付/退款记录保留历史价(改价不发版)。
    !(Number.isSafeInteger(purchase.amountFen) && purchase.amountFen > 0 && (purchase.status !== 'pending' || !terms || purchase.amountFen === terms.toolbox.priceCents)) ||
    !date(purchase.createdAt) || purchase.createdAt === null || !date(purchase.paidAt) ||
    (purchase.status !== 'pending' ? purchase.paidAt === null : purchase.paidAt !== null))) throw new AccountClientError('ACCOUNT_RESPONSE_INVALID')
  return { id: profile.id, username: profile.username, createdAt: profile.createdAt, lastLoginAt: profile.lastLoginAt, closedAt: profile.closedAt,
    installations: profile.installations.map(({ software, platform, stage, stageLabel, evidence, updatedAt, deviceId }) => ({ software, platform, stage, stageLabel, evidence, updatedAt, deviceId })),
    toolbox: purchase ? { id: purchase.id, status: purchase.status, amountFen: purchase.amountFen, createdAt: purchase.createdAt, paidAt: purchase.paidAt, refundedFen: purchase.refundedFen } : null }
}

function validPaymentOrder(value: unknown): value is PaymentOrderView {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.orderId !== 'string' || !/^[a-f0-9]{32}$/.test(v.orderId) ||
      typeof v.applicationId !== 'string' || !/^lx-[a-f0-9]{32}$/.test(v.applicationId) ||
      typeof v.planId !== 'string' || !['alipay', 'wechat'].includes(String(v.channel)) ||
      typeof v.amountFen !== 'number' || !Number.isSafeInteger(v.amountFen) || v.amountFen <= 0 ||
      !['open', 'paid', 'confirmed', 'partially_refunded', 'refunded', 'cancelled'].includes(String(v.status))) return false
  if (v.paidAt !== null && (typeof v.paidAt !== 'number' || !Number.isSafeInteger(v.paidAt))) return false
  // 创建时间是可选的客户可读字段：旧版后台不下发时仍可读单，只是界面不显示创建时间。
  if (v.createdAt !== undefined && (typeof v.createdAt !== 'number' || !Number.isSafeInteger(v.createdAt) || v.createdAt <= 0)) return false
  if (v.confirmError !== null && typeof v.confirmError !== 'string') return false
  if (v.redirect === null) return true
  const redirect = v.redirect as Record<string, unknown>
  return (redirect.kind === 'url' || redirect.kind === 'qrcode') && typeof redirect.data === 'string' &&
    redirect.data.length > 0 && typeof redirect.expiresAt === 'number' && Number.isSafeInteger(redirect.expiresAt)
}

function validUsage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const numberOrNull = (n: unknown) => n === null || (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
  if (!['subscription', 'trial', 'invite'].includes(String(v.kind)) || typeof v.planId !== 'string' || typeof v.state !== 'string' ||
      !['pending', 'provisioning', 'active', 'exhausted', 'expired', 'disabled', 'unknown'].includes(v.state) ||
      !['current', 'unavailable', 'not-requested'].includes(String(v.measurement)) ||
      typeof v.totalBytes !== 'number' || !Number.isSafeInteger(v.totalBytes) || v.totalBytes <= 0 ||
      ![v.usedBytes, v.remainingBytes, v.expiresAt, v.observedAt].every(numberOrNull)) return false
  return v.measurement !== 'current' || (typeof v.usedBytes === 'number' && typeof v.remainingBytes === 'number' && typeof v.observedAt === 'number')
}

import type { SharingCatalog, SharingDelivery, SharingIntentionStatus, SharingIssue, SharingListing, SharingOrderView, SharingPayment, SharingPostSide, SharingPostView, SharingProductId, SharingSoftware, SharingStandardProduct, SharingStatus } from '../../../sharing-types'
import type { SharingPublishInput, SharingResult } from '../../../preload/api/sharing'
import { accountSnapshot, onAccountChange, requireAccount } from '../account-state'
import { markServiceAvailability } from '../navigation'
import { revealSupport } from '../support-widget'
import { mountQrCountdown } from '../subscription/qr-countdown'
import { renderSecretFields } from '../subscription/secret-fields'
import { planCard } from '../ui/plan-card'
import './style.css'

export const statusLabels: Record<SharingStatus, string> = { pending_payment: '等待付款', queued: '已付款 · 等待办理', processing: '正在办理', ready: '账号已备好 · 待领取核对', active: '租用中', expired: '租期已满 · 已收回', problem: '租单问题处理中', cancel_requested: '取消申请处理中', refund_pending: '等待人工退款', refunded: '已记录退款', cancelled: '已取消' }
export const intentionStatusLabels: Record<SharingIntentionStatus, string> = { pending: '待客服对接', contacted: '客服对接中', listed: '已上架出租', closed: '已关闭' }
const money = (n: number) => `¥${(n / 100).toFixed(2)}`
const date = (n: number | null) => n ? new Date(n).toLocaleString('zh-CN') : '尚未确定'
const yuanToCents = (value: string): number | null => {
  const matched = /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!matched) return null
  const cents = Number(matched[1]) * 100 + Number((matched[2] ?? '').padEnd(2, '0'))
  return cents >= 1 && cents <= 10_000_000 ? cents : null
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}
async function result<T>(request: Promise<SharingResult>): Promise<T> {
  const response = await request
  if (response.error || !response.data) throw new Error(response.error || '暂时无法读取，请稍后重试。')
  return JSON.parse(response.data) as T
}
export function mountSharing(root: HTMLElement): () => void {
  const api = window.toolbox.sharing
  let active = true; let busy = false; let generation = 0; let accountId = accountSnapshot().account?.id
  let section: 'home' | 'rent' | 'market' | 'publish' | 'myPosts' | 'orders' = 'home'
  let software: SharingSoftware = 'codex'
  let catalog: SharingCatalog | undefined; let orders: SharingOrderView[] = []; let nextCursor = ''
  let selected: SharingOrderView | undefined; let checkout: SharingListing | undefined
  let payment: SharingPayment | undefined; let secret: SharingDelivery | undefined
  let standards: SharingStandardProduct[] | undefined; let posts: SharingPostView[] | undefined; let myPosts: SharingPostView[] | undefined
  let publishSide: SharingPostSide = 'demand'; let publishProductId: SharingProductId = 'account-rental'
  let publishSoftware: SharingSoftware = 'codex'; let publishProvider = ''
  let message = ''
  let qrStop: (() => void) | undefined
  const requests = new Map<string, string>()
  const clearSecret = () => { secret = undefined; generation++; if (active) render() }
  const hideOnBlur = () => { generation++; if (secret) { secret = undefined; if (active) render() } }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    busy = true; message = ''; root.setAttribute('aria-busy', 'true')
    try { await action() } catch (error) { if (active) message = error instanceof Error ? error.message : '操作未完成，请刷新后重试。' }
    finally { busy = false; root.removeAttribute('aria-busy'); if (active) render() }
  }
  const button = (label: string, action: () => void | Promise<void>, primary = false) => {
    const b = el('button', label, primary ? 'primary-action' : 'secondary-action'); b.type = 'button'; b.disabled = busy
    b.onclick = () => { void action() }; return b
  }
  const signedIn = () => accountSnapshot().state === 'signed-in'
  const gate = () => { if (!signedIn()) { requireAccount('sharing'); return false } return true }
  const refresh = async (cursor = '') => {
    const identity = accountSnapshot().account?.id
    if (!identity) { orders = []; return }
    const response = await result<{ orders: SharingOrderView[]; nextCursor: string }>(api.list({ cursor }))
    if (active && identity === accountSnapshot().account?.id) { orders = cursor ? [...orders, ...response.orders] : response.orders; nextCursor = response.nextCursor }
  }
  const refreshPosts = async () => {
    const response = await result<{ posts: SharingPostView[] }>(api.posts())
    if (active) posts = response.posts
  }
  const refreshMyPosts = async () => {
    const identity = accountSnapshot().account?.id
    if (!identity) { myPosts = []; return }
    const response = await result<{ posts: SharingPostView[] }>(api.myPosts())
    if (active && identity === accountSnapshot().account?.id) myPosts = response.posts
  }
  const open = async (id: string) => {
    const response = await result<SharingOrderView>(api.detail({ orderId: id }))
    if (active && accountSnapshot().account) { selected = response; checkout = undefined; section = 'orders'; secret = undefined; generation++; payment = undefined }
  }
  const pay = async () => {
    if (!selected) return
    const id = selected.id; const response = await result<SharingPayment>(api.pay({ orderId: id }))
    if (active && selected?.id === id) { payment = response; selected = response.order }
  }
  const act = async (action: 'complete' | 'cancel' | 'report', issue?: SharingIssue) => {
    if (!selected) return
    const id = selected.id
    const response = await result<SharingOrderView>(action === 'report' ? api.report({ orderId: id, issue: issue! }) : api[action]({ orderId: id }))
    if (active && selected?.id === id) { selected = response; secret = undefined; generation++; payment = undefined; await refresh() }
  }
  function terms(block: HTMLElement, listing: SharingListing): void {
    block.append(el('h3', listing.name), el('p', `${money(listing.priceCents)} · ${listing.term}`, 'share-price'),
      el('p', `总价已含账号分享服务费 ${money(listing.serviceFeeCents)}，网络费用另计。`), el('p', listing.description),
      el('p', `交付：付款后 ${listing.deliveryHours} 小时内人工办理交接。`),
      el('p', `使用约定：${listing.usageTerms}`), el('p', `取消与退款：${listing.cancellationTerms}`))
  }
  function renderCheckout(listing: SharingListing): HTMLElement {
    const block = el('section', '', 'share-detail'); terms(block, listing)
    const form = el('form'); const label = el('label', '付款方式'); const select = el('select'); select.name = 'channel'
    for (const channel of catalog?.channels ?? []) { const option = el('option', ({ alipay: '支付宝', wechat: '微信支付', manual: '联系客服人工办理付款' })[channel]); option.value = channel; select.append(option) }
    label.append(select)
    const consent = el('label', '', 'share-check'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.required = true
    consent.append(checkbox, document.createTextNode('我已阅读租约、交付、使用约定及取消说明。'))
    const submit = el('button', '确认下单', 'primary-action'); submit.disabled = busy || !catalog?.channels.length
    form.append(label, consent, submit, button('返回', () => { checkout = undefined; render() }))
    form.onsubmit = (event) => { event.preventDefault(); void run(async () => {
      if (!gate()) return
      const key = `${listing.id}:${select.value}`; const requestId = requests.get(key) ?? crypto.randomUUID(); requests.set(key, requestId)
      const order = await result<SharingOrderView>(api.create({ listingId: listing.id, channel: select.value, requestId }))
      requests.delete(key)
      if (!active || !accountSnapshot().account) return
      selected = order; checkout = undefined; section = 'orders'; await refresh()
      if (order.channel !== 'manual' && order.status === 'pending_payment') await pay()
    }) }
    block.append(form); return block
  }
  function renderOrder(order: SharingOrderView): HTMLElement {
    const block = el('section', '', 'share-detail')
    block.append(button('返回我的租单', () => { selected = undefined; payment = undefined; clearSecret() }), el('p', statusLabels[order.status], 'share-status'))
    terms(block, order.listing)
    block.append(el('p', `租单号 ${order.id}`, 'share-muted'), el('p', `下单 ${date(order.createdAt)} · 付款 ${date(order.paidAt)}`, 'share-muted'))
    if (order.dueAt) block.append(el('p', `承诺交付时间：${date(order.dueAt)}${order.dueAt < Date.now() && ['queued', 'processing', 'problem'].includes(order.status) ? ' · 已超时，可通过下方客服入口查询处理进展。' : ''}`))
    if (order.expiresAt) block.append(el('p', `实际租期：${date(order.startsAt)} 至 ${date(order.expiresAt)}。领取不会重新起算。`))
    if (order.issue) block.append(el('p', '租单问题已记录，可通过下方客服入口补充情况，请勿发送密码。'))
    if (order.status === 'pending_payment') {
      if (order.channel === 'manual') block.append(el('p', '请通过下方企业微信客服办理，并提供租单编号；核对实际付款后更新进度。'))
      else block.append(button('继续付款', () => run(pay), true))
      if (payment?.payment?.redirect?.kind === 'qrcode') {
        qrStop?.()
        const qr = el('div', '', 'share-qr')
        const countdown = mountQrCountdown(qr, payment.payment.redirect, { regenerate: () => run(pay) })
        qrStop = countdown.stop
        block.append(qr)
      }
      if (payment?.payment?.redirect?.kind === 'url') block.append(el('p', '已在系统浏览器打开支付宝，请完成付款后返回这里。'))
    }
    if (['ready', 'active', 'problem'].includes(order.status) && order.deliveredAt) {
      block.append(button(secret ? '隐藏账号资料' : '查看交付的账号资料', () => secret ? clearSecret() : run(async () => {
        const current = generation
        const response = await result<SharingDelivery>(api.reveal({ orderId: order.id }))
        if (active && current === generation && selected?.id === order.id && document.visibilityState !== 'hidden') { secret = response; selected = { ...order, revealedAt: Date.now() } }
      }), true))
      if (secret) {
        const area = el('div', '', 'sub-secret'); area.append(el('p', '仅本人查看。离开本页、切换账号或窗口失去焦点后隐藏。'))
        renderSecretFields(area, [
          { name: '账号', value: secret.username, rows: 2 },
          { name: '密码', value: secret.password, rows: 2 },
          { name: '登录说明', value: secret.instructions, rows: 4 }
        ])
        block.append(area)
      }
      if (order.status === 'ready') { const complete = button('已登录并核对账号，确认租用', () => run(() => act('complete'))); complete.disabled ||= !order.revealedAt; block.append(complete) }
      if (order.status === 'active' && order.expiresAt) block.append(el('p', `租用中，租期至 ${date(order.expiresAt)}，到期后账号由来信收回。`))
      const problems = el('div', '', 'share-actions'); problems.append(el('span', '交付有问题：'))
      for (const [issue, label] of [['cannot_login', '无法登录'], ['wrong_entitlement', '套餐或有效期不符'], ['account_reclaimed', '账号被提前收回'], ['other', '其他问题']] as const) problems.append(button(label, () => run(() => act('report', issue))))
      block.append(problems)
    }
    if (order.status === 'expired') block.append(el('p', '租期已满，账号已收回。'))
    if (order.status === 'refund_pending') block.append(el('p', '等待人工办理退款，实际到账以原支付渠道为准。'))
    if (order.status === 'refunded') block.append(el('p', `运营已于 ${date(order.refundAt)} 记录退款，请核对原支付渠道到账。`))
    const controls = el('div', '', 'share-actions'); controls.append(button('刷新进度', () => run(() => open(order.id))))
    if (!['cancel_requested', 'refund_pending', 'refunded', 'cancelled', 'expired'].includes(order.status)) controls.append(button(order.status === 'pending_payment' ? '取消未付款租单' : '申请取消 / 退款', () => run(() => act('cancel'))))
    const history = el('ol', '', 'share-history'); for (const event of order.events) history.append(el('li', `${date(event.at)} · ${statusLabels[event.status]}`))
    block.append(controls, history); return block
  }
  const findProduct = (id: SharingProductId) => standards?.find((product) => product.id === id)
  const choiceLabel = (choices: { value: string; label: string }[], value: string | number | null) => choices.find((item) => item.value === String(value))?.label ?? String(value ?? '')
  const postDescription = (post: SharingPostView): string => {
    const product = findProduct(post.productId)
    if (!product) return post.productId
    const parts = [choiceLabel(product.software, post.software)]
    if (post.productId === 'account-rental') parts.push(choiceLabel(product.accountPlans, post.accountPlan))
    else {
      const provider = product.apiProviders.find((item) => item.value === post.apiProvider)
      parts.push(provider?.label ?? post.apiProvider ?? '', post.apiModel ?? '')
      if (post.productId === 'api-quota') parts.push(`${post.quotaAmount} ${choiceLabel(product.quotaUnits, post.quotaUnit)}`)
      else parts.push(choiceLabel(product.usageTiers, post.usageTier))
    }
    parts.push(choiceLabel(product.termDays, post.termDays))
    return parts.filter(Boolean).join(' · ')
  }
  function renderPost(post: SharingPostView, mine = false): HTMLElement {
    const product = findProduct(post.productId)
    const card = el('article', '', 'share-market-card')
    const role = post.side === 'demand' ? '需求' : '供给'
    card.append(el('span', role, `share-side share-side-${post.side}`), el('h3', product?.label ?? post.productId),
      el('p', postDescription(post)), el('p', `${post.side === 'demand' ? '愿付价格' : '供给报价'} ${money(post.priceCents)}`, 'share-price'))
    if (post.side === 'supply') card.append(el('p', `可提供 ${post.availableCount} 份 · ${post.deliveryHours} 小时内交付`))
    card.append(el('p', `${post.status === 'published' ? '发布中' : '已关闭'} · ${date(post.createdAt)}`, 'share-muted'))
    if (mine && post.status === 'published') card.append(button('关闭发布', () => run(async () => {
      await result<SharingPostView>(api.closePost({ postId: post.id })); await Promise.all([refreshPosts(), refreshMyPosts()]); message = '发布已关闭。'
    })))
    return card
  }
  const selectField = (labelText: string, name: string, choices: { value: string; label: string }[], value?: string) => {
    const label = el('label', labelText); const select = el('select'); select.name = name
    for (const item of choices) { const option = el('option', item.label); option.value = item.value; select.append(option) }
    select.value = value && choices.some((item) => item.value === value) ? value : choices[0]?.value ?? ''
    label.append(select); return { label, select }
  }
  function renderPublish(): HTMLElement {
    const wrapper = el('section', '', 'share-detail'); wrapper.append(el('h3', '发布标准需求或供给'),
      el('p', '先选择标准产品和规格。需求者填写愿付价格，供给者填写自己的报价；当前价格由发布者自主决定。'))
    if (!standards?.length) { wrapper.append(el('p', '正在读取标准模板…')); return wrapper }
    const product = findProduct(publishProductId) ?? standards[0]!
    publishProductId = product.id
    const form = el('form')
    const side = selectField('发布身份', 'side', [{ value: 'demand', label: '我是需求者' }, { value: 'supply', label: '我是供给者' }], publishSide)
    side.select.onchange = () => { publishSide = side.select.value as SharingPostSide; render() }
    const productField = selectField('标准产品', 'productId', standards.map((item) => ({ value: item.id, label: item.label })), product.id)
    productField.select.onchange = () => { publishProductId = productField.select.value as SharingProductId; render() }
    const softwareField = selectField('使用软件', 'software', product.software, publishSoftware)
    publishSoftware = softwareField.select.value as SharingSoftware
    const fields: HTMLElement[] = [side.label, productField.label, softwareField.label]
    let accountPlanField: ReturnType<typeof selectField> | undefined; let providerField: ReturnType<typeof selectField> | undefined
    let modelField: ReturnType<typeof selectField> | undefined; let quotaUnitField: ReturnType<typeof selectField> | undefined
    let tierField: ReturnType<typeof selectField> | undefined; let quotaAmountInput: HTMLInputElement | undefined
    if (product.id === 'account-rental') {
      const plans = product.accountPlans.filter((item) => item.software === softwareField.select.value)
      accountPlanField = selectField('账号套餐', 'accountPlan', plans); fields.push(accountPlanField.label)
      softwareField.select.onchange = () => { publishSoftware = softwareField.select.value as SharingSoftware; render() }
    } else {
      const selectedProvider = selectField('API 来源', 'apiProvider', product.apiProviders, publishProvider); providerField = selectedProvider; publishProvider = selectedProvider.select.value
      const models = product.apiProviders.find((item) => item.value === selectedProvider.select.value)?.models ?? []
      modelField = selectField('模型', 'apiModel', models)
      selectedProvider.select.onchange = () => { publishProvider = selectedProvider.select.value; render() }
      softwareField.select.onchange = () => { publishSoftware = softwareField.select.value as SharingSoftware }
      fields.push(providerField.label, modelField.label)
      if (product.id === 'api-quota') {
        const amountLabel = el('label', '额度数量'); const amount = el('input'); amount.type = 'number'; amount.name = 'quotaAmount'; amount.required = true; amount.placeholder = '请输入整数'; amountLabel.append(amount)
        quotaAmountInput = amount; quotaUnitField = selectField('额度单位', 'quotaUnit', product.quotaUnits); fields.push(amountLabel, quotaUnitField.label)
      } else {
        tierField = selectField('使用强度', 'usageTier', product.usageTiers); fields.push(tierField.label)
      }
    }
    const termField = selectField(product.id === 'api-quota' ? '有效期' : '租用周期', 'termDays', product.termDays); fields.push(termField.label)
    const priceLabel = el('label', publishSide === 'demand' ? '愿付价格（元）' : '供给报价（元）')
    const price = el('input'); price.type = 'text'; price.name = 'price'; price.required = true; price.placeholder = '如 29.90'; priceLabel.append(price); fields.push(priceLabel)
    let availableCountInput: HTMLInputElement | undefined; let deliveryField: ReturnType<typeof selectField> | undefined
    if (publishSide === 'supply') {
      const countLabel = el('label', '可提供数量'); const count = el('input'); count.type = 'number'; count.name = 'availableCount'; count.required = true; count.placeholder = '1～100'; countLabel.append(count)
      availableCountInput = count; deliveryField = selectField('交付时效', 'deliveryHours', product.deliveryHours)
      fields.push(countLabel, deliveryField.label)
    }
    const submit = el('button', publishSide === 'demand' ? '发布需求' : '发布供给', 'primary-action'); submit.disabled = busy
    form.append(...fields, submit)
    form.onsubmit = (event) => { event.preventDefault()
      const cents = yuanToCents(price.value)
      if (cents === null) { message = '请填写 0.01～100000 元之间的价格，最多两位小数。'; render(); return }
      if (!gate()) return
      const payload: Omit<SharingPublishInput, 'requestId'> = {
        side: publishSide, productId: product.id, software: softwareField.select.value,
        accountPlan: accountPlanField?.select.value ?? '', apiProvider: providerField?.select.value ?? '', apiModel: modelField?.select.value ?? '',
        termDays: termField.select.value, quotaAmount: quotaAmountInput?.value ?? '', quotaUnit: quotaUnitField?.select.value ?? '',
        usageTier: tierField?.select.value ?? '', priceCents: String(cents), availableCount: availableCountInput?.value ?? '',
        deliveryHours: deliveryField?.select.value ?? ''
      }
      void run(async () => {
        const key = JSON.stringify(payload); const requestId = requests.get(key) ?? crypto.randomUUID(); requests.set(key, requestId)
        await result<SharingPostView>(api.publish({ ...payload, requestId }))
        await Promise.all([refreshPosts(), refreshMyPosts()]); requests.delete(key); section = 'myPosts'; message = publishSide === 'demand' ? '需求发布成功。' : '供给发布成功。'
      })
    }
    wrapper.append(form); return wrapper
  }
  function renderHome(): HTMLElement {
    const home = el('section', '', 'share-home')
    const hero = el('section', '', 'share-hero')
    const copy = el('div', '', 'share-hero-copy')
    copy.append(el('p', '账号与 API 服务', 'share-kicker'), el('h3', '找服务，或发布一份服务。'),
      el('p', '需求和供给都用同一套标准模板表达，先把服务范围、期限和价格说清楚。'))
    const roles = el('div', '', 'share-role-grid')
    const demand = el('section', '', 'share-role')
    demand.append(el('p', '我是需求者', 'share-role-label'), el('h3', '我想找一份可用服务'),
      el('p', '先看大厅里已经发布的需求和供给；没有合适的，再填写自己的需求与愿付价格。'))
    demand.append(button('查看供需大厅', () => { section = 'market'; selected = undefined; checkout = undefined; clearSecret(); void run(refreshPosts) }, true),
      button('发布需求', () => { publishSide = 'demand'; publishProductId = 'account-rental'; section = 'publish'; selected = undefined; checkout = undefined; clearSecret() }))
    const supply = el('section', '', 'share-role')
    supply.append(el('p', '我是供给者', 'share-role-label'), el('h3', '我有服务可以提供'),
      el('p', '选择一个标准模板，写明你能提供的规格、报价、数量和交付时限。'))
    supply.append(button('发布供给', () => { publishSide = 'supply'; publishProductId = 'account-rental'; section = 'publish'; selected = undefined; checkout = undefined; clearSecret() }, true))
    roles.append(demand, supply); copy.append(roles)
    const templates = el('aside', '', 'share-templates')
    templates.append(el('p', '三种标准产品', 'share-kicker'), el('h3', '只选规格，不填敏感信息'))
    const templateList = el('div', '', 'share-template-list')
    const addTemplate = (title: string, description: string, productId: SharingProductId) => {
      const item = button('', () => { publishProductId = productId; section = 'publish'; selected = undefined; checkout = undefined; clearSecret() })
      item.className = 'share-template'
      item.append(el('strong', title), el('span', description))
      templateList.append(item)
    }
    addTemplate('账号租用', '按套餐与租期发布', 'account-rental')
    addTemplate('API 额度包', '按额度、单位与有效期发布', 'api-quota')
    addTemplate('API 周期包', '按使用强度与周期发布', 'api-period')
    templates.append(templateList, el('p', '未登录也能查看全部模板。发布、下单和管理自己的记录时再登录。共享账号可能违反部分厂商的服务条款，发布中不要填写账号密码或 API Key。', 'share-boundary'))
    hero.append(copy, templates); home.append(hero)
    const direct = el('section', '', 'share-direct')
    const directCopy = el('div', '', 'share-direct-copy')
    directCopy.append(el('h3', '已有可直接租用的账号？'), el('p', '直接租用与供需大厅是两条入口。前者按现有档位下单，后者用于浏览或发布标准供需。'))
    direct.append(directCopy, button('查看账号租用', () => { section = 'rent'; selected = undefined; checkout = undefined; clearSecret() }))
    home.append(direct)
    return home
  }
  function render(): void {
    if (!active) return
    qrStop?.(); qrStop = undefined
    root.classList.add('sharing-page')
    const nav = el('nav', '', 'share-nav')
    const hasEnabled = catalog?.listings.some((listing) => listing.enabled) === true
    if (catalog && standards) markServiceAvailability('sharing', !(hasEnabled || standards.length))
    const navButton = (label: string, next: typeof section, refreshAfter = false) => {
      const item = button(label, () => { section = next; selected = undefined; checkout = undefined; clearSecret(); if (refreshAfter) void run(next === 'market' ? refreshPosts : next === 'myPosts' ? refreshMyPosts : refresh) })
      item.className = `share-nav-button${section === next ? ' is-active' : ''}`
      return item
    }
    nav.append(navButton('开始', 'home'), navButton('账号租用', 'rent'), navButton('供需大厅', 'market', true),
      button('发布', () => {
        section = 'publish'; selected = undefined; checkout = undefined; clearSecret()
      }, section === 'publish'), navButton('我的发布', 'myPosts', signedIn()), navButton('我的租单', 'orders', signedIn()))
    const notice = el('p', message); notice.setAttribute('role', 'status')
    const header = el('header', '', 'share-header')
    header.append(el('h2', section === 'home' ? '账号分享' : section === 'rent' ? '账号租用' : section === 'market' ? '供需大厅' : section === 'publish' ? '发布' : section === 'myPosts' ? '我的发布' : '我的租单'))
    if (section === 'home') header.append(el('p', '账号租用和 API 租用均可发布。API 服务分为额度包、周期包；需求者和供给者都按标准模板发布，并填写自己的价格。'))
    root.replaceChildren(header, nav, notice)
    if (section === 'home') { root.append(renderHome()); return }
    if (section === 'rent' && checkout) { root.append(renderCheckout(checkout)); return }
    if (section === 'orders' && selected) { root.append(renderOrder(selected)); return }
    if (section === 'rent') {
      if (!catalog) root.append(el('p', message ? '暂时无法读取可租账号。' : '正在读取可租的共享账号…'), button('重新读取', () => run(async () => { catalog = await result<SharingCatalog>(api.catalog()) })))
      else if (!catalog.listings.length) {
        const empty = el('section', '', 'share-detail')
        empty.append(el('h3', '暂时无可直接下单的账号'), el('p', '你可以到供需大厅查看发布，或用标准模板发布账号需求或供给。'),
          button('联系来信客服', revealSupport), button('发布账号供需', () => {
            publishProductId = 'account-rental'; section = 'publish'; clearSecret()
          }))
        root.append(empty)
      } else {
        const switcher = el('div', '', 'plan-switch'); switcher.setAttribute('role', 'tablist'); switcher.setAttribute('aria-label', '共享账号软件')
        const entries: [SharingSoftware, string][] = [['codex', 'Codex'], ['claude', 'Claude Code']]
        entries.forEach(([id, label]) => {
          const tab = el('button', label); tab.type = 'button'; tab.dataset.planSoftware = id
          tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(software === id)); tab.tabIndex = software === id ? 0 : -1
          tab.onclick = () => { software = id; checkout = undefined; render() }
          switcher.append(tab)
        })
        switcher.onkeydown = (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : software === 'codex' ? 1 : 0
          software = entries[index]![0]; checkout = undefined; render()
          root.querySelector<HTMLButtonElement>(`.plan-switch [data-plan-software="${software}"]`)?.focus()
        }
        root.append(switcher)
        const listings = catalog.listings.filter((listing) => listing.software === software)
        if (!listings.length) root.append(el('p', software === 'codex' ? 'Codex 共享账号暂时无可直接下单档位，可到供需大厅查看。' : 'Claude Code 共享账号暂时无可直接下单档位，可到供需大厅查看。', 'share-muted'))
        const cards = el('div', '', 'plan-cards')
        for (const listing of listings) {
          cards.append(planCard({
            name: listing.name, description: listing.description, price: money(listing.priceCents), termSuffix: ` · ${listing.term}`,
            cta: listing.enabled ? '查看租约与办理说明' : '暂未开放', disabled: busy || !listing.enabled,
            onChoose: () => { checkout = listing; render() },
            features: [`付款后 ${listing.deliveryHours} 小时内人工办理交接`, `已含账号分享服务费 ${money(listing.serviceFeeCents)}，网络费用另计`, '租期届满账号由来信收回', '使用约定、取消与退款见办理说明']
          }))
        }
        if (listings.length) root.append(cards)
      }
    } else if (section === 'market') {
      root.append(button('刷新大厅', () => run(refreshPosts)))
      if (!posts) root.append(el('p', '正在读取供需发布…'))
      else if (!posts.length) root.append(el('p', '当前还没有发布中的需求或供给。'))
      else { const cards = el('div', '', 'share-market-grid'); for (const post of posts) cards.append(renderPost(post)); root.append(cards) }
    } else if (section === 'publish') {
      root.append(renderPublish())
    } else if (section === 'myPosts') {
      if (!signedIn()) {
        root.append(el('h3', '我的发布'), el('p', '这里用于查看和关闭自己发布过的需求与供给。登录后显示你的记录。'), button('登录后管理发布', () => { gate() }, true))
      } else {
        root.append(button('刷新我的发布', () => run(refreshMyPosts)))
        if (!myPosts) root.append(el('p', '正在读取我的发布…'))
        else if (!myPosts.length) root.append(el('p', '你还没有发布需求或供给。'))
        else { const cards = el('div', '', 'share-market-grid'); for (const post of myPosts) cards.append(renderPost(post, true)); root.append(cards) }
      }
    } else if (section === 'orders') {
      if (!signedIn()) {
        root.append(el('h3', '我的租单'), el('p', '这里用于查看下单、付款、交付和售后进度。登录后显示你的租单。'), button('登录后查看租单', () => { gate() }, true))
      } else {
        root.append(button('刷新', () => run(refresh)))
        if (!orders.length) root.append(el('p', '还没有租单。'))
        for (const order of orders) { const row = el('article', '', 'share-order-row'); row.append(el('strong', order.listing.name), el('span', statusLabels[order.status]), el('span', money(order.listing.priceCents)), button('查看租单', () => run(() => open(order.id)))); root.append(row) }
        if (nextCursor) root.append(button('查看更早的租单', () => run(() => refresh(nextCursor))))
      }
    }
  }
  const stopAccount = onAccountChange((view) => { if (view.account?.id !== accountId || view.state !== 'signed-in') { accountId = view.account?.id; orders = []; nextCursor = ''; selected = undefined; checkout = undefined; payment = undefined; myPosts = undefined; requests.clear(); clearSecret() } })
  const visibility = () => { if (document.visibilityState === 'hidden') hideOnBlur() }
  document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hideOnBlur)
  const timer = setInterval(() => {
    if (!active || busy || secret || selected?.status !== 'pending_payment' || selected.channel === 'manual' || document.visibilityState === 'hidden') return
    const id = selected.id
    void run(async () => { const response = await result<SharingOrderView>(api.detail({ orderId: id })); if (active && selected?.id === id) selected = response })
  }, 5000)
  render(); void run(async () => {
    const [catalogResult, standardsResult, postsResult] = await Promise.all([
      result<SharingCatalog>(api.catalog()), result<{ products: SharingStandardProduct[] }>(api.standards()), result<{ posts: SharingPostView[] }>(api.posts())
    ])
    catalog = catalogResult; standards = standardsResult.products; posts = postsResult.posts
  })
  return () => { active = false; qrStop?.(); qrStop = undefined; secret = undefined; generation++; clearInterval(timer); stopAccount(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hideOnBlur); root.replaceChildren(); root.classList.remove('sharing-page') }
}

import type { SharingCandidateView, SharingCatalog, SharingDelivery, SharingIntentionStatus, SharingIssue, SharingListing, SharingMyResponseView, SharingOrderView, SharingPayment, SharingPostSide, SharingPostView, SharingProductId, SharingResponseView, SharingSoftware, SharingStandardProduct, SharingStatus } from '../../../sharing-types'
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
const softwareLabels: Record<SharingSoftware, string> = { codex: 'Codex', claude: 'Claude Code' }
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
  let section: 'market' | 'publish' | 'mine' = 'market'
  let software: SharingSoftware = 'codex'
  let catalog: SharingCatalog | undefined; let orders: SharingOrderView[] = []; let nextCursor = ''
  let selected: SharingOrderView | undefined; let checkout: SharingListing | undefined
  let payment: SharingPayment | undefined; let secret: SharingDelivery | undefined
  let standards: SharingStandardProduct[] | undefined; let posts: SharingPostView[] | undefined; let myPosts: SharingPostView[] | undefined
  let myResponses: SharingMyResponseView[] | undefined; let candidates: { demandPostId: string; items: SharingCandidateView[] } | undefined; let expandedDemand = ''
  let pendingRespondDemand = ''
  let publishSide: SharingPostSide = 'demand'; let publishProductId: SharingProductId = 'account-rental'
  let publishSoftware: SharingSoftware = 'codex'; let publishProvider = ''
  let message = ''
  let qrStop: (() => void) | undefined
  const requests = new Map<string, string>()
  const resetTransient = () => { selected = undefined; checkout = undefined; payment = undefined; secret = undefined; generation++ }
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
  const refreshMyResponses = async () => {
    const identity = accountSnapshot().account?.id
    if (!identity) { myResponses = []; return }
    const response = await result<{ responses: SharingMyResponseView[] }>(api.myResponses())
    if (active && identity === accountSnapshot().account?.id) myResponses = response.responses
  }
  const open = async (id: string) => {
    const response = await result<SharingOrderView>(api.detail({ orderId: id }))
    if (active && accountSnapshot().account) { selected = response; checkout = undefined; section = 'mine'; secret = undefined; generation++; payment = undefined }
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
      selected = order; checkout = undefined; section = 'mine'; await refresh()
      if (order.channel !== 'manual' && order.status === 'pending_payment') await pay()
    }) }
    block.append(form, el('p', '共享账号可能违反部分厂商的服务条款，请自行判断后下单。', 'share-boundary')); return block
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
  const specText = (spec: { productId: SharingProductId; accountPlan: string | null; apiProvider: string | null; apiModel: string | null; termDays: number; quotaAmount: number | null; quotaUnit: string | null; usageTier: string | null }): string => {
    const product = findProduct(spec.productId)
    if (!product) return spec.productId
    const parts: string[] = []
    if (spec.productId === 'account-rental') parts.push(choiceLabel(product.accountPlans, spec.accountPlan))
    else {
      parts.push(choiceLabel(product.apiProviders, spec.apiProvider), spec.apiModel ?? '')
      if (spec.productId === 'api-quota') parts.push(`${spec.quotaAmount} ${choiceLabel(product.quotaUnits, spec.quotaUnit)}`)
      else parts.push(choiceLabel(product.usageTiers, spec.usageTier))
    }
    parts.push(choiceLabel(product.termDays, spec.termDays))
    return parts.filter(Boolean).join(' · ')
  }
  const activeResponseFor = (demandPostId: string) => myResponses?.find((item) => item.demandPostId === demandPostId && ['responded', 'presented', 'selected', 'confirmed'].includes(item.status))
  const respondStatusLabels: Record<string, string> = { responded: '已回应 · 等待客服核查', presented: '已入围 · 等待需求方选择', selected: '需求方已选中 · 待你确认', confirmed: '已成交', declined: '你确认了没货，回应已失效', rejected: '未通过核查', withdrawn: '已撤回' }
  const startRespond = (demand: SharingPostView): void => {
    if (!gate()) return
    void run(async () => {
      const mine = await result<{ posts: SharingPostView[] }>(api.myPosts())
      const match = mine.posts.filter((item) => item.side === 'supply' && item.status === 'published' &&
        item.productId === demand.productId && item.software === demand.software).sort((a, b) => b.createdAt - a.createdAt)[0]
      if (match) {
        await result<SharingResponseView>(api.respond({ demandPostId: demand.id, supplyPostId: match.id, requestId: crypto.randomUUID() }))
        await refreshMyResponses(); message = '回应成功，等待来信客服核查；有进展会在「我的发布」显示。'
      } else {
        pendingRespondDemand = demand.id
        publishSide = 'supply'; publishProductId = demand.productId; publishSoftware = demand.software; publishProvider = demand.apiProvider ?? ''
        section = 'publish'; resetTransient(); message = ''
        render()
      }
    })
  }
  const fetchCandidates = async (demandPostId: string): Promise<SharingCandidateView[]> => {
    const response = await result<{ candidates: SharingCandidateView[] }>(api.demandResponses({ demandPostId }))
    return response.candidates
  }
  const toggleCandidates = (demandPostId: string): void => {
    if (expandedDemand === demandPostId) { expandedDemand = ''; candidates = undefined; render(); return }
    expandedDemand = demandPostId; candidates = undefined; render()
    void run(async () => {
      const items = await fetchCandidates(demandPostId)
      if (active && expandedDemand === demandPostId) { candidates = { demandPostId, items }; render() }
    })
  }
  function renderPost(post: SharingPostView, mine = false): HTMLElement {
    const product = findProduct(post.productId)
    const card = el('article', '', 'share-market-card')
    const demand = post.side === 'demand'
    card.append(el('span', demand ? '求' : '供', `share-badge share-badge-${post.side}`), el('h3', product?.label ?? post.productId),
      el('p', postDescription(post)), el('p', `${demand ? '愿付' : '报价'} ${money(post.priceCents)}`, 'share-price'))
    if (!demand) card.append(el('p', `可提供 ${post.availableCount} 份 · ${post.deliveryHours} 小时内交付`))
    if (mine && !demand && myResponses) {
      for (const response of myResponses.filter((item) => item.supplyPostId === post.id && !['withdrawn', 'rejected'].includes(item.status))) {
        const demandSpec = response.demand ? specText(response.demand) : response.demandPostId
        card.append(el('p', `回应「${demandSpec}」：${respondStatusLabels[response.status] ?? response.status}`, 'share-response-line'))
        if (response.status === 'selected') card.append(button('确认成交，为对方生成租单', () => run(async () => {
          await result<SharingOrderView>(api.confirmResponse({ responseId: response.id }))
          await Promise.all([refreshMyResponses(), refreshMyPosts()]); message = '已确认成交，已为对方生成租单，等待对方付款。'
        }), true), button('没货了，通知对方', () => run(async () => {
          await result<SharingResponseView>(api.declineResponse({ responseId: response.id }))
          await refreshMyResponses(); message = '已通知对方该候选失效。'
        })))
      }
    }
    card.append(el('p', post.status === 'published' ? (mine ? '已发布 · 等待客服对接' : '等待客服对接') : '已关闭', 'share-muted'))
    if (mine) {
      if (post.status === 'published') {
        if (demand) card.append(button(expandedDemand === post.id ? '收起回应' : '查看回应', () => toggleCandidates(post.id)))
        card.append(button('关闭发布', () => run(async () => {
          await result<SharingPostView>(api.closePost({ postId: post.id })); await Promise.all([refreshPosts(), refreshMyPosts(), refreshMyResponses()]); message = '发布已关闭。'
        })))
      }
    } else if (demand) {
      const responded = activeResponseFor(post.id)
      if (responded) card.append(el('p', respondStatusLabels[responded.status] ?? '已回应', 'share-response-line'))
      else if (signedIn()) card.append(button('回应这个需求', () => startRespond(post), true))
      card.append(button('有疑问？联系客服', () => { void revealSupport() }))
    } else {
      card.append(button('想要类似的，发布需求', () => {
        publishSide = 'demand'; publishProductId = post.productId; publishSoftware = post.software; publishProvider = post.apiProvider ?? ''
        section = 'publish'; resetTransient(); render()
      }))
    }
    if (mine && demand && expandedDemand === post.id) {
      const box = el('div', '', 'share-candidates')
      box.append(el('h3', '回应候选（按契合自行选择；看不到对方身份）'))
      const items = candidates?.demandPostId === post.id ? candidates.items : undefined
      if (items === undefined) box.append(el('p', '正在读取回应…', 'share-muted'))
      else if (!items.length) box.append(el('p', '还没有入围的回应。客服核查通过后会出现在这里。', 'share-muted'))
      else {
        for (const candidate of items) {
          const row = el('div', '', 'share-candidate')
          row.append(el('p', specText(candidate), 'share-candidate-spec'),
            el('p', `报价 ${money(candidate.priceCents)} · 可提供 ${candidate.availableCount} 份 · ${candidate.deliveryHours} 小时内交付`))
          if (candidate.status === 'selected') row.append(el('p', '已选择 · 等待对方确认有货', 'share-response-line'))
          else {
            const channels = catalog?.channels?.length ? catalog.channels : (['manual'] as const)
            const label = el('label', '付款方式'); const select = el('select'); select.name = 'channel'
            for (const channel of channels) { const option = el('option', ({ alipay: '支付宝', wechat: '微信支付', manual: '人工办理' })[channel] ?? channel); option.value = channel; select.append(option) }
            label.append(select)
            row.append(label, button('选择这个报价', () => run(async () => {
              await result<SharingResponseView>(api.selectResponse({ responseId: candidate.responseId, channel: select.value, requestId: crypto.randomUUID() }))
              await refreshMyResponses(); message = '已选择，等待对方确认有货；确认后租单会出现在「我的租单」。'
              candidates = { demandPostId: post.id, items: await fetchCandidates(post.id) }; render()
            })))
          }
          box.append(row)
        }
      }
      card.append(box)
    }
    return card
  }
  const selectField = (labelText: string, name: string, choices: { value: string; label: string }[], value?: string) => {
    const label = el('label', labelText); const select = el('select'); select.name = name
    for (const item of choices) { const option = el('option', item.label); option.value = item.value; select.append(option) }
    select.value = value && choices.some((item) => item.value === value) ? value : choices[0]?.value ?? ''
    label.append(select); return { label, select }
  }
  function renderPublish(): HTMLElement {
    const wrapper = el('section', '', 'share-detail'); wrapper.append(el('h3', '发布需求或供给'),
      el('p', '选一种租法，把规格、期限和你的价格说清楚；客服据此帮你对接。'))
    if (!standards?.length) { wrapper.append(el('p', '正在读取模板…')); return wrapper }
    const product = findProduct(publishProductId) ?? standards[0]!
    publishProductId = product.id
    const sideRow = el('div', '', 'share-side-switch'); sideRow.setAttribute('role', 'group'); sideRow.setAttribute('aria-label', '发布身份')
    for (const [id, label] of [['demand', '我要租'], ['supply', '我要出']] as const) {
      const item = button(label, () => { if (publishSide !== id) { publishSide = id; render() } })
      item.className = `share-side-button${publishSide === id ? ' is-active' : ''}`
      item.setAttribute('aria-pressed', String(publishSide === id))
      sideRow.append(item)
    }
    wrapper.append(sideRow)
    const templateRow = el('div', '', 'share-template-row')
    const templates: [SharingProductId, string, string][] = [
      ['account-rental', '租账号', '按套餐和租期，如「Claude 套餐 × 1 个月」'],
      ['api-quota', '租 API 额度', '按用量包，如「10 万 Tokens × 有效期」'],
      ['api-period', '包月 API', '按用量强度包周期，如「高频使用 × 1 个月」']
    ]
    for (const [id, title, example] of templates) {
      const cell = el('div', '', `share-template-choice${publishProductId === id ? ' is-active' : ''}`)
      const item = button(title, () => { if (publishProductId !== id) { publishProductId = id; render() } })
      item.className = 'share-template-choice-button'
      cell.append(item, el('span', example, 'share-template-choice-example'))
      templateRow.append(cell)
    }
    wrapper.append(templateRow)
    const form = el('form')
    const softwareField = selectField('使用软件', 'software', product.software, publishSoftware)
    publishSoftware = softwareField.select.value as SharingSoftware
    const fields: HTMLElement[] = [softwareField.label]
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
        const published = await result<SharingPostView>(api.publish({ ...payload, requestId }))
        await Promise.all([refreshPosts(), refreshMyPosts()]); requests.delete(key); section = 'mine'
        if (pendingRespondDemand) {
          const demandPostId = pendingRespondDemand; pendingRespondDemand = ''
          try {
            await result<SharingResponseView>(api.respond({ demandPostId, supplyPostId: published.id, requestId: crypto.randomUUID() }))
            await refreshMyResponses(); message = (publishSide === 'demand' ? '需求发布成功。' : '供给发布成功。') + '回应已提交，等待客服核查。'
          } catch (error) {
            message = (publishSide === 'demand' ? '需求发布成功。' : '供给发布成功。') + (error instanceof Error ? error.message : '')
          }
        } else message = publishSide === 'demand' ? '需求发布成功。' : '供给发布成功。'
      })
    }
    wrapper.append(form)
    const expectBox = el('div', '', 'share-expect'); expectBox.append(el('h3', '发布后会发生什么'))
    const steps = el('ol', '', 'share-expect-steps')
    steps.append(el('li', '客服核对你的发布内容。'), el('li', '有匹配对象时，客服通过企业微信联系你，确认成交与付款。'), el('li', '随时可以在「我的」里关闭发布。'))
    expectBox.append(steps, el('p', '发布不收集账号密码、API Key 和联系方式。共享账号可能违反部分厂商的服务条款，请自行判断后发布。', 'share-boundary'))
    wrapper.append(expectBox)
    return wrapper
  }
  const groupHead = (title: string, note: string): HTMLElement => {
    const head = el('div', '', 'share-group-head'); head.append(el('h3', title), el('span', note, 'share-group-note')); return head
  }
  function renderMarket(): HTMLElement {
    const market = el('section', '', 'share-market-page')
    const trust = el('div', '', 'share-trust')
    for (const item of ['人工核对交付', '到期收回换密', '交付资料仅本人可见', '售后走客服']) trust.append(el('span', item, 'share-trust-item'))
    market.append(trust)
    const switcher = el('div', '', 'plan-switch'); switcher.setAttribute('role', 'tablist'); switcher.setAttribute('aria-label', '共享账号软件')
    ;(['codex', 'claude'] as const).forEach((id) => {
      const tab = el('button', softwareLabels[id]); tab.type = 'button'; tab.dataset.planSoftware = id
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(software === id)); tab.tabIndex = software === id ? 0 : -1
      tab.onclick = () => { software = id; checkout = undefined; render() }
      switcher.append(tab)
    })
    switcher.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : software === 'codex' ? 1 : 0
      software = index === 0 ? 'codex' : 'claude'; checkout = undefined; render()
      root.querySelector<HTMLButtonElement>(`.plan-switch [data-plan-software="${software}"]`)?.focus()
    }
    market.append(switcher)
    const direct = el('section', '', 'share-group')
    direct.append(groupHead('来信直租', '下单即办理 · 来信托管交接与回收'))
    if (!catalog) direct.append(el('p', message ? '暂时无法读取可租账号。' : '正在读取可租的共享账号…', 'share-muted'),
      button('重新读取', () => run(async () => { catalog = await result<SharingCatalog>(api.catalog()) })))
    else {
      const listings = catalog.listings.filter((item) => item.software === software && item.enabled)
      if (!listings.length) direct.append(el('p', `${softwareLabels[software]}暂无直租档位，可看下方市场发布，或发布需求让客服对接。`, 'share-muted'))
      else {
        const cards = el('div', '', 'plan-cards')
        for (const item of listings) {
          cards.append(planCard({
            name: item.name, description: item.description, price: money(item.priceCents), termSuffix: ` · ${item.term}`,
            cta: '查看并下单', disabled: busy,
            onChoose: () => { checkout = item; render() },
            features: [`付款后 ${item.deliveryHours} 小时内人工办理交接`, `已含账号分享服务费 ${money(item.serviceFeeCents)}，网络费用另计`, '租期届满账号由来信收回', '使用约定、取消与退款见办理说明']
          }))
        }
        direct.append(cards)
      }
    }
    market.append(direct)
    const hall = el('section', '', 'share-group')
    hall.append(groupHead('市场发布', '客服对接成交 · 暂不在线下单'))
    if (!posts) hall.append(el('p', '正在读取市场发布…', 'share-muted'))
    else {
      const visible = posts.filter((post) => post.software === software)
      if (!visible.length) hall.append(el('p', `${softwareLabels[software]}暂无市场发布。没找到合适的？发布需求，客服对接后供给会来找你。`, 'share-muted'))
      else {
        const demandCards = el('div', '', 'share-market-grid'); const supplyCards = el('div', '', 'share-market-grid')
        for (const post of visible) (post.side === 'demand' ? demandCards : supplyCards).append(renderPost(post))
        if (demandCards.children.length) hall.append(el('p', '他们在求租', 'share-sublabel'), demandCards)
        if (supplyCards.children.length) hall.append(el('p', '他们在出租', 'share-sublabel'), supplyCards)
      }
    }
    market.append(hall)
    const fallback = el('section', '', 'share-fallback')
    const wantRent = el('div', '', 'share-fallback-item')
    wantRent.append(el('h3', '没找到合适的？'), el('p', '发布需求，客服 1 个工作日内对接，有匹配就通知你。'),
      button('发布需求', () => { publishSide = 'demand'; publishProductId = 'account-rental'; section = 'publish'; resetTransient(); render() }))
    const wantShare = el('div', '', 'share-fallback-item')
    wantShare.append(el('h3', '有账号或额度想出租？'), el('p', '发布供给，来信客服帮你对接租客，交付与回收由来信办理。'),
      button('发布供给', () => { publishSide = 'supply'; publishProductId = 'account-rental'; section = 'publish'; resetTransient(); render() }, true))
    fallback.append(wantRent, wantShare)
    market.append(fallback)
    return market
  }
  function renderMine(): HTMLElement {
    const wrap = el('section', '', 'share-mine')
    const ordersGroup = el('section', '', 'share-group')
    ordersGroup.append(groupHead('我的租单', '下单、付款、交付与售后进度'))
    if (!signedIn()) ordersGroup.append(el('p', '登录后显示你的租单。', 'share-muted'), button('登录后查看租单', () => { gate() }, true))
    else {
      ordersGroup.append(button('刷新', () => run(refresh)))
      if (!orders.length) ordersGroup.append(el('p', '还没有租单。', 'share-muted'))
      for (const order of orders) { const row = el('article', '', 'share-order-row'); row.append(el('strong', order.listing.name), el('span', statusLabels[order.status]), el('span', money(order.listing.priceCents)), button('查看租单', () => run(() => open(order.id)))); ordersGroup.append(row) }
      if (nextCursor) ordersGroup.append(button('查看更早的租单', () => run(() => refresh(nextCursor))))
    }
    wrap.append(ordersGroup)
    const postsGroup = el('section', '', 'share-group')
    postsGroup.append(groupHead('我的发布', '你发布的需求与供给'))
    if (!signedIn()) postsGroup.append(el('p', '登录后显示你的记录。', 'share-muted'), button('登录后管理发布', () => { gate() }, true))
    else {
      postsGroup.append(button('刷新我的发布', () => run(refreshMyPosts)))
      if (!myPosts) postsGroup.append(el('p', '正在读取我的发布…', 'share-muted'))
      else if (!myPosts.length) postsGroup.append(el('p', '你还没有发布需求或供给。', 'share-muted'))
      else { const cards = el('div', '', 'share-market-grid'); for (const post of myPosts) cards.append(renderPost(post, true)); postsGroup.append(cards) }
    }
    wrap.append(postsGroup)
    return wrap
  }
  function render(): void {
    if (!active) return
    qrStop?.(); qrStop = undefined
    root.classList.add('sharing-page')
    const hasEnabled = catalog?.listings.some((listing) => listing.enabled) === true
    if (catalog && standards) markServiceAvailability('sharing', !(hasEnabled || standards.length))
    const nav = el('nav', '', 'share-nav')
    const navButton = (label: string, next: typeof section, loader?: () => Promise<void>) => {
      const item = button(label, () => { section = next; resetTransient(); render(); if (loader) void run(loader) })
      item.className = `share-nav-button${section === next ? ' is-active' : ''}`
      return item
    }
    nav.append(navButton('租用市场', 'market', async () => { await Promise.all([refreshPosts(), refreshMyResponses()]) }), navButton('发布', 'publish'), navButton('我的', 'mine', async () => { await Promise.all([refresh(), refreshMyPosts(), refreshMyResponses()]) }))
    const notice = el('p', message); notice.setAttribute('role', 'status')
    const header = el('header', '', 'share-header')
    header.append(el('h2', section === 'market' ? '账号与 API 租用' : section === 'publish' ? '发布' : '我的'))
    if (section === 'market') header.append(el('p', '租用 Codex / Claude 账号与 API 额度；来信人工办理交接，客服全程对接。'))
    root.replaceChildren(header, nav, notice)
    if (section === 'market' && checkout) { root.append(renderCheckout(checkout)); return }
    if (section === 'mine' && selected) { root.append(renderOrder(selected)); return }
    if (section === 'market') root.append(renderMarket())
    else if (section === 'publish') root.append(renderPublish())
    else root.append(renderMine())
  }
  const stopAccount = onAccountChange((view) => { if (view.account?.id !== accountId || view.state !== 'signed-in') { accountId = view.account?.id; orders = []; nextCursor = ''; selected = undefined; checkout = undefined; payment = undefined; myPosts = undefined; myResponses = undefined; requests.clear(); clearSecret() } })
  const visibility = () => { if (document.visibilityState === 'hidden') hideOnBlur() }
  document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hideOnBlur)
  const timer = setInterval(() => {
    if (!active || busy || secret || selected?.status !== 'pending_payment' || selected.channel === 'manual' || document.visibilityState === 'hidden') return
    const id = selected.id
    void run(async () => { const response = await result<SharingOrderView>(api.detail({ orderId: id })); if (active && selected?.id === id) selected = response })
  }, 5000)
  // 先启动首屏加载再渲染：busy 状态让导航在加载期保持禁用，避免「切走了分区但数据加载被丢弃」。
  void run(async () => {
    const [catalogResult, standardsResult, postsResult] = await Promise.all([
      result<SharingCatalog>(api.catalog()), result<{ products: SharingStandardProduct[] }>(api.standards()), result<{ posts: SharingPostView[] }>(api.posts())
    ])
    catalog = catalogResult; standards = standardsResult.products; posts = postsResult.posts
    if (signedIn()) await refreshMyResponses()
  })
  render()
  return () => { active = false; qrStop?.(); qrStop = undefined; secret = undefined; generation++; clearInterval(timer); stopAccount(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hideOnBlur); root.replaceChildren(); root.classList.remove('sharing-page') }
}

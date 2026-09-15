import type { AccountView, CommercialTerms } from '../../../account-types'
import type { TunnelStatusView } from '../../../preload/api/tunnel'
import { trialClaimDescription, trialClaimLabel, trialClaimTitle, trialEligibilityCopy, trialStepCopy } from '../../../commercial-copy'
import { actionButton, textNode } from './account-overview'

export type OnboardingAction = 'register' | 'claim' | 'sync' | 'start' | 'refresh' | 'account' | 'tunnel' | 'download' | 'support' | 'none'
export interface NetworkOnboardingView {
  step: 1 | 2 | 3 | 4
  title: string
  description: string
  label: string
  action: OnboardingAction
  terms: CommercialTerms | null
}

export function buildNetworkOnboarding(account: AccountView, status: TunnelStatusView | null | undefined): NetworkOnboardingView {
  const terms = account.terms ?? null
  const view = (step: NetworkOnboardingView['step'], title: string, description: string, label: string, action: OnboardingAction): NetworkOnboardingView => ({ step, title, description, label, action, terms })
  if (status?.unrestored || status?.componentMissing || status?.state === '异常') {
    return view(3, '连接遇到问题，先处理再继续', status.unrestored || status.componentMissing || status.message || '请到网络页查看原因；也可以联系来信客服。', '查看连接问题', 'tunnel')
  }
  if (status?.state === '通道待确认' || status?.authorization === '保留先前连接，等待重新核验') {
    return view(3, '正在重新确认网络', status.message, '查看连接状态', 'tunnel')
  }
  if (status?.state === '已连') {
    return view(4, '查看 Codex 下载与版本', '网络已连接。到 Codex 的“下载/版本信息”查看本机版本，或打开官方下载页；完成安装后即可登录使用。', '查看下载/版本', 'download')
  }
  if (account.code === 'ACCOUNT_NOT_CONFIGURED') {
    return view(1, '账号服务还没接通', '目前无法注册或登录，请联系来信客服确认开放时间。无需自己填写服务器地址。', '联系来信客服', 'support')
  }
  if (account.state === 'unavailable') {
    return view(1, account.code ? '暂时读不到账号状态' : '正在读取账号状态', account.code ? '请重试；仍不成功可以联系来信客服。' : '稍等一下，工具箱会找到你当前该做的步骤。', account.code ? '重新检查' : '读取中…', account.code ? 'refresh' : 'none')
  }
  if (account.state !== 'signed-in') {
    return view(1, '先注册账号', '账号自己取名，不需要手机或邮箱。注册后请保存恢复码，忘记密码时用它找回；保存后会回到这里继续。', '注册并继续', 'register')
  }
  const overview = account.overview
  if (!overview || !overview.networkAvailable) {
    return view(2, '网络体验暂时无法领取', '账号已登录，但网络服务暂未就绪。请稍后重新检查，或联系来信客服；不用找配置文件，也不用重新注册。', '重新检查', 'refresh')
  }
  const trial = overview.trial.usage
  const paid = overview.subscription
  if (!trial && !paid && !overview.trial.available) return view(2, '暂时无法确认体验领取资格', trialEligibilityCopy(terms), '重新检查', 'refresh')
  const usable = trial?.state === 'active' || paid?.state === 'active'
  if (!usable) {
    if (trial?.state === 'unknown' || paid?.state === 'unknown') {
      return view(2, '暂时无法确认剩余流量', '正在等待服务端提供可用状态。请重新检查，不需要再次注册或付款。', '重新检查', 'refresh')
    }
    if ((overview.trial.retryable ?? trial?.state === 'provisioning') || overview.trial.available) {
      return view(2, trial ? '继续准备你的体验网络' : trialClaimTitle(terms), trial ? '上次开通尚未完成，可以继续准备。从未开通成功且已过期的体验可补发一次。' : trialClaimDescription(terms), trial ? '继续领取' : trialClaimLabel(terms), 'claim')
    }
    if (paid?.state === 'pending') {
      return view(2, '网络套餐申请待确认', '申请已提交，付款与开通尚未确认。请到流量与套餐查看申请；如已付款，请联系来信客服核对。', '查看流量与套餐', 'account')
    }
    if (paid?.state === 'provisioning') {
      return view(2, '套餐正在开通', '服务端正在准备网络配置。请到流量与套餐重新检查；若一直未完成，请联系来信客服。', '查看流量与套餐', 'account')
    }
    return view(2, '当前没有可用流量', `${trial ? '已领取的体验不能重复领取。' : '目前没有体验领取记录。'}请到流量与套餐查看状态，开通或续费问题可联系来信客服。`, '查看流量与套餐', 'account')
  }
  if (status === undefined || status === null) {
    return view(3, status === null ? '暂时读不到连接状态' : '正在准备连接', '流量已可用，等配置和连接状态确认后再继续。', status === null ? '重新检查' : '读取中…', status === null ? 'refresh' : 'none')
  }
  if (status.state === '连接中') {
    return view(3, '正在连接，请稍等', '工具箱正在检查线路。结果会自动更新，请不要重复点击。', '连接中…', 'none')
  }
  if (!status.currentConfig || status.pendingAvailable) {
    return view(3, '流量已就绪，继续准备连接', '工具箱会领取并检查属于你的网络配置。无需填写节点、复制链接或导入文件。', '准备网络配置', 'sync')
  }
  return view(3, '配置已准备好，点击连接', '点击后会连接来信网络。看到“网络已连接”后，再打开需要使用的 AI；主动断开后需要你再次点击连接。', '连接网络', 'start')
}

const stepDescriptions = (terms: CommercialTerms | null) => ({
  1: { label: '注册或登录', title: '先注册账号', description: '注册来信账号，用于领取体验流量和管理网络套餐。' },
  2: trialStepCopy(terms),
  3: { label: '连接网络', title: '连接网络', description: '领取流量后，工具箱会准备网络配置。点击连接，等状态显示“已连接”后即可使用。' },
  4: { label: '下载与版本', title: '查看 Codex 下载与版本', description: '到 Codex 的“下载/版本信息”查看本机版本，或打开官方下载页；完成安装后即可登录使用。' }
})

export function renderNetworkOnboarding(element: HTMLElement, view: NetworkOnboardingView, busy: boolean, message: string, run: (action: OnboardingAction) => void, selectStep: (step: NetworkOnboardingView['step']) => void, selectedStep = view.step): void {
  const descriptions = stepDescriptions(view.terms)
  const preview = selectedStep !== view.step
  const content = preview ? descriptions[selectedStep] : view
  element.className = 'network-onboarding'
  element.setAttribute('aria-label', '首次使用引导')
  element.setAttribute('aria-busy', String(busy))
  const header = document.createElement('div'); header.className = 'onboarding-header'
  header.append(textNode('p', '第一次使用，跟着这四步走', 'section-eyebrow'), textNode('span', `${preview ? `查看第 ${selectedStep} 步 · ` : ''}当前第 ${view.step} 步`, 'onboarding-count'))
  const steps = document.createElement('ol'); steps.className = 'onboarding-steps'
  for (const step of [1, 2, 3, 4] as const) {
    const item = textNode('li', '')
    if (step === view.step) item.setAttribute('aria-current', 'step')
    item.dataset.selected = String(step === selectedStep)
    const tab = actionButton('', () => selectStep(step)); tab.className = 'onboarding-step'
    tab.dataset.onboardingStep = String(step)
    tab.setAttribute('aria-pressed', String(step === selectedStep))
    tab.setAttribute('aria-controls', 'network-onboarding-content')
    tab.append(textNode('span', String(step), 'onboarding-number'), textNode('span', descriptions[step].label))
    item.append(tab)
    steps.append(item)
  }
  const copy = document.createElement('div'); copy.className = 'onboarding-copy'; copy.setAttribute('role', 'status')
  copy.id = 'network-onboarding-content'
  copy.append(textNode('h2', content.title), textNode('p', content.description))
  const actions = document.createElement('div'); actions.className = 'onboarding-actions'
  if (preview) actions.append(textNode('span', `第${selectedStep}步`, 'onboarding-step-label'))
  else {
    const trigger = actionButton(busy ? '正在处理，请稍等…' : view.label, () => run(view.action), true)
    trigger.dataset.onboardingAction = view.action; trigger.disabled = busy || view.action === 'none'
    actions.append(trigger)
  }
  const feedback = textNode('p', preview ? '' : message, 'onboarding-feedback'); feedback.setAttribute('role', 'status')
  element.replaceChildren(header, steps, copy, actions, feedback)
}

import type { CommercialTerms } from './account-types'

// 商业文案唯一生成处:所有价格/体验额度文案都由下发的 CommercialTerms 格式化而来,
// 客户端不得自写数字。terms 缺省(旧后台)时退化为不含具体数字的通用表述。

const gb = (bytes: number): string => `${Math.round(bytes / 1024 ** 3)} GB`

/** 领取体验成功后的确认文案。 */
export function trialClaimedCopy(terms?: CommercialTerms | null): string {
  return terms
    ? `体验权益已记录，领取后 ${terms.trial.hours} 小时有效；网络页可查看连接状态。`
    : '体验权益已记录；网络页可查看连接状态。'
}

/** 账号总览体验卡标题。 */
export function trialCardTitle(terms?: CommercialTerms | null): string {
  return terms ? `体验流量 · ${gb(terms.trial.bytes)} / ${terms.trial.hours} 小时` : '体验流量'
}

/** 账号总览体验卡未领取说明。 */
export function trialCardHint(terms?: CommercialTerms | null): string {
  return terms
    ? `注册登录后可免费领取，领取时开始计算 ${terms.trial.hours} 小时，每个账号限领一次。后续套餐另付费。`
    : '注册登录后可免费领取，每个账号限领一次。后续套餐另付费。'
}

/** 领取按钮文案。 */
export function trialClaimLabel(terms?: CommercialTerms | null): string {
  return terms ? `领取 ${gb(terms.trial.bytes)} 体验流量` : '领取体验流量'
}

/** 引导页领取步骤主标题。 */
export function trialClaimTitle(terms?: CommercialTerms | null): string {
  return terms ? `领取免费的 ${gb(terms.trial.bytes)} 体验` : '领取免费体验'
}

/** 引导页领取步骤说明(计时、次数、设备上限)。 */
export function trialClaimDescription(terms?: CommercialTerms | null): string {
  return terms
    ? `点击领取时开始计时，${terms.trial.hours} 小时内有效，每个账号一次。工具箱会自动准备你的网络配置，不会扣款。一份配置最多 ${terms.deviceLimit} 台设备同时使用，流量总额另计。`
    : '点击领取时开始计时，每个账号一次。工具箱会自动准备你的网络配置，不会扣款。一份配置有多台设备上限，流量总额另计。'
}

/** 无法确认领取资格时的说明。 */
export function trialEligibilityCopy(terms?: CommercialTerms | null): string {
  return terms
    ? `注册登录后可免费领取一次 ${gb(terms.trial.bytes)} 体验。请重新检查；若仍不能领取，请联系来信客服，无需再次注册或付款。`
    : '注册登录后可免费领取一次体验。请重新检查；若仍不能领取，请联系来信客服，无需再次注册或付款。'
}

/** 引导页步骤列表中的领取步骤固定文案。 */
export function trialStepCopy(terms?: CommercialTerms | null): { label: string; title: string; description: string } {
  return {
    label: '领取体验',
    title: trialClaimLabel(terms),
    description: terms
      ? `注册后可免费领取 ${gb(terms.trial.bytes)} 体验流量。领取时开始计时，${terms.trial.hours} 小时内有效，每个账号一次。一份配置最多 ${terms.deviceLimit} 台设备同时使用，流量总额另计。`
      : '注册后可免费领取体验流量。领取时开始计时，每个账号一次。一份配置有多台设备上限，流量总额另计。'
  }
}

/** 安装页网络闸提示:缺少下载网络时引导去领取体验或购买套餐。 */
export function installNetworkGateCopy(terms: CommercialTerms | null | undefined, state: string): string {
  const suffix = state === '未配置'
    ? (terms ? `请到「AI网络」领取 ${gb(terms.trial.bytes)} 体验或购买套餐并连接，再下载安装。` : '请到「AI网络」领取体验或购买套餐并连接，再下载安装。')
    : '请先到「AI网络」连接后再试。'
  return state === '已连'
    ? '官方站点暂时连不上。AI网络已连接，请稍后重试；若持续失败请联系客服。'
    : `缺少下载网络：这台电脑现在连不上官方站点。${suffix}`
}

/** 账号页邀请卡说明（一级直接邀请、双方各得限时流量）。 */
export function inviteCardHint(terms?: CommercialTerms | null): string {
  return terms?.invite
    ? `邀请好友注册，双方各得 ${gb(terms.invite.bytes)} 流量，好友和你的奖励都从发放起 ${terms.invite.hours} 小时内有效。`
    : '邀请好友注册，双方各得一份限时体验流量。'
}

/** 注册页邀请码框说明。 */
export function inviteFieldHint(terms?: CommercialTerms | null): string {
  return terms?.invite ? `选填。填写好友的邀请码，注册成功后你和好友各得 ${gb(terms.invite.bytes)} 流量。` : '选填。填写好友的邀请码，注册成功后双方各得限时体验流量。'
}

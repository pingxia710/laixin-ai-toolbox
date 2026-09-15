import { isTabId, isMorePlatformId, type TabId, type UsagePlatformId } from './tabs'
import type { DiagnosticSoftware } from '../../network-diagnostics-types'
import { modelProviderIds, type ModelProviderId } from '../../shared/model-providers'

export const TAB_NAVIGATION_EVENT = 'toolbox:navigate'

// 导航上不标「暂未开放」（创始人 09-12 定）：只记一个数据属性，页面自己说明；外观与其他项一致。
export function markServiceAvailability(tab: 'sharing' | 'purchase', unavailable: boolean): void {
  const button = document.querySelector<HTMLElement>(`#tab-${tab}`)
  if (!button) return
  button.classList.remove('service-unavailable')
  button.querySelector('.nav-availability')?.remove()
  button.removeAttribute('aria-description')
  button.dataset.serviceUnavailable = unavailable ? 'true' : 'false'
}

interface TabNavigationDetail {
  readonly tab: TabId | 'install'
  readonly usagePlatform?: UsagePlatformId
  readonly platformSection?: 'model-api' | 'download'
  /** 落地后要定位到的服务商那一行（「去填写 / 检查 Key」用）。 */
  readonly modelApiProvider?: ModelProviderId
  /** 从出错的软件跳进分层检查时，带上是哪个软件，落地即预选。 */
  readonly diagnosticSoftware?: DiagnosticSoftware
}

const diagnosticSoftwares: readonly DiagnosticSoftware[] = ['codex', 'claude', 'hermes']

export function requestTabNavigation(tab: TabId, target: Document = document): void {
  target.dispatchEvent(new CustomEvent<TabNavigationDetail>(TAB_NAVIGATION_EVENT, { detail: { tab } }))
}

export function requestModelApiNavigation(usagePlatform: UsagePlatformId, target: Document = document, modelApiProvider?: ModelProviderId): void {
  target.dispatchEvent(new CustomEvent<TabNavigationDetail>(TAB_NAVIGATION_EVENT,
    { detail: { tab: 'usage', usagePlatform, platformSection: 'model-api', ...(modelApiProvider ? { modelApiProvider } : {}) } }))
}

export function requestPlatformDownloadNavigation(usagePlatform: UsagePlatformId, target: Document = document): void {
  target.dispatchEvent(new CustomEvent<TabNavigationDetail>(TAB_NAVIGATION_EVENT,
    { detail: { tab: 'usage', usagePlatform, platformSection: 'download' } }))
}

/** 从模型 API 的失败行直接进分层检查，并预选出问题的那个软件。 */
export function requestNetworkDiagnosticNavigation(software: DiagnosticSoftware, target: Document = document): void {
  target.dispatchEvent(new CustomEvent<TabNavigationDetail>(TAB_NAVIGATION_EVENT, { detail: { tab: 'tunnel', diagnosticSoftware: software } }))
}

export function requestedDiagnosticSoftware(event: Event): DiagnosticSoftware | undefined {
  const detail = (event as Event & { readonly detail?: unknown }).detail
  if (requestedTab(event) !== 'tunnel' || typeof detail !== 'object' || detail === null || !('diagnosticSoftware' in detail) ||
    !diagnosticSoftwares.includes(detail.diagnosticSoftware as DiagnosticSoftware)) return undefined
  return detail.diagnosticSoftware as DiagnosticSoftware
}

export function requestedModelApiPlatform(event: Event): UsagePlatformId | undefined {
  const detail = (event as Event & { readonly detail?: unknown }).detail
  if (typeof detail !== 'object' || detail === null || !('tab' in detail) || detail.tab !== 'usage' ||
    !('platformSection' in detail) || detail.platformSection !== 'model-api' || !('usagePlatform' in detail) || !isMorePlatformId(detail.usagePlatform)) return undefined
  return detail.usagePlatform
}

export function requestedPlatformDownloadPlatform(event: Event): UsagePlatformId | undefined {
  const detail = (event as Event & { readonly detail?: unknown }).detail
  if (typeof detail !== 'object' || detail === null || !('tab' in detail)) return undefined
  if (detail.tab === 'install') return 'codex'
  if (requestedTab(event) !== 'usage' || !('platformSection' in detail) || detail.platformSection !== 'download' ||
    !('usagePlatform' in detail) || !isMorePlatformId(detail.usagePlatform)) return undefined
  return detail.usagePlatform
}

/** 落地后要定位到哪一家服务商；只认已注册的服务商名，且必须是一次模型接入请求。 */
export function requestedModelApiProvider(event: Event): ModelProviderId | undefined {
  const detail = (event as Event & { readonly detail?: unknown }).detail
  if (requestedModelApiPlatform(event) === undefined || typeof detail !== 'object' || detail === null ||
    !('modelApiProvider' in detail) || !(modelProviderIds as readonly unknown[]).includes(detail.modelApiProvider)) return undefined
  return detail.modelApiProvider as ModelProviderId
}

export function requestedTab(event: Event): TabId | undefined {
  const detail = (event as Event & { readonly detail?: unknown }).detail
  if (typeof detail === 'object' && detail !== null && 'tab' in detail && detail.tab === 'install') return 'usage'
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('tab' in detail) ||
    typeof detail.tab !== 'string' ||
    !isTabId(detail.tab)
  ) {
    return undefined
  }
  return detail.tab
}

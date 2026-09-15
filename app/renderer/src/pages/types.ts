import type { TabId, UsagePlatformId } from '../tabs'
import type { DiagnosticSoftware } from '../../../network-diagnostics-types'
import type { ModelProviderId } from '../../../shared/model-providers'

export interface PageContext {
  readonly tab: TabId
  readonly usagePlatform?: UsagePlatformId
  readonly platformSection?: 'model-api' | 'download'
  /** 进「模型 API」后要定位并展开的服务商那一行。 */
  readonly modelApiProvider?: ModelProviderId
  /** 从出错的软件跳进来时预选的诊断对象。 */
  readonly diagnosticSoftware?: DiagnosticSoftware
}

export interface PageModule {
  readonly moduleId: string
  readonly tab: TabId
  readonly order: number
  mount(element: HTMLElement, context: PageContext): void
  unmount(): void
}

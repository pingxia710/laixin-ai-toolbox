import { skeletonTabs, type TabId } from './tabs'
import type { PageModule } from './pages/types'

interface PageModuleExport {
  readonly page: PageModule
}

export interface PageRegistry {
  readonly tabIds: readonly TabId[]
  modulesFor(tab: TabId): readonly PageModule[]
}

export function buildPageRegistry(modules: readonly PageModule[]): PageRegistry {
  const tabs = new Set<TabId>(skeletonTabs.map((tab) => tab.id))
  const seenModuleIds = new Set<string>()
  const byTab = new Map<TabId, PageModule[]>(skeletonTabs.map((tab) => [tab.id, []]))

  for (const module of modules) {
    if (!tabs.has(module.tab)) {
      throw new Error('PAGE_MODULE_TAB_INVALID')
    }
    if (seenModuleIds.has(module.moduleId)) {
      throw new Error('PAGE_MODULE_DUPLICATE')
    }
    seenModuleIds.add(module.moduleId)
    byTab.get(module.tab)?.push(module)
  }

  for (const tabModules of byTab.values()) {
    tabModules.sort((left, right) => left.order - right.order || left.moduleId.localeCompare(right.moduleId))
  }

  return {
    tabIds: skeletonTabs.map((tab) => tab.id),
    modulesFor: (tab) => byTab.get(tab) ?? []
  }
}

export function collectPageModules(modules: Readonly<Record<string, unknown>>): PageModule[] {
  return Object.keys(modules)
    .sort()
    .map((path) => {
      const candidate = modules[path]
      if (!isPageModuleExport(candidate)) {
        throw new Error('PAGE_MODULE_INVALID')
      }
      return candidate.page
    })
}

function isPageModuleExport(value: unknown): value is PageModuleExport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'page' in value &&
    isPageModule(value.page)
  )
}

function isPageModule(value: unknown): value is PageModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'moduleId' in value &&
    typeof value.moduleId === 'string' &&
    'tab' in value &&
    typeof value.tab === 'string' &&
    'order' in value &&
    typeof value.order === 'number' &&
    'mount' in value &&
    typeof value.mount === 'function' &&
    'unmount' in value &&
    typeof value.unmount === 'function'
  )
}

const discoveredModules = import.meta.glob(
  ['./pages/*.ts', '!./pages/types.ts', '!./pages/*.test.ts'],
  { eager: true }
)
export const pageRegistry = buildPageRegistry(collectPageModules(discoveredModules))

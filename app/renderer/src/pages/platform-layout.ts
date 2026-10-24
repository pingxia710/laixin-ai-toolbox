import { platformIcon } from '../platform-icons'
import { morePlatformEntries, readPinnedPlatformIds } from '../tabs'
import { requestTabNavigation } from '../navigation'
import type { PageModule } from './types'

function list(platformIds: readonly string[]): HTMLUListElement {
  const element = document.createElement('ul')
  element.className = 'platform-layout-platform-list'
  for (const platformId of platformIds) {
    const platform = morePlatformEntries.find((entry) => entry.id === platformId)
    if (platform === undefined) continue
    const item = document.createElement('li')
    item.append(platformIcon(platform.id), document.createTextNode(platform.label))
    element.append(item)
  }
  return element
}

export const page: PageModule = {
  moduleId: 'platform-layout',
  tab: 'platform-layout',
  order: 10,
  mount: (element) => {
    const pinned = readPinnedPlatformIds(window.localStorage)
    const available = morePlatformEntries.filter((platform) => !pinned.includes(platform.id)).map((platform) => platform.id)
    const root = document.createElement('section')
    root.className = 'platform-layout-page'
    const header = document.createElement('header')
    header.className = 'platform-layout-header'
    header.append(
      Object.assign(document.createElement('h2'), { textContent: '管理平台布局' }),
      Object.assign(document.createElement('p'), { textContent: '查看六个平台当前在左侧导航还是更多平台。布局调整仍可直接在左侧完成。' })
    )
    const summary = document.createElement('div')
    summary.className = 'platform-layout-summary'
    const pinnedColumn = document.createElement('section')
    pinnedColumn.className = 'platform-layout-column'
    pinnedColumn.append(
      Object.assign(document.createElement('h3'), { textContent: '左侧导航' }),
      Object.assign(document.createElement('p'), { textContent: '已放入的平台可拖动调整顺序，拖到「更多平台」上或按 Delete 键可收回。' }),
      list(pinned)
    )
    const availableColumn = document.createElement('section')
    availableColumn.className = 'platform-layout-column'
    availableColumn.append(
      Object.assign(document.createElement('h3'), { textContent: '更多平台' }),
      Object.assign(document.createElement('p'), { textContent: '未放入左栏的平台会显示在这里，可通过加号加入。' }),
      list(available)
    )
    summary.append(pinnedColumn, availableColumn)
    const note = document.createElement('p')
    note.className = 'platform-layout-note'
    note.textContent = '这是当前的轻量布局管理页，后续可以在这里扩展更细的管理能力。'
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'secondary-action'
    back.textContent = '返回仪表盘'
    back.addEventListener('click', () => requestTabNavigation('dashboard'))
    root.append(header, summary, note, back)
    element.replaceChildren(root)
  },
  unmount: () => undefined
}

import type { UsagePlatformId } from '../tabs'
import type { ModelProviderId } from '../../../shared/model-providers'
import { accessShell } from './model'
import { mountInstallCard } from './install-card'
import { mountModelApi } from './model-api'
import { mountAccountOverview, type MountUsage } from './overview'
import './styles.css'
import './hidden-state.css'

export function mountPlatformPage(element: HTMLElement, platform: UsagePlatformId, mountUsage: MountUsage, initialSection?: 'model-api' | 'download',
  focusProvider?: ModelProviderId): () => void {
  let active = 0
  let teardown = (): void => undefined
  const shell = accessShell(platform)
  const root = document.createElement('section'); root.className = 'platform-page'; root.dataset.platformPage = platform
  const tabs = document.createElement('div'); tabs.className = 'platform-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'AI 详情')
  const content = document.createElement('div'); content.id = 'platform-tab-panel'; content.setAttribute('role', 'tabpanel')
  const labels = shell ? ['账号总览', '模型 API', '下载/版本信息'] : ['账号总览', '模型 API']
  const buttons = labels.map((label, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label
    button.id = `platform-detail-${index}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', content.id)
    button.onclick = () => show(index)
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? labels.length - 1 : (active + (event.key === 'ArrowRight' ? 1 : -1) + labels.length) % labels.length
      show(next); buttons[next].focus()
    }
    tabs.append(button); return button
  })
  const show = (index: number): void => {
    teardown(); active = index; content.replaceChildren(); content.setAttribute('aria-labelledby', buttons[index].id)
    buttons.forEach((button, i) => { button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1 })
    // 只有被导航带进来的第一次才定位到某一行；客户自己点回这个页签时 ⛔ 又把编辑器弹开。
    if (index === 1) { const focus = focusProvider; focusProvider = undefined; teardown = mountModelApi(content, platform, window.toolbox.aiaccess, focus); return }
    if (index === 2) {
      const install = document.createElement('section'); install.className = 'platform-card platform-install-card platform-version-card'
      content.append(install); teardown = mountInstallCard(install, platform); return
    }
    if (shell) {
      teardown = mountAccountOverview(content, platform, window.toolbox.aiaccess, mountUsage, () => { show(1); buttons[1].focus() })
      return
    }
    const overview = document.createElement('div'); overview.className = 'platform-overview'
    const install = document.createElement('section'); install.className = 'platform-card platform-install-card'
    const usage = document.createElement('section'); usage.className = 'platform-card platform-usage-card'
    overview.append(install, usage); content.append(overview)
    const stopInstall = mountInstallCard(install, platform)
    const stopUsage = mountUsage(usage)
    teardown = () => { stopInstall(); stopUsage() }
  }
  const header = document.createElement('header'); header.className = 'platform-page-header'; header.append(tabs)
  if (shell) {
    // 固定回到当前 AI 的「模型 API」页，避免把新手带到外部领 Key 页面。
    const apiEntry = document.createElement('button'); apiEntry.type = 'button'; apiEntry.className = 'platform-deepseek-brand'
    apiEntry.textContent = '使用 API 开放平台'; apiEntry.title = '打开模型 API 配置'; apiEntry.setAttribute('aria-label', '使用 API 开放平台：打开模型 API 配置')
    apiEntry.onclick = () => { show(1); buttons[1].focus() }
    header.append(apiEntry)
  }
  root.append(header, content); element.replaceChildren(root); show(initialSection === 'model-api' ? 1 : initialSection === 'download' && shell ? 2 : 0)
  return () => { teardown(); element.replaceChildren() }
}

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('Windows 与 Mac 共用现行页面', () => {
  it('退役的整页安装入口不再注册，也不会被本机旧选择重新渲染', () => {
    expect(existsSync(join(root, 'app/renderer/src/pages/install.ts'))).toBe(false)
    expect(existsSync(join(root, 'app/renderer/src/ui/service-choice.ts'))).toBe(false)
    expect(existsSync(join(root, 'app/renderer/src/install-resume.ts'))).toBe(false)

    const tabs = read('app/renderer/src/tabs.ts')
    const dashboard = read('app/renderer/src/pages/dashboard.ts')
    expect(tabs).not.toContain("'install'")
    expect(dashboard).not.toContain('toolbox-service-choice')
    expect(dashboard).not.toContain('renderServiceChoice')
    expect(dashboard).not.toContain('这次想先做什么')
  })

  it('所有现行客户入口都不再指向旧安装页', () => {
    const paths = [
      'app/renderer/src/pages/dashboard.ts',
      'app/renderer/src/pages/codex-usage.ts',
      'app/renderer/src/platform/official-account.ts',
      'app/renderer/src/platform/model-api.ts',
      'app/renderer/src/ui/network-onboarding.ts',
      'app/renderer/src/ui/account-services.ts',
      'app/main/desktop/runtime.ts'
    ]
    for (const path of paths) {
      const source = read(path)
      expect(source, path).not.toContain("requestTabNavigation('install')")
      expect(source, path).not.toContain("show('install')")
      expect(source, path).not.toContain('前往安装 AI')
      expect(source, path).not.toContain('只安装 AI')
    }
  })

  it('旧 install 导航有明确迁移落点，具体软件下载入口可直达下载版本页', () => {
    const navigation = read('app/renderer/src/navigation.ts')
    const platform = read('app/renderer/src/platform/view.ts')
    expect(navigation).toContain("detail.tab === 'install'")
    expect(navigation).toContain('requestPlatformDownloadNavigation')
    expect(platform).toContain("'download'")
  })

  it('现行 Electron 验收脚本不再把退役页面当作正确结果', () => {
    const scripts = readdirSync(join(root, 'scripts'))
      .filter((name) => name.endsWith('.mjs') && name !== 'verify-dashboard-console.mjs')

    for (const name of scripts) {
      const source = read(`scripts/${name}`)
      expect(source, name).not.toContain('这次想先做什么')
      expect(source, name).not.toContain('只安装 AI')
      expect(source, name).not.toContain('toolbox-install-resume-v1')
      expect(source, name).not.toContain("name: '安装 AI'")
      expect(source, name).not.toContain("getElementById('tab-install')")
      expect(source, name).not.toContain('install-content')
      expect(source, name).not.toContain('install-workspace')
    }
  })
})

import { describe, expect, it } from 'vitest'
import { claudeDesktopOnlyNotice, readClaudeEditions, selectionActionLabel } from '../../app/renderer/src/platform/model-api'
import { claudeDesktopOnlyInstallText, officialInstallPlatforms } from '../../app/renderer/src/platform/install-card'
import { buildDiagnosticsText } from '../../app/main/diagnostics/report'

describe('只装了 Claude 桌面版时如实说（CD-02）', () => {
  it('模型 API 页：只有桌面版才出说明，并指向命令行版；读不到或装了命令行版不说', () => {
    const notice = claudeDesktopOnlyNotice({ cli: false, desktop: true })
    expect(notice).toContain('Claude 桌面版只能登录 Claude 账号使用')
    expect(notice).toContain('不能用 DeepSeek、智谱、Kimi 的 Key')
    expect(notice).toContain('Claude Code 命令行版')
    expect(claudeDesktopOnlyNotice({ cli: true, desktop: true })).toBeUndefined()
    expect(claudeDesktopOnlyNotice({ cli: false, desktop: false })).toBeUndefined()
    expect(claudeDesktopOnlyNotice(null)).toBeUndefined()
  })

  it('当前 Key 那一行在没有命令行版时不说「已配置」', () => {
    expect(selectionActionLabel(true, true)).toBe('未生效')
    expect(selectionActionLabel(true, false)).toBe('已配置')
    expect(selectionActionLabel(false, true)).toBe('启用')
  })

  it('主进程快照不合形时当作读不到，⛔ 猜成只有桌面版', () => {
    expect(readClaudeEditions('{"cli":false,"desktop":true}')).toEqual({ cli: false, desktop: true })
    for (const broken of ['', 'null', '{"cli":"no","desktop":true}', '{"desktop":true}']) expect(readClaudeEditions(broken)).toBeNull()
  })

  it('下载/版本信息页：检测到未装命令行版且装着桌面版时才提示', () => {
    const base = { id: 'claude-code' as const, version: '', latest: '', updatable: false, method: 'script' as const, location: '' }
    expect(claudeDesktopOnlyInstallText('claude-code', { ...base, installed: false, claudeDesktop: true })).toContain('请点「官方下载」安装 Claude Code 命令行版')
    expect(claudeDesktopOnlyInstallText('claude-code', { ...base, installed: true, claudeDesktop: true })).toBe('')
    expect(claudeDesktopOnlyInstallText('claude-code', { ...base, installed: false, claudeDesktop: false })).toBe('')
    expect(claudeDesktopOnlyInstallText('claude-code', undefined)).toBe('')
    expect(claudeDesktopOnlyInstallText('codex', { ...base, id: 'codex', installed: false, claudeDesktop: true })).toBe('')
  })

  it('仪表盘上的 Claude Code 说明写明是命令行版、不是桌面版', () => {
    const claude = officialInstallPlatforms.find(item => item.id === 'claude-code')!
    expect(claude.description).toContain('命令行版')
    expect(claude.description).toContain('不是 Claude 桌面版')
    expect(claude.description).not.toContain('只有英文')
  })

  it('客服诊断信息里能看出客户装的是桌面版', () => {
    const text = buildDiagnosticsText({ collectedAt: 'now', errors: [], shells: [
      { id: 'claude-code', label: 'Claude Code', installed: false, version: '', latest: '2.1.273', claudeDesktop: true },
      { id: 'codex', label: 'Codex', installed: false, version: '', latest: '0.154.0' }
    ] })
    expect(text).toContain('Claude Code：未装 · 最新 2.1.273 · 另装有 Claude 桌面版（不能用模型 API Key）')
    expect(text).toContain('Codex：未装 · 最新 0.154.0\n')
  })
})

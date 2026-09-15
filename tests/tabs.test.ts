import { describe, expect, it } from 'vitest'
import { defaultPinnedPlatformIds, isTabId, legacyPinnedPlatformStorageKey, morePlatformEntries, morePlatformTrigger, movePinnedPlatform, nextTabIndex, normalizePinnedPlatformIds, pinnedPlatformStorageKey, pinPlatform, readPinnedPlatformIds, skeletonTabs, unpinPlatform } from '../app/renderer/src/tabs'

describe('工具箱导航', () => {
  it('主导航按使用顺序排列，退役安装页不再是可导航页面', () => {
    const sidebar = skeletonTabs.filter((tab) => tab.sidebar !== false)
    expect(sidebar.map((tab) => tab.id)).toEqual(['dashboard', 'purchase', 'sharing', 'tunnel', 'referral', 'account', 'settings'])
    expect(sidebar.map((tab) => tab.label)).toEqual([
      '仪表盘',
      '账号订阅',
      '账号分享',
      'AI网络配置',
      '邀请有礼',
      '我的账号',
      '设置'
    ])
    expect(sidebar.slice(0, 4).every((tab) => tab.group === 'services')).toBe(true)
    expect(sidebar.slice(4).every((tab) => tab.group === 'account')).toBe(true)
    expect(isTabId('install')).toBe(false)
    expect(skeletonTabs.map((tab) => tab.id)).not.toContain('install')
    expect(isTabId('platform-layout')).toBe(true)
    expect(defaultPinnedPlatformIds).toEqual(['codex', 'claude-code', 'hermes'])
  })

  it('只接受已注册入口，并可在纵向导航中循环移动', () => {
    expect(isTabId('dashboard')).toBe(true)
    expect(isTabId('usage')).toBe(true)
    expect(isTabId('ai-accounts')).toBe(false)
    expect(isTabId('other')).toBe(false)
    expect(nextTabIndex(0, -1)).toBe(skeletonTabs.length - 1)
    expect(nextTabIndex(skeletonTabs.length - 1, 1)).toBe(0)
  })

  it('六个平台都能在左栏和更多平台之间切换', () => {
    expect(morePlatformEntries).toEqual([
      { id: 'codex', label: 'Codex' },
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'hermes', label: 'Hermes' },
      { id: 'deepseek-harness', label: 'DeepSeek Harness' },
      { id: 'zcode', label: '智谱 ZCode' },
      { id: 'kimi-code', label: 'Kimi Code' }
    ])
    expect(morePlatformTrigger).toEqual({ afterTab: 'usage', label: '更多平台' })
    expect(skeletonTabs.some((tab) => tab.label === '更多平台')).toBe(false)
  })

  it('固定记录去重、排序和收回都保留用户的布局选择', () => {
    expect(normalizePinnedPlatformIds(['codex', 'unknown', 'hermes', 'hermes', 'kimi-code'])).toEqual(['codex', 'hermes', 'kimi-code'])
    expect(pinPlatform(['claude-code'], 'hermes')).toEqual(['claude-code', 'hermes'])
    expect(pinPlatform(['hermes'], 'hermes')).toEqual(['hermes'])
    expect(unpinPlatform(['claude-code', 'hermes'], 'claude-code')).toEqual(['hermes'])
    expect(movePinnedPlatform(['codex', 'claude-code', 'hermes'], 'hermes', 'codex')).toEqual(['hermes', 'codex', 'claude-code'])
    expect(movePinnedPlatform(['codex', 'claude-code', 'hermes'], 'codex', 'claude-code', true)).toEqual(['claude-code', 'codex', 'hermes'])
    expect(nextTabIndex(8, 1, 14)).toBe(9)
    expect(nextTabIndex(13, 1, 14)).toBe(0)
  })

  it('首次打开迁移旧的固定记录，之后只读取新的布局记录', () => {
    expect(readPinnedPlatformIds({ getItem: (key) => key === legacyPinnedPlatformStorageKey ? JSON.stringify(['hermes', 'kimi-code']) : null })).toEqual(['codex', 'hermes', 'kimi-code'])
    expect(readPinnedPlatformIds({ getItem: (key) => key === pinnedPlatformStorageKey ? JSON.stringify(['kimi-code', 'codex']) : JSON.stringify(['hermes']) })).toEqual(['kimi-code', 'codex'])
  })
})

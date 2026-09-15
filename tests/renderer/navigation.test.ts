import { describe, expect, it } from 'vitest'
import { requestedTab, requestedModelApiPlatform, requestedModelApiProvider, requestedPlatformDownloadPlatform, requestModelApiNavigation, requestPlatformDownloadNavigation } from '../../app/renderer/src/navigation'

describe('页面内跳转请求', () => {
  it('安装与仪表盘的接入入口带上所选 Agent，直达其模型 API', () => {
    for (const usagePlatform of ['codex', 'claude-code', 'hermes'] as const) {
      let dispatched: Event | undefined
      const target = { dispatchEvent: (event: Event) => { dispatched = event; return true } } as Document
      requestModelApiNavigation(usagePlatform, target)
      expect(requestedTab(dispatched!)).toBe('usage')
      expect(requestedModelApiPlatform(dispatched!)).toBe(usagePlatform)
    }
  })
  it('不将旧页面、未知平台或不完整请求当作模型接入入口', () => {
    expect(requestedTab({ detail: { tab: 'ai-accounts' } } as unknown as Event)).toBeUndefined()
    for (const detail of [{ tab: 'usage', usagePlatform: 'other', platformSection: 'model-api' }, { tab: 'usage', usagePlatform: 'hermes' }, { tab: 'install', usagePlatform: 'codex', platformSection: 'model-api' }]) {
      expect(requestedModelApiPlatform({ detail } as unknown as Event)).toBeUndefined()
    }
  })
  // 「去填写 / 检查 Key」要落到一个真有该服务商 Key 编辑器的壳页，并定位到那一行：
  // 光带壳名不够，还得带上是哪家服务商。
  it('带服务商的模型接入请求，把服务商一起送到落点页', () => {
    let dispatched: Event | undefined
    const target = { dispatchEvent: (event: Event) => { dispatched = event; return true } } as Document
    requestModelApiNavigation('codex', target, 'zhipu')
    expect(requestedModelApiPlatform(dispatched!)).toBe('codex')
    expect(requestedModelApiProvider(dispatched!)).toBe('zhipu')
    // 不带服务商时照旧，⛔ 让已有入口（安装页、仪表盘）被迫指定一家。
    requestModelApiNavigation('hermes', target)
    expect(requestedModelApiProvider(dispatched!)).toBeUndefined()
    // 不是模型接入请求、或服务商名不认识的，一律不认。
    for (const detail of [{ tab: 'usage', usagePlatform: 'codex', platformSection: 'model-api', modelApiProvider: 'other' },
      { tab: 'usage', usagePlatform: 'codex', modelApiProvider: 'zhipu' }]) {
      expect(requestedModelApiProvider({ detail } as unknown as Event)).toBeUndefined()
    }
  })

  it('只接收已注册的导航目标，并把旧安装页请求迁到 Codex 页面', () => {
    const legacy = { detail: { tab: 'install' } } as unknown as Event
    expect(requestedTab(legacy)).toBe('usage')
    expect(requestedPlatformDownloadPlatform(legacy)).toBe('codex')
    expect(requestedTab({ detail: { tab: 'third-party-import' } } as unknown as Event)).toBeUndefined()
    expect(requestedTab({ detail: {} } as unknown as Event)).toBeUndefined()
  })

  it('官方下载入口带上平台并直达下载版本页', () => {
    let dispatched: Event | undefined
    const target = { dispatchEvent: (event: Event) => { dispatched = event; return true } } as Document
    requestPlatformDownloadNavigation('claude-code', target)
    expect(requestedTab(dispatched!)).toBe('usage')
    expect(requestedPlatformDownloadPlatform(dispatched!)).toBe('claude-code')
    expect(requestedModelApiPlatform(dispatched!)).toBeUndefined()
  })
})

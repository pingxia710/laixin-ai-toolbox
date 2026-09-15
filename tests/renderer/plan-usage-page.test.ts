import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planResetText, planUsageEmptyState, quotaText, tokenText } from '../../app/renderer/src/codex-usage/view'
import { LOCAL_USAGE_DAYS, localUsageNotice, planUsageMessages, planUsagePlatformIds, planUsageProviders, isPlanUsagePlatformId, type PlanUsageStatus } from '../../app/shared/plan-usage-types'
import { providerKeyShellPlatform } from '../../app/renderer/src/platform/model'
import type { AiAccessStatus } from '../../app/main/ai-access/service'
import { modelProviderIds } from '../../app/shared/model-providers'
import { morePlatformEntries } from '../../app/renderer/src/tabs'

const page = readFileSync(new URL('../../app/renderer/src/pages/codex-usage.ts', import.meta.url), 'utf8')

describe('国内三壳与套餐用量的显示', () => {
  it('六个平台里，除 Codex 外都走套餐用量这条路，⛔ 有平台掉出去', () => {
    const others = morePlatformEntries.map((entry) => entry.id).filter((id) => id !== 'codex')
    expect(others.every(isPlanUsagePlatformId)).toBe(true)
    expect([...planUsagePlatformIds].sort()).toEqual([...others].sort())
  })

  it('三种结局各说各的话，页面里 ⛔ 再出现「暂未接入」这类占位', () => {
    expect(planUsageMessages.plan).not.toBe(planUsageMessages.local)
    expect(planUsageMessages.local).not.toBe(planUsageMessages.none)
    expect(planUsageMessages.none).toContain('不提供用量查询')
    expect(planUsageMessages.local).toContain('估算')
    for (const message of Object.values(planUsageMessages)) expect(message).not.toContain('暂未接入')
    // 只认上屏的字符串字面量，注释里提这四个字是在说明为什么不许它上屏。
    const literals = page.match(/'[^'\n]*'/g) ?? []
    expect(literals.filter((literal) => literal.includes('暂未接入') || literal.includes('暂未提供用量数据'))).toEqual([])
  })

  it('每个状态都有自己的空态标题与说法，读不到的原因分得开', () => {
    const statuses = Object.keys(planUsageMessages) as PlanUsageStatus[]
    const titles = statuses.map((status) => planUsageEmptyState(status, '智谱 ZCode').title)
    expect(new Set(titles).size).toBe(titles.length)
    expect(planUsageEmptyState('none', '智谱 ZCode').title).toBe('智谱 ZCode不提供用量查询')
    expect(planUsageEmptyState('key-missing', 'Kimi Code').description).toContain('模型接入')
    expect(planUsageEmptyState('no-records', 'Kimi Code').description).toContain(String(LOCAL_USAGE_DAYS))
    expect(planUsageEmptyState('network-error', 'Kimi Code').description).toContain('不代表额度用完了')
  })

  // 官方额度这次没读到、却有本机记录时，屏幕上原来一律写「官方没有提供用量接口」：
  // Key 填错或断网的客户以为永远看不到官方额度，不会回去修 Key。
  it('只读到本机记录时按官方那一头的结局分说，只有真没接口才说「官方不提供」', () => {
    expect(localUsageNotice('none', '智谱 ZCode').notice).toBe(planUsageMessages.local)
    expect(localUsageNotice(undefined, '智谱 ZCode').notice).toBe(planUsageMessages.local)
    expect(localUsageNotice('none', '智谱 ZCode').action).toBeNull()
    for (const status of ['key-rejected', 'network-error', 'invalid-reply'] as const) {
      const hint = localUsageNotice(status, '智谱 ZCode')
      expect(hint.notice).toContain('本次未读到官方额度')
      expect(hint.notice).not.toContain('官方没有提供用量接口')
      expect(hint.credits).not.toContain('官方没有用量查询接口')
      // Key 被拒要客户去改 Key，连不上与格式不对是重试。
      expect(hint.action).toBe(status === 'key-rejected' ? 'key' : 'retry')
    }
    const missing = localUsageNotice('key-missing', 'Kimi Code')
    expect(missing.notice).toContain('还没在工具箱填')
    expect(missing.notice).not.toContain('官方没有提供用量接口')
    expect(missing.action).toBe('key')
    // 三种说法互不相同，⛔ 又被同一句话盖回去。
    expect(new Set(['none', 'key-missing', 'key-rejected', 'network-error'].map((status) => localUsageNotice(status as never, 'Kimi Code').notice)).size).toBe(4)
  })

  it('页面真的接上了这三种说法与对应动作，⛔ 再硬写一句「官方没有用量查询接口」', () => {
    expect(page).toContain('localUsageNotice(')
    expect(page).toContain('requestModelApiNavigation(')
    expect(page).not.toContain('官方没有用量查询接口')
    // 本机统计残缺时要在屏幕上说出来，⛔ 把不完整的数字当完整估算给客户。
    expect(page).toContain('部分记录未计入')
  })

  // 「去填写 / 检查 Key」原来跳到 zcode / kimi-code 自己的「模型 API」页——那一页写着
  // 「工具箱不接管它的 API 配置」、一个 Key 输入口都没有，等于先叫客户去改、再把门关上。
  // 填这两家 Key 的地方在 Codex / Claude Code / Hermes 的「模型 API」页里对应服务商那一行。
  it('套餐平台对应哪家服务商的 Key，主进程与界面认的是同一张表', () => {
    expect(planUsageProviders.zcode).toBe('zhipu')
    expect(planUsageProviders['kimi-code']).toBe('kimi')
    // 非接入壳平台以外的，没有可填的 Key。
    expect(planUsageProviders['deepseek-harness']).toBeUndefined()
    expect(planUsageProviders.hermes).toBeUndefined()
  })

  it('落点是真能填这家 Key 的壳页：只选已验收的壳，优先那里已存的 Key', () => {
    const status = (keys: Partial<Record<'codex' | 'claude' | 'hermes', readonly string[]>>): AiAccessStatus => ({
      legacyZaiKeySaved: false,
      shells: Object.fromEntries((['codex', 'claude', 'hermes'] as const).map((shell) => [shell, {
        selected: 'official', officialAvailable: true,
        providerKeys: Object.fromEntries(modelProviderIds
          .map((provider) => [provider, (keys[shell] ?? []).includes(provider)]))
      }]))
    } as AiAccessStatus)
    // 只有 Claude Code 存了智谱 Key → 落到 Claude Code，⛔ 一律甩给 Codex。
    expect(providerKeyShellPlatform('zhipu', status({ claude: ['zhipu'] }))).toBe('claude-code')
    expect(providerKeyShellPlatform('kimi', status({ hermes: ['kimi'] }))).toBe('hermes')
    // 智谱套餐三个壳都已验收；多个已存 Key 与无 Key 的默认落点都按 Codex → Claude → Hermes 的稳定顺序。
    expect(providerKeyShellPlatform('zhipu', status({ codex: ['zhipu'], hermes: ['zhipu'] }))).toBe('codex')
    expect(providerKeyShellPlatform('zhipu', status({ claude: ['kimi'] }))).toBe('codex')
    expect(providerKeyShellPlatform('zhipu', status({}))).toBe('codex')
    expect(providerKeyShellPlatform('zhipu', null)).toBe('codex')
    // 已验收的 Kimi Code 同样按稳定顺序落到 Codex。
    expect(providerKeyShellPlatform('kimi', status({}))).toBe('codex')
  })

  it('页面按服务商跳到壳页，⛔ 再跳回这两个平台自己那页没有 Key 编辑器的「模型 API」', () => {
    // 落点由 providerKeyShellPlatform 算出来，⛔ 直接把 platform 塞进导航。
    expect(page).toContain('providerKeyShellPlatform(')
    expect(page).not.toMatch(/requestModelApiNavigation\(\s*platform\s*[,)]/)
    expect(page).toContain('planUsageProviders')
  })

  it('读不到时给一个「打开官方页面」的去处，地址由主进程按平台解析', () => {
    expect(page).toContain('打开官方页面')
    expect(page).toContain('openOfficialPage({ platform })')
    // 渲染层只递平台名，⛔ 把任意网址交给主进程去打开。
    expect(page).not.toMatch(/openOfficialPage\(\s*\{\s*url/)
  })

  it('额度与 Token 的写法照顾看不懂大数字的人', () => {
    expect(tokenText(900)).toBe('900')
    expect(tokenText(35_500)).toBe('3.6 万')
    expect(tokenText(771_679_956)).toBe('7.7 亿')
    expect(quotaText(30, 100)).toBe('已用 30 / 100')
    expect(quotaText(30, null)).toBe('已用 30')
    expect(quotaText(null, null)).toBeNull()
  })

  it('重置时间按毫秒进来，没给就说没给', () => {
    const now = Date.parse('2026-09-12T08:00:00Z')
    expect(planResetText(null, now)).toBe('重置时间暂未提供')
    expect(planResetText(now + 90 * 60_000, now)).toContain('1 小时 30 分钟后重置')
  })
})

import { describe, expect, it } from 'vitest'
import { usageEmptyState } from '../../app/renderer/src/codex-usage/view'

describe('AI 用量状态不错误归因', () => {
  it.each(['unavailable', 'timeout'] as const)('%s 不要求重新登录或暗示额度为零', (status) => {
    const view = usageEmptyState(status)
    expect(view.title).not.toMatch(/登录|用完/)
    expect(view.description).not.toMatch(/请.*登录|剩余 0/)
  })
  it('仅明确未登录时引导登录，缺少数据仍保持未知', () => {
    expect(usageEmptyState('signed-out').title).toContain('登录')
    expect(usageEmptyState('not-installed').title).toContain('安装')
    expect(usageEmptyState('ready').title).toContain('暂未提供')
    expect(usageEmptyState('account-changed').description).toContain('收起上个账号')
  })
})

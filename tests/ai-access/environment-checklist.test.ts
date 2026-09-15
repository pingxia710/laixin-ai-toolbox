import { describe, expect, it } from 'vitest'
import {
  environmentChecklist,
  environmentChecklistCapabilities,
  environmentChecklistDetectionModes,
  environmentChecklistHandlingModes,
  environmentChecklistItem
} from '../../app/main/ai-access/environment-checklist'

describe('复杂客户环境 27 条清单', () => {
  it('恰好覆盖连续且唯一的 1–27 条，每一条都有可机读的检测、处理和安全边界', () => {
    expect(environmentChecklist).toHaveLength(27)
    expect(environmentChecklist.map(item => item.id)).toEqual(Array.from({ length: 27 }, (_, index) => index + 1))
    expect(new Set(environmentChecklist.map(item => item.id)).size).toBe(27)

    for (const item of environmentChecklist) {
      expect(item.title.trim()).not.toBe('')
      expect(environmentChecklistDetectionModes).toContain(item.detection.mode)
      expect(item.detection.strategy.trim()).not.toBe('')
      expect(environmentChecklistHandlingModes).toContain(item.handling.mode)
      expect(item.handling.strategy.trim()).not.toBe('')
      expect(item.safetyBoundaryReason.trim()).not.toBe('')
      for (const capability of [...item.detection.capabilities, ...item.handling.capabilities]) {
        expect(environmentChecklistCapabilities).toContain(capability)
      }
    }
  })

  it('把现有产品能力映射到对应复杂环境，而不是把清单写成空泛建议', () => {
    expect(environmentChecklistItem(1)?.detection.capabilities).toEqual(expect.arrayContaining([
      'trusted-native-runtime-inventory', 'native-route-runner'
    ]))
    const shellExports = environmentChecklistItem(8)!
    expect(shellExports.handling.capabilities).toContain('hidden-state-cleanup-and-restore')
    expect(shellExports.handling.strategy).toContain('只注释精确命中的 shell export')
    expect(shellExports.handling.strategy).toContain('备份')
    expect(shellExports.handling.strategy).toContain('不覆盖之后的手工修改')
    expect(environmentChecklistItem(13)?.detection.capabilities).toContain('configuration-root-resolution')
    expect(environmentChecklistItem(21)?.handling.capabilities).toContain('gateway-request-rewrite')
    expect(environmentChecklistItem(24)?.detection.capabilities).toContain('restart-guidance')
    expect(environmentChecklistItem(20)?.handling).toEqual(expect.objectContaining({ mode: 'user-action', capabilities: [] }))
  })

  it('第 2 条与第 21 条对 gateway-request-rewrite 的说法必须一致：实际行为是保留（第 3 轮返修）', () => {
    // gateway.test.ts 锁定了实际行为：context_management、cache_control、anthropic-beta 原样透传。
    // 第 2 条说「自动移除」、第 21 条说「保留」，两条自相矛盾——文案向实际行为对齐。
    const legacyClient = environmentChecklistItem(2)!
    expect(legacyClient.handling.capabilities).toContain('gateway-request-rewrite')
    expect(legacyClient.handling.strategy).toContain('保留')
    expect(legacyClient.handling.strategy).not.toContain('移除')
    const beta = environmentChecklistItem(21)!
    expect(beta.handling.strategy).toContain('保留')
  })

  it('把高风险环境明确为客户或管理员操作，不伪装成工具箱已处理', () => {
    const proxy = environmentChecklistItem(5)!
    expect(proxy.handling.mode).toBe('user-action')
    expect(proxy.handling.strategy).toContain('NO_PROXY')
    expect(proxy.safetyBoundaryReason).toContain('PAC')

    const managed = environmentChecklistItem(6)!
    expect(managed.handling.mode).toBe('do-not-do')
    expect(managed.detection.capabilities).toContain('managed-policy-protection')

    for (const id of [3, 4]) {
      const item = environmentChecklistItem(id)!
      expect(item.detection.mode).toBe('unsupported')
      expect(item.handling.mode).toBe('do-not-do')
      expect(item.handling.strategy).toContain('不')
    }

    const enterpriseCa = environmentChecklistItem(27)!
    expect(enterpriseCa.handling.mode).toBe('do-not-do')
    expect(enterpriseCa.handling.strategy).toContain('NODE_EXTRA_CA_CERTS')
    expect(enterpriseCa.safetyBoundaryReason).toContain('证书管理员')
  })

  it('清单第 20 条说实话：清理只写 hasCompletedOnboarding 一个键，先备份可撤销，不动 rejected 记录（第 3 轮返修）', () => {
    const rejected = environmentChecklistItem(20)!
    expect(rejected.detection.mode).toBe('automatic')
    expect(rejected.handling).toEqual(expect.objectContaining({ mode: 'user-action', capabilities: [] }))
    // 实际行为（hidden-state-cleanup.ts 的 markClaudeOnboarded）确实写 .claude.json——文案不能再说「不会改写」。
    expect(rejected.handling.strategy).toContain('hasCompletedOnboarding')
    expect(rejected.handling.strategy).toContain('备份')
    expect(rejected.handling.strategy).toContain('撤销')
    expect(rejected.handling.strategy).toContain('rejected')
    expect(rejected.handling.strategy).not.toContain('不会改写')
  })

  it('查找不存在的编号不会编造一条已经检测或修复的记录', () => {
    expect(environmentChecklistItem(0)).toBeUndefined()
    expect(environmentChecklistItem(28)).toBeUndefined()
  })
})

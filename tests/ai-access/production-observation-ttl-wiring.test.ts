import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configurationObservationTtlMs } from '../../app/main/ai-access/configuration-execution-observer'

/**
 * API-11 验收遗留（窄收尾）：上一轮验收变异「TTL 接线归零」不红——用例自建观察器显式传
 * TTL,生产接线层（actions/ai-access.ts 组合根）零守卫。本格钉住组合根真的把时间窗接进
 * 生产观察器：①生产时间窗常量活着（>0,常量被归零必红）；②组合根构造观察器的那一行
 * 确实传 ttlMs: configurationObservationTtlMs（接线改 ttlMs:0、改字面量或整段删掉必红）。
 * 观察器行为本身（窗口内复用、失败不缓存）由 status-observation-ttl.test.ts 守住,这里只守接线。
 */

const actionsSource = await readFile(join(process.cwd(), 'app/main/actions/ai-access.ts'), 'utf8')

describe('API-11 生产接线：组合根给观察器接上时间窗', () => {
  it('生产时间窗常量为正（configurationObservationTtlMs > 0）', () => {
    expect(configurationObservationTtlMs).toBeGreaterThan(0)
  })

  it('组合根构造观察器时 ttlMs 接的是 configurationObservationTtlMs，⛔ 归零/换字面量/删接线', () => {
    const wiring = actionsSource.match(/createConfigurationExecutionObserver\(\{[^)]*ttlMs:\s*([A-Za-z0-9_.]+)/)
    expect(wiring, 'actions/ai-access.ts 里找不到观察器构造（createConfigurationExecutionObserver 调用不见了）').not.toBeNull()
    expect(wiring![1], '组合根 ttlMs 没接 configurationObservationTtlMs（接线被归零或改成了字面量）').toBe('configurationObservationTtlMs')
  })
})

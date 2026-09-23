import { describe, expect, it } from 'vitest'
import { configurationObservationTtlMs, createConfigurationExecutionObserver } from '../../app/main/ai-access/configuration-execution-observer'
import { createDeepSeekAdapters } from '../../app/main/ai-access/adapters'
import { AiAccessService, type AiAccessState } from '../../app/main/ai-access/service'
import type { ConfigurationExecutionObservation } from '../../app/main/ai-access/configuration-execution-observer'
import type { ManagedTextFile } from '../../app/main/ai-access/deepseek-config'

/**
 * API-11：登录等待页每 1.5 秒起一次 profiles＋ps 把电脑拖卡。
 * 这组用例守两件事：①观察器结果在 TTL 时间窗内复用，连续 status() 只 spawn 一轮；
 * ②窗口过期或观察失败后如实重查，配置目标最终一致。
 * 计数语义：观察器 spawn 计数 ≙ 主进程 status() 的 profiles/ps 子进程数；
 * 登录等待轮询期间的 observer 零 spawn 由渲染层用例 tests/renderer/model-api-login-poll.test.ts
 * 配合本文件共同守住（轮询改走轻量登录态端点后不再触发 status()）。
 */

function countingObserver(ttlMs: number | undefined, clock: { now: number }, managed: () => boolean = () => false) {
  const spawns: string[] = []
  const observer = createConfigurationExecutionObserver({
    platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
    ...(ttlMs === undefined ? {} : { ttlMs }),
    now: () => clock.now,
    run: async command => {
      if (command === '/usr/bin/profiles' || command === '/bin/ps') {
        spawns.push(command)
        if (command === '/usr/bin/profiles' && managed()) {
          return '<plist><dict><string>com.openai.codex</string></dict></plist>'
        }
        return ''
      }
      throw new Error('unexpected command')
    }
  })
  return { observer, spawns }
}

function serviceWith(observer: () => Promise<ConfigurationExecutionObservation>) {
  const data = new Map<string, string>()
  const file: ManagedTextFile = {
    read: async path => data.get(path),
    write: async (path, contents) => { data.set(path, contents) },
    remove: async path => { data.delete(path) },
    list: async () => [],
    withConfigWriteLock: async (_path, task) => task()
  }
  let state: AiAccessState = { version: 1, selected: {} }
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const adapters = createDeepSeekAdapters({ home: '/customer', platform: 'darwin', file, observeConfigurationExecution: observer })
  return new AiAccessService(store, adapters)
}

describe('观察器结果 TTL（API-11）', () => {
  it('TTL 时间窗内的重复观察复用结果：十次观察只 spawn 一轮 profiles＋ps，过期后如实重查', async () => {
    const clock = { now: 1_000 }
    const { observer, spawns } = countingObserver(configurationObservationTtlMs, clock)
    const first = await observer()
    for (let index = 0; index < 9; index++) await expect(observer()).resolves.toEqual(first)
    expect(spawns.filter(command => command === '/usr/bin/profiles')).toHaveLength(1)
    expect(spawns.filter(command => command === '/bin/ps')).toHaveLength(1)

    clock.now += configurationObservationTtlMs + 1
    await observer()
    expect(spawns.filter(command => command === '/usr/bin/profiles')).toHaveLength(2)
  })

  it('失败的观察不进时间窗：下一次调用重新观察，⛔ 把失败缓存成十秒的答案', async () => {
    const clock = { now: 0 }
    let failPolicyProbe = true
    let probes = 0
    const observer = createConfigurationExecutionObserver({
      platform: 'linux', home: '/customer',
      policyFilePresence: async () => {
        probes += 1
        if (failPolicyProbe) throw new Error('fixture policy probe failed')
        return 'absent'
      },
      ttlMs: 10_000,
      now: () => clock.now,
      run: async () => ''
    })
    await expect(observer()).rejects.toThrow('fixture policy probe failed')
    failPolicyProbe = false
    // 载重断言：失败的观察没有被缓存成答案——第二次调用真的重新观察并拿到新结果。
    await expect(observer()).resolves.toEqual({})
    expect(probes).toBeGreaterThanOrEqual(2)
  })

  it('连续 status() 十次只 spawn 一轮 profiles＋ps（TTL 允许值）；现行每轮全量 spawn', async () => {
    const clock = { now: 0 }
    const { observer, spawns } = countingObserver(configurationObservationTtlMs, clock)
    const service = serviceWith(observer)
    for (let index = 0; index < 10; index++) await service.status()
    expect(spawns.filter(command => command === '/usr/bin/profiles')).toHaveLength(1)
    expect(spawns.filter(command => command === '/bin/ps')).toHaveLength(1)
  })

  it('回归：配置目标最终一致——窗口内如实显示，策略在窗口外装上时下一个窗口如实变阻断', async () => {
    const clock = { now: 0 }
    let managed = false
    const { observer } = countingObserver(configurationObservationTtlMs, clock, () => managed)
    const service = serviceWith(observer)

    const before = await service.status()
    expect(before.configurationTargets?.codex).toMatchObject({ scope: 'user', writable: true })

    // 时间窗内的第二次读复用观察：显示可能滞后至多一个窗口，但绝不长于 TTL。
    managed = true
    const withinWindow = await service.status()
    expect(withinWindow.configurationTargets?.codex).toMatchObject({ writable: true })

    clock.now += configurationObservationTtlMs + 1
    const afterWindow = await service.status()
    expect(afterWindow.configurationTargets?.codex).toMatchObject({ override: 'managed', writable: false, reason: 'managed-configuration' })
  })
})

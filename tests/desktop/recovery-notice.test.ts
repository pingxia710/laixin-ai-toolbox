// N-27 恢复知情(桌面半):恢复事件 → 通知文案与去重键的纯函数决策。
// 真弹系统通知的胶水在 desktop/runtime,这里钉死的是「弹什么、弹不弹」——⛔ 真弹系统通知。
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopStore } from '../../app/main/desktop/preferences'
import { pendingRecoveryNotice, recoveryOutageWords } from '../../app/main/desktop/recovery-notice'

const recovery = { id: 1727_000_000_000, attempts: 3, outageMs: 14_000 }
const connected = { state: 'connected', recovery }
const liveConnected = { state: '已连' }
const roots: string[] = []

describe('N-27 恢复通知决策(纯函数)', () => {
  it('正文只说客户能理解的结果:网络已恢复+自动重连+中断时长;⛔ 内部码/出口 IP/节点地址', () => {
    const text = pendingRecoveryNotice(connected, () => false, liveConnected)
    expect(text).toBeDefined()
    expect(text?.title).toBe('来信 AI 工具箱')
    expect(text?.body).toContain('网络已恢复')
    expect(text?.body).toContain('自动重新连接')
    expect(text?.body).toContain('14 秒')
    expect(text?.body).not.toMatch(/TUNNEL|upstream|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+/)
  })

  it('时长按人话折算:秒/分秒/小时分', () => {
    expect(recoveryOutageWords(14_000)).toBe('14 秒')
    expect(recoveryOutageWords(122_000)).toBe('2 分 2 秒')
    expect(recoveryOutageWords(3_722_000)).toBe('1 小时 2 分')
  })

  it('去重键随片段 id 稳定:同 id 同键,不同片段不同键', () => {
    expect(pendingRecoveryNotice(connected, () => false, liveConnected)?.key).toBe(`recovery:${String(recovery.id)}`)
    expect(pendingRecoveryNotice({ state: 'connected', recovery: { ...recovery, id: recovery.id + 1 } }, () => false, liveConnected)?.key)
      .not.toBe(pendingRecoveryNotice(connected, () => false, liveConnected)?.key)
  })

  it('去重闸:已展示过的片段不再给文案;没有恢复事件就没有通知(此两格守卫被拆即红)', () => {
    expect(pendingRecoveryNotice(connected, (key) => key === `recovery:${String(recovery.id)}`, liveConnected)).toBeUndefined()
    expect(pendingRecoveryNotice(undefined, () => false, liveConnected)).toBeUndefined()
  })

  it('守护已断开或报错时，即使旧 state 残留恢复事件也不能再弹「网络已恢复」', () => {
    expect(pendingRecoveryNotice({ state: 'user-disconnected', recovery }, () => false, liveConnected)).toBeUndefined()
    expect(pendingRecoveryNotice({ state: 'error', recovery }, () => false, liveConnected)).toBeUndefined()
  })

  it('崩溃兜底撞锁留下旧 connected/recovery 时，网络服务已判守护死亡就不能弹恢复通知', () => {
    expect(pendingRecoveryNotice(connected, () => false, { state: '异常' })).toBeUndefined()
    expect(pendingRecoveryNotice(connected, () => false, undefined)).toBeUndefined()
  })

  it('展示标记落桌面偏好并跨实例可见:下一次打开最多提示一次', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'n27-recovery-'))
    roots.push(dir)
    const file = join(dir, 'desktop.json')
    const store = new DesktopStore(file)
    const key = pendingRecoveryNotice(connected, () => false, liveConnected)?.key ?? ''
    expect(store.notified(key)).toBe(false)
    store.rememberNotification(key)
    expect(store.notified(key)).toBe(true)
    // 新实例(重开应用)读同一份偏好:仍然已展示
    expect(new DesktopStore(file).notified(key)).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ notified: [key] })
  })

  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })
})

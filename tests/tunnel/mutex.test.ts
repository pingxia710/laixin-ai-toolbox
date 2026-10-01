// ActionMutex 的等待者路径:stop() 等锁的兜底(N-24)旧实现是 200ms 自旋试锁,最长空转 10 秒。
// 本用例钉住等待者语义:释放即按 FIFO 在微任务级唤醒(计时断言 < 一轮自旋间隔)、
// 不给外部 tryAcquire 插队窗口、AbortSignal 中止出队不殃及后续等待者。
// 未修代码上红(acquire 不存在);变异=去唤醒回退轮询 → 计时断言红/挂起超时。
import { describe, expect, it } from 'vitest'
import { ActionMutex } from '../../app/main/tunnel/mutex'

describe('ActionMutex 等待者队列', () => {
  it('持锁释放后等待者在自旋间隔内(微任务级)获得锁', async () => {
    const mutex = new ActionMutex()
    const release = mutex.tryAcquire()
    expect(release).toBeDefined()
    const start = Date.now()
    const acquired = mutex.acquire()
    release!()
    const got = await acquired
    expect(Date.now() - start).toBeLessThan(200) // 旧自旋一轮 200ms;变异回轮询即红
    expect(mutex.isLocked()).toBe(true)
    got()
    expect(mutex.isLocked()).toBe(false)
  })

  it('FIFO:多个等待者按到达顺序获得锁', async () => {
    const mutex = new ActionMutex()
    const order: number[] = []
    const release = mutex.tryAcquire()!
    const first = mutex.acquire().then((unlock) => { order.push(1); return unlock })
    const second = mutex.acquire().then((unlock) => { order.push(2); return unlock })
    release()
    const unlockFirst = await first
    expect(order).toEqual([1])
    unlockFirst()
    const unlockSecond = await second
    expect(order).toEqual([1, 2])
    unlockSecond()
    expect(mutex.isLocked()).toBe(false)
  })

  it('移交中的锁不给外部 tryAcquire 插队窗口', async () => {
    const mutex = new ActionMutex()
    const release = mutex.tryAcquire()!
    const waiter = mutex.acquire()
    release() // 锁直接移交队头等待者
    expect(mutex.tryAcquire()).toBeUndefined()
    ;(await waiter)()
    expect(mutex.tryAcquire()).toBeDefined()
  })

  it('AbortSignal 中止等待:出队并拒绝,不殃及后续等待者', async () => {
    const mutex = new ActionMutex()
    const release = mutex.tryAcquire()!
    const controller = new AbortController()
    const aborted = mutex.acquire(controller.signal)
    const later = mutex.acquire()
    controller.abort()
    await expect(aborted).rejects.toThrow('MUTEX_WAIT_ABORTED')
    release()
    const unlock = await later
    unlock()
    expect(mutex.isLocked()).toBe(false)
  })
})

// B8:防抖 saveAsync 与关窗同步 save 共用临时文件、各基于进函数时的旧 state。
// 实测最后落盘的是旧位置、maximized 键直接消失,过程无任何报错。
// 竞态窗口有两段,两段都要守:① 链头(还没开始写)② writeFile 已把内容序列化好、rename 还没落位。
import type * as FsPromises from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopStore } from '../../app/main/desktop/preferences'
import { makeTempDir, removeTempDir } from '../tunnel/helpers'

// 只在被 arm 的那一次把 writeFile 卡住,其余照跑真 fs。
const gate = vi.hoisted(() => ({
  armed: false,
  entered: undefined as undefined | (() => void),
  release: undefined as undefined | (() => void)
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const writeFile: typeof actual.writeFile = async (...args) => {
    if (gate.armed) {
      gate.armed = false
      gate.entered?.()
      await new Promise<void>((resolve) => { gate.release = resolve })
    }
    return actual.writeFile(...args)
  }
  return { ...actual, writeFile }
})

afterEach(() => { gate.armed = false; gate.entered = undefined; gate.release = undefined })

describe('窗口偏好落盘竞态', () => {
  it('防抖 saveAsync 在途时关窗同步 save：落盘是最新位置，⛔ 回退、⛔ 丢 maximized', async () => {
    const dir = makeTempDir('desktop-race-')
    try {
      const file = join(dir, 'desktop.json')
      const store = new DesktopStore(file)
      const older = { x: 10, y: 10, width: 800, height: 600 }
      const newer = { x: 500, y: 300, width: 1000, height: 700 }

      // 拖动/缩放走 300ms 防抖的 saveAsync;它还在 await 里,用户就关了窗 → 同步 save。
      const inflight = store.saveAsync({ bounds: older })
      store.save({ bounds: newer, maximized: true })
      await inflight

      const final = JSON.parse(readFileSync(file, 'utf8'))
      expect(final.bounds.x).toBe(500)
      expect(final.bounds.width).toBe(1000)
      expect(final.maximized).toBe(true)
      // 内存与盘必须一致,⛔ 下次开窗读到两份不同的状态。
      expect(store.window()).toEqual({ bounds: newer, maximized: true })
    } finally { removeTempDir(dir) }
  })

  it('连续多次 saveAsync 串行化，最后落盘的是最后一次的值', async () => {
    const dir = makeTempDir('desktop-serial-')
    try {
      const file = join(dir, 'desktop.json')
      const store = new DesktopStore(file)
      const writes = [100, 200, 300, 400].map((x) =>
        store.saveAsync({ bounds: { x, y: 0, width: 800, height: 600 } }))
      await Promise.all(writes)
      expect(JSON.parse(readFileSync(file, 'utf8')).bounds.x).toBe(400)
      expect(store.window().bounds?.x).toBe(400)
    } finally { removeTempDir(dir) }
  })

  it('异步写正卡在 writeFile 时关窗同步 save：落盘必须是最新位置且 maximized 在', async () => {
    const dir = makeTempDir('desktop-midwrite-')
    try {
      const file = join(dir, 'desktop.json')
      const store = new DesktopStore(file)
      const older = { x: 10, y: 10, width: 800, height: 600 }
      const newer = { x: 500, y: 300, width: 1000, height: 700 }

      const entered = new Promise<void>((resolve) => { gate.entered = resolve })
      gate.armed = true
      const inflight = store.saveAsync({ bounds: older })
      await entered // 异步写已进 writeFile:内容此刻已序列化成 older
      store.save({ bounds: newer, maximized: true }) // 关窗
      gate.release?.()
      await inflight

      // 放行后那次 rename 绝不能把已经落好的新位置盖回旧内容。
      const final = JSON.parse(readFileSync(file, 'utf8'))
      expect(final.bounds.x).toBe(500)
      expect(final.maximized).toBe(true)
      expect(store.window()).toEqual({ bounds: newer, maximized: true })
    } finally { removeTempDir(dir) }
  })

  it('把同步 save 撒在异步写各阶段连跑 200 轮：一次回退都不许有', async () => {
    const dir = makeTempDir('desktop-stress-')
    try {
      const file = join(dir, 'desktop.json')
      const store = new DesktopStore(file)
      let regressions = 0
      let missingMaximized = 0
      const rounds = 200
      for (let i = 0; i < rounds; i += 1) {
        const inflight = store.saveAsync({ bounds: { x: i, y: 0, width: 800, height: 600 }, maximized: false })
        // 让出 0~3 个 immediate,把同步 save 分别落在 mkdir / writeFile / rename 各阶段。
        for (let k = 0; k < (i % 4); k += 1) await new Promise((resolve) => setImmediate(resolve))
        store.save({ bounds: { x: 10_000 + i, y: 0, width: 800, height: 600 }, maximized: true })
        await inflight.catch(() => undefined)
        const final = JSON.parse(readFileSync(file, 'utf8'))
        if (final.bounds?.x !== 10_000 + i) regressions += 1
        if (final.maximized !== true) missingMaximized += 1
      }
      expect(regressions).toBe(0)
      expect(missingMaximized).toBe(0)
    } finally { removeTempDir(dir) }
  }, 60_000)

  it('同步 save 之后的异步写仍然生效，⛔ 被代次判据误杀', async () => {
    const dir = makeTempDir('desktop-after-')
    try {
      const file = join(dir, 'desktop.json')
      const store = new DesktopStore(file)
      store.save({ bounds: { x: 1, y: 1, width: 800, height: 600 } })
      await store.saveAsync({ maximized: true })
      const final = JSON.parse(readFileSync(file, 'utf8'))
      expect(final.maximized).toBe(true)
      expect(final.bounds.x).toBe(1)
    } finally { removeTempDir(dir) }
  })
})

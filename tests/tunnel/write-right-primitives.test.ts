// 写入权互斥体与端口认人的直接行为覆盖(审查点名:这两个新件原先只有接入处被间接覆盖)。
import { describe, expect, it } from 'vitest'
import { WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT, acquireWriteRight } from '../../sidecar/win/wininet-write-right.mjs'
import { isLaixinExePath, isLaixinInstallDir, isLaixinXrayPath, parsePortOwner } from '../../sidecar/win/port-owner.mjs'

function fakeApi(status: number, overrides: Record<string, unknown> = {}) {
  const calls = { released: 0, closed: 0 }
  return {
    calls,
    api: {
      createMutex: () => ({}),
      wait: () => status,
      release: () => { calls.released += 1; return true },
      close: () => { calls.closed += 1; return true },
      lastError: () => 0,
      ...overrides
    }
  }
}

describe('系统代理写入权互斥体', () => {
  it('拿到且前任是有序交出的:abandoned 为假', () => {
    const { api } = fakeApi(WAIT_OBJECT_0)
    const outcome = acquireWriteRight({ api })
    if (!outcome.acquired) throw new Error('应当取得写入权')
    expect(outcome.abandoned).toBe(false)
  })

  it('WAIT_ABANDONED:拿到了,但必须如实说前任是崩掉的——这是内核给的事实,⛔ 靠超时猜', () => {
    const { api } = fakeApi(WAIT_ABANDONED)
    const outcome = acquireWriteRight({ api })
    if (!outcome.acquired) throw new Error('应当取得写入权')
    expect(outcome.abandoned).toBe(true)
  })

  it('有人正持有:拿不到,理由是 held(调用方据此 ⛔ 碰系统代理)', () => {
    const { api, calls } = fakeApi(WAIT_TIMEOUT)
    const outcome = acquireWriteRight({ api })
    expect(outcome.acquired).toBe(false)
    expect(outcome).toMatchObject({ reason: 'held' })
    expect(calls.closed).toBe(1) // 拿不到也要关句柄,⛔ 泄漏
  })

  it('原语不可用(koffi 缺失/等待失败):理由是 unavailable,⛔ 当成「没人持有」放行', () => {
    expect(acquireWriteRight({ api: undefined }).acquired).toBe(false)
    expect(acquireWriteRight({ api: undefined })).toMatchObject({ reason: 'unavailable' })
    const { api } = fakeApi(WAIT_FAILED)
    expect(acquireWriteRight({ api })).toMatchObject({ acquired: false, reason: 'unavailable' })
    const throwing = fakeApi(WAIT_OBJECT_0, { createMutex: () => { throw new Error('no dll') } })
    expect(acquireWriteRight({ api: throwing.api })).toMatchObject({ acquired: false, reason: 'unavailable' })
  })

  it('release 幂等:交接路径显式调一次、进程退出钩子再调一次,⛔ 对内核多放一次', () => {
    const { api, calls } = fakeApi(WAIT_OBJECT_0)
    const outcome = acquireWriteRight({ api })
    if (!outcome.acquired) throw new Error('应当取得写入权')
    outcome.release()
    outcome.release()
    outcome.release()
    expect(calls.released).toBe(1)
    expect(calls.closed).toBe(1)
  })
})

describe('端口认人', () => {
  it('占用者是来信自己:认出来,调用方据此停手而不是换端口继续抢', () => {
    expect(parsePortOwner('4242|来信AI工具箱统一版|C:\\X\\来信AI工具箱统一版.exe'))
      .toMatchObject({ kind: 'laixin', pid: 4242 })
  })

  it('占用者是别家程序:归 other,⛔ 误称成旧版来信', () => {
    expect(parsePortOwner('99|Clash Verge|C:\\Y\\clash.exe')).toMatchObject({ kind: 'other', pid: 99 })
    // 名字里带「来信」但不是我们的可执行名:仍然按别家算(⛔ 模糊包含匹配)
    expect(parsePortOwner('100|来信AI工具箱助手|C:\\Z\\x.exe')).toMatchObject({ kind: 'other' })
  })

  // 真机上占入口端口的是**主程序**(2026-09-15 实测 PID 对应 来信AI工具箱统一版.exe);
  // 但中继内核换成独立 xray 进程监听时也得认得出,所以这条一并覆盖。
  it('来信自己的 xray 占着端口:也要认出来', () => {
    const exists = (path: string) => path === 'C:\\Apps\\Laixin\\resources\\sidecar\\win\\tunnel-daemon.mjs'
    expect(isLaixinXrayPath('C:\\Apps\\Laixin\\resources\\xray\\xray.exe', exists)).toBe(true)
    expect(parsePortOwner('777|xray|C:\\Apps\\Laixin\\resources\\xray\\xray.exe', exists))
      .toMatchObject({ kind: 'laixin', pid: 777 })
  })

  it('别家的 xray:⛔ 认成来信(判据是路径结构 + 同目录有主程序,不是进程名叫 xray)', () => {
    const exists = () => false
    // 路径结构不对
    expect(isLaixinXrayPath('C:\\Clash\\xray.exe', exists)).toBe(false)
    expect(parsePortOwner('778|xray|C:\\Clash\\xray.exe', exists)).toMatchObject({ kind: 'other' })
    // 路径结构对、但目录下没有来信的 sidecar(别家照抄目录名也不会被误判)
    expect(isLaixinXrayPath('C:\\Other\\resources\\xray\\xray.exe', exists)).toBe(false)
    expect(parsePortOwner('779|xray|C:\\Other\\resources\\xray\\xray.exe', exists)).toMatchObject({ kind: 'other' })
  })

  // 2026-09-15 Windows 真机实测的坑:PowerShell 按控制台代码页(GBK)写 stdout,我们按 utf8 读,
  // 于是进程名与路径里的中文全变成乱码,「匹配产品名」必然落空 —— 端口认人整个失效。
  // 主判据因此改成目录结构:那个目录下有没有我们自己的 sidecar 守护脚本。
  it('进程名是乱码时仍要认出来信(靠目录结构,⛔ 靠中文产品名)', () => {
    const exists = (p: string) => p === 'C:\\Apps\\LX\\resources\\sidecar\\win\\tunnel-daemon.mjs'
    expect(isLaixinInstallDir('C:\\Apps\\LX', exists)).toBe(true)
    expect(isLaixinExePath('C:\\Apps\\LX\\????AI??????.exe', exists)).toBe(true)
    // 名字乱码、路径也乱码,但目录结构还在 → 仍然认得出
    expect(parsePortOwner('3996|????AI??????|C:\\Apps\\LX\\????AI??????.exe', exists))
      .toMatchObject({ kind: 'laixin', pid: 3996 })
  })

  it('别家程序:目录下没有来信的 sidecar → ⛔ 认成来信', () => {
    const exists = () => false
    expect(isLaixinInstallDir('C:\\Clash', exists)).toBe(false)
    expect(isLaixinExePath('C:\\Clash\\clash.exe', exists)).toBe(false)
    expect(parsePortOwner('42|clash|C:\\Clash\\clash.exe', exists)).toMatchObject({ kind: 'other' })
  })

  it('查不出来:归 unknown,⛔ 猜成任何一方', () => {
    for (const raw of ['', '   ', 'garbage', '|no-pid|path', '0|x|y', undefined]) {
      expect(parsePortOwner(raw as string)).toMatchObject({ kind: 'unknown' })
    }
  })
})

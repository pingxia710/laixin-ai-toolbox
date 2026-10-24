// Windows「系统代理写入权」——当前用户会话级的命名互斥体(创始人 2026-09-15 定,三条硬线)。
//
// 它保护的不是「进程」,而是**WinINET 的写入与恢复权**:
//  · ⛔ 阻止两个守护同时存活——「旧守护慢恢复 + 新守护接手」是既有的合法交接(五轮复核建立),
//    把它锁死,客户重开工具箱就连不上,等于用一个故障换另一个故障。
//  · 只保证同一时刻**只有一个进程能写系统代理**。拿不到这个权的一方,一个注册表值都不许碰。
//
// 为什么用命名互斥体,而不是继续用锁文件 + processAlive(pid):
//  硬线三要求「崩溃时由 Windows 自动释放/可验证接管,不能凭超时猜它死了」。
//  pid 探活是猜:pid 会被系统复用,而且「判断它死了」与「接手」之间还有一道窗口。
//  命名互斥体由内核持有,持有者进程无论怎么死(崩溃、被杀、断电重启前的异常退出),
//  内核都会把它标记为 **abandoned**,下一个等待者拿到 WAIT_ABANDONED —— 这是事实,不是推断。
//  于是「前任是有序交出的」还是「前任崩在半路」可以被明确区分,后者要先查账本补还原。
//
// 名字用 Local\ 前缀 = 当前登录会话内唯一;跨安装目录、跨数据目录自动生效(这正是这次要堵的路径:
// 两份来信装在不同目录、用不同数据目录,原来的 dataDir 级锁互相看不见)。
import { createRequire } from 'node:module'

/** 会话级唯一名。⛔ 改动:改了就等于换了一把锁,新旧版本之间会重新变成互不可见。 */
export const WRITE_RIGHT_MUTEX = 'Local\\cn.laixin.toolbox.wininet-write'

// WaitForSingleObject 返回值(learn.microsoft.com/windows/win32/api/synchapi)。
export const WAIT_OBJECT_0 = 0x00000000
export const WAIT_ABANDONED = 0x00000080
export const WAIT_TIMEOUT = 0x00000102
export const WAIT_FAILED = 0xFFFFFFFF

/**
 * 加载 kernel32 的互斥体原语。随包 koffi 不在或加载失败 → 返回 undefined,
 * 调用方按「拿不到原生锁」处理(降级见 acquireWriteRight)。⛔ 在这里抛。
 */
export function loadMutexApi(requireImpl = createRequire(import.meta.url)) {
  try {
    const koffi = requireImpl('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    return {
      createMutex: kernel32.func('void* __stdcall CreateMutexW(void *attr, bool owner, str16 name)'),
      wait: kernel32.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 ms)'),
      release: kernel32.func('bool __stdcall ReleaseMutex(void *handle)'),
      close: kernel32.func('bool __stdcall CloseHandle(void *handle)'),
      lastError: kernel32.func('uint32 __stdcall GetLastError()')
    }
  } catch { return undefined }
}

/**
 * 取系统代理写入权。
 *
 * 返回 { acquired:true, abandoned, release() }:
 *   abandoned=true 表示**前任是崩掉的**(没走还原就没了),调用方必须先按账本补还原再接管。
 *   abandoned=false 表示前任有序交出,或本来就没人持有。
 * 返回 { acquired:false, reason:'held' }:有人正持有且在 timeoutMs 内没交出 —— 此时 ⛔ 碰系统代理。
 * 返回 { acquired:false, reason:'unavailable' }:拿不到原生原语(koffi 缺失/非 Windows)。
 *   ⚠️ 这不代表可以随便写:调用方按「未知冲突」处理,由上层决定是退到提示还是沿用旧路径。
 *
 * timeoutMs 只用来决定「等多久算对方不打算交」,⛔ 用来判断对方死没死——死活由 WAIT_ABANDONED 说了算。
 */
export function acquireWriteRight({ timeoutMs = 0, api = loadMutexApi(), name = WRITE_RIGHT_MUTEX } = {}) {
  if (api === undefined) return { acquired: false, reason: 'unavailable' }
  let handle
  try { handle = api.createMutex(null, false, name) } catch { return { acquired: false, reason: 'unavailable' } }
  if (!handle) return { acquired: false, reason: 'unavailable' }
  let status
  try { status = api.wait(handle, Math.max(0, Math.trunc(timeoutMs))) } catch {
    try { api.close(handle) } catch { /* 关不掉就交给进程退出 */ }
    return { acquired: false, reason: 'unavailable' }
  }
  if (status === WAIT_OBJECT_0 || status === WAIT_ABANDONED) {
    let released = false
    // release 必须幂等:交接路径上可能被显式调用一次,进程退出钩子里再调一次。
    const release = () => {
      if (released) return
      released = true
      try { api.release(handle) } catch { /* 已被内核回收 */ }
      try { api.close(handle) } catch { /* 同上 */ }
    }
    return { acquired: true, abandoned: status === WAIT_ABANDONED, release }
  }
  try { api.close(handle) } catch { /* 忽略 */ }
  if (status === WAIT_TIMEOUT) return { acquired: false, reason: 'held' }
  return { acquired: false, reason: 'unavailable' }
}

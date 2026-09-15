/** Windows「系统代理写入权」：当前用户会话级的命名互斥体。保护 WinINET 的写入与恢复权，
 *  ⛔ 阻止两个守护为了正常交接而同时存活。前任崩溃由内核标记 abandoned，⛔ 靠超时猜死活。 */
export declare const WRITE_RIGHT_MUTEX: string
export declare const WAIT_OBJECT_0: number
export declare const WAIT_ABANDONED: number
export declare const WAIT_TIMEOUT: number
export declare const WAIT_FAILED: number

export interface MutexApi {
  createMutex: (attr: unknown, owner: boolean, name: string) => unknown
  wait: (handle: unknown, ms: number) => number
  release: (handle: unknown) => boolean
  close: (handle: unknown) => boolean
  lastError: () => number
}

export declare function loadMutexApi(requireImpl?: (id: string) => unknown): MutexApi | undefined

/** acquired 时 abandoned=true 表示前任是崩掉的：调用方必须先按账本补还原，恢复成功才允许继续。 */
export declare function acquireWriteRight(options?: { timeoutMs?: number; api?: MutexApi | undefined; name?: string }):
  | { acquired: true; abandoned: boolean; release: () => void }
  | { acquired: false; reason: 'held' | 'unavailable' }

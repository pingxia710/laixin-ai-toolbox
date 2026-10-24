export interface MacWriteRightOwner {
  readonly version: 1
  readonly pid: number
  readonly startIdentity: string
  readonly token: string
  readonly dataDir?: string
}

export interface MacWriteRightOptions {
  readonly timeoutMs?: number
  readonly lockPath?: string
  readonly dataDir?: string
  readonly processIdentity?: (pid: number) => string | undefined
  readonly processAlive?: (pid: number) => boolean | undefined
  readonly sleep?: (ms: number) => void
  /** 测试故障注入：transition 已提交 owner 后丢弃子进程响应。 */
  readonly testDropTransitionResultAfterCommit?: boolean
  /** 测试故障注入：owner 已 link、目录 fsync 前终止 helper。 */
  readonly testDropTransitionBeforeDirectorySync?: boolean
  /** 测试故障注入：owner 目录 fsync 失败。 */
  readonly testFailOwnerDirectorySync?: boolean
  /** 测试故障注入：目录 fsync 失败后的 owner 清理也失败。 */
  readonly testFailOwnerCleanup?: boolean
  /** 测试故障注入：release 的前 N 次目录 fsync 失败。 */
  readonly testFailReleaseDirectorySyncAttempts?: number
  /** 测试故障注入：commit receipt 只追加半截后终止 helper。 */
  readonly testDropTransitionDuringCommit?: boolean
  /** 测试故障注入：全局互斥内完成 stale owner → 新 owner 原子切换后、返回调用方前执行。 */
  readonly afterStaleRemoved?: () => void
  /** 测试故障注入：恢复完成凭据持久化后、旧责任移除前执行。 */
  readonly afterRecoveryCompletedPersisted?: () => void
  /** 测试故障注入：旧责任移除后、完成返回前执行。 */
  readonly afterRecoveryResponsibilityRemoved?: () => void
}

export declare function writeRightPath(home?: string): string
export declare function acquireWriteRight(options?: MacWriteRightOptions):
  | {
      readonly acquired: true
      readonly abandoned: boolean
      readonly previousOwner?: MacWriteRightOwner
      assertHeld(): void
      completeRecovery(): boolean
      release(): boolean
    }
  | { readonly acquired: false; readonly reason: 'held' | 'unavailable' }

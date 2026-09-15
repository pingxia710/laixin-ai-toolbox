/** 守护单实例锁：同一数据目录同一时刻只准跑一个守护。与 settings.lock（临界区锁）语义不同，⛔ 混用。 */
export declare function instanceLockPath(dataDir: string): string
export declare function readInstanceLock(dataDir: string): { holder: { token?: string; pid?: number; runId?: string; at?: number } | undefined; ino: number } | undefined
export declare function acquireInstanceLock(dataDir: string, options?: { runId?: string; maxAttempts?: number }):
  | { acquired: true; token: string; release: () => void }
  | { acquired: false; holder: { pid?: number; runId?: string } | undefined }
export declare function takeOverStaleInstanceLock(dataDir: string, observed: NonNullable<ReturnType<typeof readInstanceLock>>): boolean

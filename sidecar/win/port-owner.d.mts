/** 认一认占着入口端口的是谁。只识别，⛔ 执行对方目录里的任何命令。 */
export declare const LAIXIN_PROCESS_NAMES: readonly string[]

export interface PortOwner {
  kind: 'laixin' | 'other' | 'unknown'
  pid?: number
  name?: string
  path?: string
}

export declare function identifyPortOwner(port: number, options?: { exec?: unknown; timeoutMs?: number }): PortOwner
export declare function parsePortOwner(raw: string | undefined, exists?: (path: string) => boolean): PortOwner
export declare function isLaixinXrayPath(path: string, exists?: (path: string) => boolean): boolean
export declare function isLaixinInstallDir(dir: string, exists?: (path: string) => boolean): boolean
export declare function isLaixinExePath(exePath: string, exists?: (path: string) => boolean): boolean

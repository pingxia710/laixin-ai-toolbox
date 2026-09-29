export declare function isLaixinDaemonCommand(command: unknown): boolean
export declare function identifyPortOwner(
  port: number,
  options?: {
    readonly exec?: (file: string, args: readonly string[], options: { readonly encoding: string; readonly timeout: number; readonly stdio: readonly string[] }) => string
    readonly timeoutMs?: number
  }
): { readonly kind: string; readonly pid?: number; readonly reason?: string }

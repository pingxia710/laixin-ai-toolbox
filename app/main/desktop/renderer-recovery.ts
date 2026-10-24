// 渲染进程崩溃自愈(收敛包3·件3):第一次崩溃自动 reload 一次并提示;
// 平静期内连续崩溃 ⛔ 再无限 reload,改为给可复制的诊断信息。
export const RENDERER_CRASH_CALM_MS = 30_000

export interface RendererCrashDetails {
  readonly reason: string
  readonly exitCode: number
}

export interface RendererRecoveryDeps {
  reload(): void
  notify(message: string): void
  showDialog(title: string, message: string, detail: string): void
  now(): number
}

export function createRendererRecovery(deps: RendererRecoveryDeps) {
  let lastCrashAt: number | undefined
  let crashCount = 0
  return {
    handle(details: RendererCrashDetails): void {
      const at = deps.now()
      if (lastCrashAt === undefined || at - lastCrashAt > RENDERER_CRASH_CALM_MS) crashCount = 0
      lastCrashAt = at
      crashCount += 1
      if (crashCount === 1) {
        deps.reload()
        deps.notify('界面出现异常，已自动恢复；若反复出现请查看设置里的诊断信息')
        return
      }
      // 连续崩溃:reload 治不好,给出可复制诊断,⛔ 无限白屏循环
      const detail = `连续崩溃次数:${crashCount}\n原因:${details.reason}\n退出码:${details.exitCode}\n时间:${new Date(at).toISOString()}`
      deps.showDialog('来信AI工具箱 · 界面异常', '界面连续异常，已停止自动恢复。', `以下信息可复制，发送给来信客服可加快定位：\n${detail}`)
    }
  }
}

// 主进程顶层异常落盘(收敛包3·件3):⛔ 静默丢失。
export function createMainCrashLog(append: (line: string) => void, now: () => number = Date.now) {
  return (kind: string, error: unknown): void => {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    try {
      append(`${new Date(now()).toISOString()} [${kind}] ${message}\n`)
    } catch { /* 日志写不进不能再生异常 */ }
  }
}

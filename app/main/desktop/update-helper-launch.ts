import type { SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'

export interface HelperLaunch { command: string; args: string[]; options: SpawnOptions }

/** 更新助手怎么起。
 *
 *  Windows 为什么不是 `spawn('powershell.exe', […], { detached: true })`(v0.4.8~0.5.11 的写法):
 *  PowerShell 在 DETACHED_PROCESS(无控制台)下**不执行脚本**——进程创建成功、约 0.4 秒 exit 0、脚本一行没跑,
 *  主进程等不到 helper-ready,30 秒后报「更新程序没能启动」(2026-09-17 0.5.10→0.5.11 真机;不经 Node 直接
 *  CreateProcess 同样标志也一样,与 Electron、x64 仿真、默认终端设置都无关)。而去掉 detached 直接起 PowerShell,
 *  它会落进 libuv 给非 detached 子进程建的「父死子亡」作业对象,主进程一退就被一起收掉,换不了文件。
 *
 *  现在的写法:非 detached 起 cmd(windowsHide ⇒ 一个隐藏控制台),由 cmd `start /b` 起 PowerShell——
 *  PowerShell 继承那个隐藏控制台所以会执行、没有任何可见窗口;它是作业成员的**孙**进程,作业允许静默脱离,
 *  主进程退出后照常活着把文件换完。同机对照过的其他方式(结果与脚本见 tasks/UP-01-更新器启动-交付报告-20260917.md):
 *  `start /min` 任务栏留一个最小化控制台直到助手结束;PowerShell 起 PowerShell 无窗口但冷启动两次;
 *  detached 的 cmd + start /b 会弹出一个终端窗口;`conhost --headless` 不执行。
 *
 *  三个路径走环境变量 ⛔ 拼进命令行:userData 在中文目录下,Windows 用户名还可以带 & ( ) % 空格;
 *  cmd 对 %VAR% 只展开一遍、引号内的 & ^ 不再解释,路径里又不可能有双引号。`/v:off` 防客户机注册表把
 *  延迟展开默认打开后 `!` 被吃掉,`/d` 不跑 AutoRun。系统程序用绝对路径,⛔ 靠 PATH 找。 */
export function helperLaunch(platform: 'mac' | 'win', executable: string, helperPath: string, jobPath: string,
  env: NodeJS.ProcessEnv): HelperLaunch {
  if (platform === 'mac') return { command: executable, args: [helperPath, jobPath],
    options: { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: 'ignore' } }
  const system = win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32')
  return { command: win32.join(system, 'cmd.exe'),
    args: ['/d /v:off /s /c "start "" /b "%LAIXIN_UPDATE_POWERSHELL%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%LAIXIN_UPDATE_HELPER%" -JobPath "%LAIXIN_UPDATE_JOB%""'],
    options: { env: { ...env, LAIXIN_UPDATE_POWERSHELL: win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      LAIXIN_UPDATE_HELPER: helperPath, LAIXIN_UPDATE_JOB: jobPath },
      detached: false, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true } }
}

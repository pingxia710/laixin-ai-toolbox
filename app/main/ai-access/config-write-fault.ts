// 把配置写入时底层的 fs 故障翻译成客户能照着做的一句话（纪律 2：⛔ 放弃式处理）。
// 只说三件事：哪个目录、属主是谁、下一步做什么；
// ⛔ 把 Key、令牌或配置内容带进错误信息——这里只拼路径、uid 和固定话术。
import { stat as defaultStat } from 'node:fs/promises'
import { dirname as posixDirname, win32 } from 'node:path'

const permissionCodes = new Set(['EACCES', 'EPERM'])

/** 测试注入用的一小块 stat 形状（真实 Stats 满足它）。 */
export interface ConfigWriteFaultStat {
  readonly uid?: number
  isDirectory(): boolean
}

export interface ConfigWriteFaultDeps {
  readonly stat?: (path: string) => Promise<ConfigWriteFaultStat | undefined>
  /** Windows 没有 uid，让它是 undefined。 */
  readonly currentUid?: number
  readonly platform?: string
}

interface FaultCore {
  readonly code?: string
  readonly path?: string
}

/** 写入链路把原始 fs 错误包进 `cause`（file.ts 的 AI_ACCESS_CONFIG_FILE_INVALID 等）；剥开拿 code 和 path。 */
export function configFaultCore(error: unknown): FaultCore {
  const candidates: readonly unknown[] = [error, (error as { readonly cause?: unknown } | undefined)?.cause]
  for (const candidate of candidates) {
    const code = (candidate as NodeJS.ErrnoException | undefined)?.code
    const path = (candidate as { readonly path?: unknown } | undefined)?.path
    const codeText = typeof code === 'string' && code !== '' ? code : undefined
    if (typeof path === 'string' && path !== '') return { ...(codeText !== undefined ? { code: codeText } : {}), path }
    if (codeText !== undefined) return { code: codeText }
  }
  return {}
}

async function statOrUndefined(path: string): Promise<ConfigWriteFaultStat | undefined> {
  return await defaultStat(path)
}

/** Windows 路径用反斜杠，⛔ 用 POSIX dirname 把 `C:\x\y` 切成 `.`。 */
function splitDirectory(platform: string, path: string): string {
  return platform === 'win32' ? win32.dirname(path) : posixDirname(path)
}

export async function configWriteFaultNotice(error: unknown, deps: ConfigWriteFaultDeps = {}): Promise<string | undefined> {
  const core = configFaultCore(error)
  if (core.path === undefined && core.code === undefined) return undefined
  const stat = deps.stat ?? statOrUndefined
  const currentUid = deps.currentUid ?? process.getuid?.()
  const platform = deps.platform ?? process.platform
  let info: ConfigWriteFaultStat | undefined
  let directory: string | undefined
  if (core.path !== undefined) {
    try { info = await stat(core.path) } catch { info = undefined }
    // fs 错误里的 path 可能是临时文件或最终文件；客户要修的是装配置的那个目录。
    directory = info?.isDirectory() === true ? core.path : splitDirectory(platform, core.path)
    if (info === undefined) {
      try { info = await stat(directory) } catch { info = undefined }
    }
  }
  const place = directory === undefined ? '配置目录' : `「${directory}」`
  const owner = info?.uid !== undefined && currentUid !== undefined
    ? info.uid === currentUid ? '（属主是当前用户）' : `（属主是 uid ${info.uid}，当前用户是 uid ${currentUid}）`
    : ''
  return `配置写入被挡住了：工具箱无法写入${place}${owner}。${guidanceFor(core.code, platform, directory)}`
}

function guidanceFor(code: string | undefined, platform: string, directory: string | undefined): string {
  const place = directory ?? '该目录'
  if (code === 'EROFS') return '这个目录在只读卷上；请把配置搬回可写目录（或在系统里解除只读）后，回来再点一次「启用」。'
  if (code === 'ENOSPC') return '磁盘满了；请清理出可用空间后，回来再点一次「启用」。'
  if (code !== undefined && permissionCodes.has(code)) {
    return platform === 'win32'
      ? `请在本机（或找设备管理员）去掉${place}的只读属性、修复安全权限，再回来点一次「启用」。工具箱不会自动改这些设置。`
      : `请在终端把${place}的属主和权限修回当前用户（例如：sudo chown -R "$(whoami)" ${place}），或找设备管理员处理，然后回来点一次「启用」。工具箱不会自动改属主。`
  }
  return `请检查${place}的磁盘与权限后，回来再点一次「启用」。`
}

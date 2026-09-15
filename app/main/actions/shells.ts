import { net, shell as electronShell } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { shellIds, type ShellId } from '../recipes/recipes'
import { recipeStore, shellInstaller, shellInventory } from '../shells/context'

const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 100_000 }) })
const shellSchema = schema.object({ shell: schema.string({ maxLength: 24 }) })
const respond = async (value: Promise<unknown> | unknown) => ({ snapshot: JSON.stringify(await value) })

function readShell(value: string): ShellId {
  if (!shellIds.includes(value as ShellId)) throw new Error('SHELL_INVALID')
  return value as ShellId
}

export function registerActions(registry: BridgeRegistry): void {
  registry.registerAction({ name: 'shells.inventory', paramsSchema: schema.undefined(), resultSchema,
    handler: async () => { await recipeStore().load(); return respond(shellInventory().list()) } })
  registry.registerAction({ name: 'shells.install', paramsSchema: shellSchema, resultSchema,
    handler: (params) => respond(shellInstaller().start(readShell((params as { shell: string }).shell))) })
  registry.registerAction({ name: 'shells.installStatus', paramsSchema: schema.undefined(), resultSchema,
    handler: () => respond(shellInstaller().status()) })
  registry.registerAction({ name: 'shells.openOfficialPage', paramsSchema: shellSchema, resultSchema,
    handler: async (params) => {
      const id = readShell((params as { shell: string }).shell)
      await electronShell.openExternal(recipeStore().current().shells[id].officialPage)
      return respond({ opened: true })
    } })
  registry.registerAction({ name: 'shells.open', paramsSchema: shellSchema, resultSchema,
    handler: async (params) => {
      const entry = await shellInventory().inspect(readShell((params as { shell: string }).shell))
      if (entry.installed !== true) return respond({ opened: false, message: '尚未安装。' })
      if (entry.versionUnknown) {
        return respond({ opened: false, message: `${entry.label} 的安装入口尚未确认。为避免执行未知命令，请从工具箱完成官方安装后再打开。` })
      }
      if (/\.app$/i.test(entry.location)) {
        const failure = await electronShell.openPath(entry.location)
        return respond(failure ? { opened: false, message: '软件未能打开，请重试。' } : { opened: true, message: `正在打开 ${entry.label}。` })
      }
      return respond({ opened: false, message: `${entry.label} 是命令行工具：打开终端输入 ${entry.location.split(/[\\/]/).pop()} 即可使用。` })
    } })
  registry.registerAction({ name: 'shells.reachability', paramsSchema: shellSchema, resultSchema,
    handler: async (params) => {
      const id = readShell((params as { shell: string }).shell)
      const url = recipeStore().current().shells[id].officialPage
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6_000)
      try {
        // net.fetch 走系统网络设置：客户自己的代理 / PAC / 专线都算数。
        const response = await net.fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
        return respond({ reachable: response.status > 0 && response.status < 500, status: response.status, url })
      } catch {
        return respond({ reachable: false, status: 0, url })
      } finally { clearTimeout(timer) }
    } })
  registry.registerAction({ name: 'shells.refreshRecipes', paramsSchema: schema.undefined(), resultSchema,
    handler: async () => { await recipeStore().load(); const updated = await recipeStore().refresh(); return respond({ updated, version: recipeStore().current().version }) } })
}

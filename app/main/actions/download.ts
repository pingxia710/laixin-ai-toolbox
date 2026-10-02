import { shell } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { loadCatalog } from '../download/catalog'

// RETIRE01:下载引擎从未接线生产,已整体退役;工具箱只提供网络通道,安装包到官方页面获取。
// 这里只保留渲染层平台安装卡在用的「到官方下载页」入口(白名单 + 目录只读 + 开浏览器)。
const officialEntries = new Set([
  'codex-official-download', 'codex-github',
  'claude-code-official-install', 'claude-code-github',
  'hermes-official-download', 'hermes-github',
  'deepseek-harness-official-install', 'deepseek-harness-github',
  'zcode-official-download',
  'kimi-code-official-install', 'kimi-code-github'
])

const resourceSchema = schema.object({ resourceId: schema.string({ maxLength: 100 }) })
const resultSchema = schema.object({
  taskId: schema.string({ maxLength: 100 }),
  state: schema.string({ maxLength: 100 }),
  reason: schema.string({ maxLength: 100 }),
  message: schema.string({ maxLength: 100 }),
  receivedBytes: schema.string({ maxLength: 100 }),
  totalBytes: schema.string({ maxLength: 100 }),
  retryCount: schema.string({ maxLength: 100 }),
  localSha256: schema.string({ maxLength: 100 }),
  installerPath: schema.string({ maxLength: 500 })
})

export function registerActions(registry: BridgeRegistry): void {
  registry.registerAction({
    name: 'download.openExternal',
    paramsSchema: resourceSchema,
    resultSchema,
    handler: async (params) => {
      const resourceId = (params as { readonly resourceId: string }).resourceId
      if (!officialEntries.has(resourceId)) throw new Error('DOWNLOAD_ENTRY_UNAVAILABLE')
      const resource = loadCatalog().resources.find((item) => item.id === resourceId && item.type === 'external-entry')
      if (!resource) throw new Error('DOWNLOAD_ENTRY_UNAVAILABLE')
      await shell.openExternal(resource.officialPageUrl)
      return { taskId: '', state: 'opened-external', reason: '', message: '已打开官方页面', receivedBytes: '0', totalBytes: '0', retryCount: '0', localSha256: '', installerPath: '' }
    }
  })
}

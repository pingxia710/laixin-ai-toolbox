import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import type { DesktopRuntime } from './runtime'

export function registerDesktopActions(registry: BridgeRegistry, desktop: DesktopRuntime): void {
  registry.registerAction({ name: 'desktop.ready', paramsSchema: schema.undefined(), resultSchema: schema.boolean(),
    handler: async () => { await desktop.ready(); return true } })
  const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 100_000 }) })
  for (const [name, handler] of Object.entries({ status: () => desktop.status(), applications: () => desktop.launcher.list(),
    checkUpdate: () => desktop.checkUpdate(), downloadUpdate: () => desktop.updater.download(), installUpdate: () => desktop.updater.install() })) {
    registry.registerAction({ name: `desktop.${name}`, paramsSchema: schema.undefined(), resultSchema,
      handler: async () => ({ snapshot: JSON.stringify(await handler()) }) })
  }
  // 「更新成功」弹窗的内容。装完后的第一次启动有值,其余时候返回空串三件套(⛔ 让渲染层每次启动
  // 都能安全地问一遍);不用推送是因为桥 ready 与渲染层初始化是两次握手,推送可能没人接。
  registry.registerAction({ name: 'desktop.updateSuccess', paramsSchema: schema.undefined(),
    resultSchema: schema.object({ version: schema.string({ maxLength: 40 }), previous: schema.string({ maxLength: 40 }),
      notes: schema.string({ maxLength: 20_000 }) }),
    handler: () => desktop.updateSuccess() })
  registry.registerAction({ name: 'desktop.configure', paramsSchema: schema.object({ zoom: schema.string({ maxLength: 8 }), quotaNotifications: schema.boolean(), autoUpdate: schema.boolean() }), resultSchema,
    handler: async (params) => { const { zoom, quotaNotifications, autoUpdate } = params as { zoom: string; quotaNotifications: boolean; autoUpdate: boolean }
      return { snapshot: JSON.stringify(await desktop.configure(zoom, quotaNotifications, autoUpdate)) } } })
  registry.registerAction({ name: 'desktop.openApplication', paramsSchema: schema.object({ id: schema.string({ maxLength: 20 }) }),
    resultSchema: schema.object({ opened: schema.boolean(), message: schema.string({ maxLength: 300 }) }),
    handler: (params) => desktop.launcher.open((params as { id: string }).id) })
  const loginItemSchema = schema.object({ enabled: schema.boolean(), supported: schema.boolean() })
  registry.registerAction({ name: 'desktop.loginItem', paramsSchema: schema.undefined(), resultSchema: loginItemSchema,
    handler: () => desktop.loginItem() })
  registry.registerAction({ name: 'desktop.setLoginItem', paramsSchema: schema.object({ enabled: schema.boolean() }), resultSchema: loginItemSchema,
    handler: (params) => desktop.setLoginItem((params as { enabled: boolean }).enabled) })
  // 「工具箱意外退出时,网络不断」。比开机自启多一个 active:
  //  · supported=false = 这台机器上这个开关用不了(设置页置灰并说明);
  //  · enabled && !active = 客户选了开、但常驻这次没装上 —— 开关显示着开而那件事并没有发生,
  //    设置页必须把这一态说出来,⛔ 只往日志里写一行(那是把诚实停在没人看得见的地方)。
  //  · staleResidentTask = 没生效且系统里的存量管理员任务与本版定义不一致(甲-10 返工):
  //    「下次打开会再试一次」在这个状态下不成立,设置页换用带自救动作的文案。
  const residentSchema = schema.object({ enabled: schema.boolean(), supported: schema.boolean(), active: schema.boolean(), staleResidentTask: schema.boolean() })
  registry.registerAction({ name: 'desktop.residentEnabled', paramsSchema: schema.undefined(), resultSchema: residentSchema,
    handler: () => desktop.residentEnabled() })
  registry.registerAction({ name: 'desktop.setResidentEnabled', paramsSchema: schema.object({ enabled: schema.boolean() }), resultSchema: residentSchema,
    handler: (params) => desktop.setResidentEnabled((params as { enabled: boolean }).enabled) })
  // FB-1:连接失败自动回传故障类型。supported 恒真,与 loginItem 同形(⛔ 走 read():开关类返回普通对象)。
  registry.registerAction({ name: 'desktop.failureReportEnabled', paramsSchema: schema.undefined(), resultSchema: loginItemSchema,
    handler: () => desktop.failureReportEnabled() })
  registry.registerAction({ name: 'desktop.setFailureReportEnabled', paramsSchema: schema.object({ enabled: schema.boolean() }), resultSchema: loginItemSchema,
    handler: (params) => desktop.setFailureReportEnabled((params as { enabled: boolean }).enabled) })
}

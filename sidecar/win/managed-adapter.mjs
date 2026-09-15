// 将 WinINET 系统代理与终端 hook 放进同一账本；TerminalEnvironment 项只由其专属适配器处理。
import { TERMINAL_ENVIRONMENT_SERVICE, createTerminalEnvironmentAdapter } from './terminal-environment.mjs'

export async function createAdapter(options = {}) {
  // 仅默认真实启动路径加载 WinINET；composeManagedAdapters 的纯测试不触发系统适配器闸。
  const { createAdapter: createNetworkAdapter } = await import('./adapter-wininet.mjs')
  // 系统代理写入权(创始人 2026-09-15):Windows 独有的会话级命名互斥体。mac 侧不提供这个方法,
  // 守护据此走原有路径——⛔ 顺手改掉另一个平台的语义。
  const { acquireWriteRight } = await import('./wininet-write-right.mjs')
  const { identifyPortOwner } = await import('./port-owner.mjs')
  return composeManagedAdapters(
    createNetworkAdapter(options),
    createTerminalEnvironmentAdapter(options),
    options.acquireWriteRight ?? acquireWriteRight,
    options.identifyPortOwner ?? identifyPortOwner
  )
}

export function composeManagedAdapters(networkAdapter, terminalAdapter, acquireWriteRight, identifyPortOwner) {
  if (networkAdapter === null || typeof networkAdapter !== 'object' || terminalAdapter === null || typeof terminalAdapter !== 'object') {
    throw new Error('MANAGED_ADAPTER_INVALID')
  }
  const isTerminalRef = (ref) => ref?.service === TERMINAL_ENVIRONMENT_SERVICE
  const terminalValue = (value) => value?.kind === 'terminal-environment' ||
    value?.kind === 'terminal-file-state' || value?.kind === 'terminal-registry-state'
  const networkEqual = networkAdapter.valuesEqual ?? ((left, right) => JSON.stringify(left) === JSON.stringify(right))
  // 终端自动接入是可选项(发布审查 R2):它的 profile/注册表没权限、被占用,⛔ 变成系统代理网络的致命错误。
  // 这里把它归为「可选项不可用」码,守护跳过它、状态里说一句;网络照常起。
  let optionalNote = ''
  // 终端预检没过(profile 是软链/没权限等):这次会话干脆不碰终端配置,只做系统代理。
  let terminalDisabled = false
  const terminalOperation = (operation) => {
    try {
      return operation()
    } catch (error) {
      optionalNote = '终端自动接入这次没启用（配置文件无法访问），浏览器与系统代理不受影响'
      throw Object.assign(new Error(`终端接入配置不可用:${error instanceof Error ? error.message : String(error)}`), {
        code: 'TUNNEL_OPTIONAL_SETTING_UNAVAILABLE'
      })
    }
  }
  const terminalQuiet = (operation, fallback) => {
    try { return operation() } catch { return fallback }
  }

  return {
    // 只有拿到这把权才允许碰 WinINET;没注入实现(纯测试/mac)时不暴露该方法,守护视为无需协调。
    ...(typeof acquireWriteRight === 'function' ? { acquireWriteRight } : {}),
    // 端口被占时认人用;没注入(mac/纯测试)时守护沿用「换下一个候选」的原行为。
    ...(typeof identifyPortOwner === 'function' ? { identifyPortOwner } : {}),
    preserveExternalChanges: (ref) => !isTerminalRef(ref) && networkAdapter.preserveExternalChanges?.(ref) === true,
    reapplyOnChange: (ref) => !isTerminalRef(ref) && networkAdapter.reapplyOnChange?.(ref) === true,
    existingProxy: (ours) => networkAdapter.existingProxy?.(ours),
    // 「满足接管要求」与「修回写什么」两个钩子只对系统代理项有意义;终端项按完整值。
    settingSatisfied(current, written, ref) {
      if (isTerminalRef(ref) || !networkAdapter.settingSatisfied) return this.valuesEqual(current, written, ref)
      return networkAdapter.settingSatisfied(current, written, ref)
    },
    repairValue: (ref, current, written) => (isTerminalRef(ref) || !networkAdapter.repairValue) ? written : networkAdapter.repairValue(ref, current, written),
    optionalNote: () => optionalNote,
    preflight(proxy) {
      networkAdapter.preflight?.(proxy)
      // 终端预检失败只记一句、本次不再碰终端配置,⛔ 挡网络
      try { terminalOperation(() => terminalAdapter.preflight?.(proxy)); terminalDisabled = false } catch { terminalDisabled = true }
    },
    managedItems(proxy) {
      const network = networkAdapter.managedItems(proxy)
      let terminal = []
      if (!terminalDisabled) {
        try { terminal = terminalOperation(() => terminalAdapter.managedItems(proxy)) } catch { terminal = [] }
      }
      if (!Array.isArray(network) || !Array.isArray(terminal)) throw new Error('MANAGED_ITEMS_INVALID')
      return [...network, ...terminal]
    },
    read(ref) {
      return isTerminalRef(ref) ? terminalOperation(() => terminalAdapter.read(ref)) : networkAdapter.read(ref)
    },
    write(ref, value) {
      return isTerminalRef(ref) ? terminalOperation(() => terminalAdapter.write(ref, value)) : networkAdapter.write(ref, value)
    },
    valuesEqual(current, written, ref) {
      return terminalValue(written) ? terminalQuiet(() => terminalAdapter.valuesEqual(current, written), false) : networkEqual(current, written, ref)
    },
    restoredValueMatches(current, originalValue, writtenValue) {
      if (terminalValue(writtenValue)) return terminalQuiet(() => terminalAdapter.restoredValueMatches(current, originalValue, writtenValue), false)
      return networkAdapter.restoredValueMatches?.(current, originalValue, writtenValue) === true
    },
    broadcastSettingsChanged() {
      return networkAdapter.broadcastSettingsChanged?.()
    }
  }
}

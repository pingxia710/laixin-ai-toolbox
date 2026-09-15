// 将系统代理与终端 hook 放进同一账本；TerminalEnvironment 项只由其专属适配器处理。
import { TERMINAL_ENVIRONMENT_SERVICE, createTerminalEnvironmentAdapter } from './terminal-environment.mjs'

// 延迟加载真实系统适配器：测试可单独验证复合/恢复语义，真实系统写入闸仍在 createAdapter 时生效。
export async function createAdapter(options = {}) {
  const { createAdapter: createNetworkAdapter } = await import('./adapter-networksetup.mjs')
  return composeManagedAdapters(createNetworkAdapter(options), createTerminalEnvironmentAdapter(options))
}

export function composeManagedAdapters(networkAdapter, terminalAdapter) {
  if (networkAdapter === null || typeof networkAdapter !== 'object' || terminalAdapter === null || typeof terminalAdapter !== 'object') {
    throw new Error('MANAGED_ADAPTER_INVALID')
  }
  const isTerminalRef = (ref) => ref?.service === TERMINAL_ENVIRONMENT_SERVICE
  const terminalValue = (value) => value?.kind === 'terminal-environment' || value?.kind === 'terminal-file-state'
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
    preserveExternalChanges: (ref) => !isTerminalRef(ref) && networkAdapter.preserveExternalChanges?.(ref) === true,
    reapplyOnChange: (ref) => !isTerminalRef(ref) && networkAdapter.reapplyOnChange?.(ref) === true,
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

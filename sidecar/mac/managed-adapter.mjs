// 将系统代理与终端 hook 放进同一账本；TerminalEnvironment 项只由其专属适配器处理。
import { TERMINAL_ENVIRONMENT_SERVICE, createTerminalEnvironmentAdapter } from './terminal-environment.mjs'
import { ledgerFailure } from './ledger.mjs'
import { recoverLedger, restoreLedger, unrestoredEntries } from './restore.mjs'
import { identifyPortOwner } from './port-owner.mjs'

// 延迟加载真实系统适配器：测试可单独验证复合/恢复语义，真实系统写入闸仍在 createAdapter 时生效。
export async function createAdapter(options = {}) {
  const { createAdapter: createNetworkAdapter } = await import('./adapter-networksetup.mjs')
  const { acquireWriteRight } = await import('./macos-write-right.mjs')
  return composeManagedAdapters(
    createNetworkAdapter(options),
    createTerminalEnvironmentAdapter(options),
    options.acquireWriteRight ?? acquireWriteRight,
    options.identifyPortOwner ?? identifyPortOwner
  )
}

export function composeManagedAdapters(networkAdapter, terminalAdapter, acquireWriteRight, identifyOwner) {
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
  let activeWriteRight
  let pendingRecoveryRelease
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
  const leaseWriteRight = (state, overrides = {}) => {
    state.references += 1
    let released = false
    return {
      ...state.acquired,
      ...overrides,
      release() {
        if (released) return true
        // 同一 adapter 内的 resident/crash 恢复会嵌套拿权；内层只放自己的引用，最后一层才交还原生席位。
        if (state.references > 1) {
          state.references -= 1
          released = true
          return true
        }
        const confirmed = state.acquired.release()
        if (confirmed === false) return false
        state.references = 0
        released = true
        if (activeWriteRight === state) activeWriteRight = undefined
        return true
      },
      deferRelease() {
        if (released) return
        state.references = Math.max(0, state.references - 1)
        released = true
        if (state.references === 0) state.pendingRelease = true
      }
    }
  }
  const confirmRecoveryRelease = (outcome) => {
    let released = false
    try { released = outcome.release() !== false } catch { /* 保留同一 handle，下一次 acquire 前再试 */ }
    if (released) {
      if (pendingRecoveryRelease === outcome) pendingRecoveryRelease = undefined
    } else pendingRecoveryRelease = outcome
    return released
  }

  let adapter
  const guardedAcquire = typeof acquireWriteRight === 'function'
    ? (options) => {
        if (pendingRecoveryRelease !== undefined && !confirmRecoveryRelease(pendingRecoveryRelease)) {
          return { acquired: false, reason: 'recovery-incomplete' }
        }
        if (activeWriteRight?.pendingRelease === true) {
          const pending = activeWriteRight
          let confirmed = false
          try { confirmed = pending.acquired.release() !== false } catch { /* 下次 acquire 再试 */ }
          if (!confirmed) return { acquired: false, reason: 'unavailable' }
          pending.pendingRelease = false
          if (activeWriteRight === pending) activeWriteRight = undefined
        }
        if (activeWriteRight !== undefined) {
          try { activeWriteRight.acquired.assertHeld?.() } catch { return { acquired: false, reason: 'unavailable' } }
          return leaseWriteRight(activeWriteRight, {
            abandoned: false,
            ...(activeWriteRight.abandonedRecovered ? { abandonedRecovered: true } : {})
          })
        }
        const acquired = acquireWriteRight(options)
        if (acquired?.acquired !== true) return acquired
        const state = { acquired, references: 0, abandonedRecovered: false, pendingRelease: false }
        activeWriteRight = state
        const outcome = leaseWriteRight(state)
        if (outcome.abandoned !== true) return outcome
        const previousDataDir = outcome.previousOwner?.dataDir
        if (typeof previousDataDir !== 'string' || previousDataDir === '') {
          confirmRecoveryRelease(outcome)
          return { acquired: false, reason: 'recovery-incomplete' }
        }
        try {
          const failure = ledgerFailure(previousDataDir)
          if (failure !== undefined) {
            const recovered = recoverLedger(previousDataDir, adapter)
            if (recovered === undefined || recovered.failed.length > 0 || ledgerFailure(previousDataDir) !== undefined) {
              confirmRecoveryRelease(outcome)
              return { acquired: false, reason: 'recovery-incomplete' }
            }
          }
          const restored = restoreLedger(previousDataDir, adapter)
          if (restored.failed.length > 0 || unrestoredEntries(previousDataDir).length > 0) {
            confirmRecoveryRelease(outcome)
            return { acquired: false, reason: 'recovery-incomplete' }
          }
          if (outcome.completeRecovery?.() !== true) {
            confirmRecoveryRelease(outcome)
            return { acquired: false, reason: 'recovery-incomplete' }
          }
          // 前任账本已按所有权规则结清。DaemonCore 的 abandoned 分支只会恢复当前 dataDir；
          // 这里把“前任已恢复”显式交代清楚，避免再拿新实例的空账本冒充恢复。
          state.abandonedRecovered = true
          return { ...outcome, abandoned: false, abandonedRecovered: true }
        } catch {
          confirmRecoveryRelease(outcome)
          return { acquired: false, reason: 'recovery-incomplete' }
        }
      }
    : undefined

  adapter = {
    ...(guardedAcquire === undefined ? {} : { acquireWriteRight: guardedAcquire }),
    ...(typeof identifyOwner === 'function' ? { identifyPortOwner: identifyOwner } : {}),
    // 不具备路径读取能力与“读取失败”不同：前者让守护跳过直连复用、转入有快照/租约的接管；
    // 后者保留方法并由守护形成受控证据限制，不能被空包装器混为一谈。
    ...(typeof networkAdapter.currentPathIdentity === 'function'
      ? { currentPathIdentity: () => networkAdapter.currentPathIdentity() } : {}),
    existingProxy: (ours) => networkAdapter.existingProxy?.(ours),
    validateExistingProxy: (candidate) => networkAdapter.validateExistingProxy?.(candidate),
    materializeExistingProxy: (candidate) => networkAdapter.materializeExistingProxy?.(candidate) ?? candidate,
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
      // 原始文件席位可能被外部替换/误删；每次真正改系统设置前都核 inode+token。
      // 没有注入写权原语的纯适配器测试维持原契约；生产 mac 适配器必经 guardedAcquire。
      if (guardedAcquire !== undefined) {
        if (activeWriteRight === undefined || activeWriteRight.pendingRelease === true) {
          throw Object.assign(new Error('TUNNEL_WRITE_RIGHT_LOST:macOS 系统代理写入权未持有'), { code: 'TUNNEL_WRITE_RIGHT_LOST' })
        }
        activeWriteRight.acquired.assertHeld?.()
      }
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
  return adapter
}

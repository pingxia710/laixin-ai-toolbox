// Windows 终端环境适配器:写受管 profile、Git Bash hook 与 cmd AutoRun,并在连接期间把代理变量
// 写进用户级环境变量(HKCU\Environment)。PowerShell 默认执行策略是 Restricted,不加载 profile;
// AutoRun 又只有 cmd 有——用户级环境变量是唯一对 cmd 和 PowerShell 同时生效、不依赖执行策略的
// 通道(Explorer 收到环境变更广播后,新开的终端进程都带这套变量)。
// 所有权规矩:read() 只返回所有权/指纹快照,客户原文(profile 脚本、AutoRun 命令、外来环境变量值)
// 一律不进恢复账本;外来值绝不覆盖;恢复只删/改我们写入且未被别人改动的部分。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const TERMINAL_ENVIRONMENT_SERVICE = 'TerminalEnvironment'
const MARKER_PREFIX = 'LAIXIN_AI_TOOLBOX_TERMINAL_V1'
const ENVIRONMENT_GATE = 'TOOLBOX_REAL_TERMINAL_ENVIRONMENT'
const COMMAND_PROCESSOR_KEY = 'HKCU\\Software\\Microsoft\\Command Processor'
// 父键在任何 Windows 上都存在：Command Processor 整个可选键不在（新装系统常见）时，用它证明注册表本身可读。
const COMMAND_PROCESSOR_PARENT_KEY = 'HKCU\\Software\\Microsoft'
const REGISTRY_DENIED = /denied|拒绝/i
const AUTO_RUN_ITEM = 'win-cmd-autorun'
// 用户级环境变量:每个变量是**独立受管项**,所有权按变量逐个判定——连接时缺失或已是我们的值 → 写;
// 别人写的值 → 跳过(⛔ 覆盖);断开只删仍是我们写的那个,被外部改掉的保留现值。整项结算会把
// 「一个被改、三个还是我们的」的账目结成终态 kept-modified,残留指向已关闭的本机端口(验收 2026-09-17)。
const USER_ENVIRONMENT_LEGACY_ITEM = 'win-user-environment'
const USER_ENVIRONMENT_TARGETS = Object.freeze([
  { item: 'win-user-env-http-proxy', variable: 'HTTP_PROXY' },
  { item: 'win-user-env-https-proxy', variable: 'HTTPS_PROXY' },
  { item: 'win-user-env-all-proxy', variable: 'ALL_PROXY' },
  { item: 'win-user-env-no-proxy', variable: 'NO_PROXY' }
])
const USER_ENVIRONMENT_KEY = 'HKCU\\Environment'
// Environment 键整个缺失(极端精简配置)时,用必然存在的 HKCU 根键证明注册表本身可读,与 AutoRun 同一判别法。
const USER_ENVIRONMENT_PARENT_KEY = 'HKCU'
const USER_ENVIRONMENT_NAMES = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])
// 环境变更广播参数:HWND_BROADCAST、WM_SETTINGCHANGE、SMTO_ABORTIFHUNG。
const NOTIFY_HWND_BROADCAST = 0xffff
const NOTIFY_WM_SETTINGCHANGE = 0x1a
const NOTIFY_SMTO_ABORTIFHUNG = 0x0002
const NOTIFY_TIMEOUT_MS = 2_000
const NOTIFY_ATTEMPTS = 2
const NOTIFY_RETRY_MS = 300

const FILE_TARGETS = Object.freeze([
  { item: 'win-cmd-helper', relative: ['.laixin-ai-toolbox', 'terminal-proxy.cmd'], style: 'cmd-helper' },
  { item: 'win-powershell5-profile', relative: ['Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'], style: 'powershell' },
  { item: 'win-powershell7-profile', relative: ['Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'], style: 'powershell' },
  { item: 'win-git-bashrc', relative: ['.bashrc'], style: 'sh' },
  { item: 'win-git-bash-profile', relative: ['.bash_profile'], style: 'sh' }
])

// PowerShell profile 的根是「文档」已知文件夹:OneDrive 接管文档后 $PROFILE 在
// OneDrive\\Documents 下,写死 Documents\\ 会接不到。读注册表 Personal 取真实目录。
const PERSONAL_FOLDER_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
const PERSONAL_FOLDER_SCRIPT = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name Personal -ErrorAction Stop).Personal"

// PowerShell 回落广播通道:脚本经 stdin 传入(-Command -),避免命令行引号被两层解析;-ExecutionPolicy
// Bypass 只作用于这一次子进程调用,⛔ 不改客户系统的执行策略(与 wininet-settings.ps1 同一先例)。
const ENVIRONMENT_NOTIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$source = @'",
  'using System.Runtime.InteropServices;',
  'public static class LaixinEnvironmentNotify {',
  '  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  '  public static extern System.IntPtr SendMessageTimeout(System.IntPtr window, uint message, System.IntPtr wParam, string lParam, uint flags, uint timeout, out System.IntPtr result);',
  '}',
  "'@",
  'Add-Type -TypeDefinition $source',
  '$result = [System.IntPtr]::Zero',
  "if ([LaixinEnvironmentNotify]::SendMessageTimeout([System.IntPtr]0xffff, 0x1a, [System.IntPtr]::Zero, 'Environment', 2, 2000, [ref]$result) -eq [System.IntPtr]::Zero) { throw 'environment change notification failed' }",
  ''
].join('\n')

// 解析真实「文档」目录;读不到、展开后不在 HOME 内(⛔ 越界写)一律回退 HOME\\Documents。
function resolveDocumentsDirectory(run, home, injected) {
  if (injected !== undefined) return validatedDocumentsPath(injected, home) ?? join(home, 'Documents')
  let raw = ''
  try {
    raw = String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PERSONAL_FOLDER_SCRIPT]))
  } catch {
    return join(home, 'Documents')
  }
  return validatedDocumentsPath(raw.replace(/^\uFEFF/, '').trim(), home) ?? join(home, 'Documents')
}

function validatedDocumentsPath(raw, home) {
  if (raw === '') return undefined
  // REG_EXPAND_SZ 可能仍是 %USERPROFILE% 形态,也可能已被展开成绝对路径。
  const expanded = raw.replace(/%USERPROFILE%/gi, home)
  // 反斜杠归一到 /:Windows 路径 API 两者皆收,POSIX(测试宿主)也走同一条逻辑。
  const resolved = resolve(expanded.replace(/\\/g, '/'))
  if (!isAbsolute(resolved)) return undefined
  const rel = relative(home, resolved)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return undefined
  return resolved
}

function safeProxy(value) {
  return value !== null && typeof value === 'object' && value.host === '127.0.0.1' &&
    Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
}

// run 是同步且可注入的，以便测试绝不触真实 Windows 注册表。
export function createTerminalEnvironmentAdapter(options = {}) {
  const env = options.env ?? process.env
  const enabled = options.enabled === undefined ? env?.[ENVIRONMENT_GATE] === '1' : options.enabled === true
  const home = options.home ?? homedir()
  if (!isAbsolute(home)) throw terminalError('TERMINAL_ENVIRONMENT_HOME_INVALID')
  const run = options.run ?? defaultRun
  // N-23 计时日志:每项终端环境写入落一行耗时(带 [terminal-env] 前缀,随守护 stderr 进常驻日志)。
  // 真机教训(2026-09-18 HUAWEI):慢在哪一环只能靠账目间隔倒推;有了逐项耗时,「哪个变量、多少毫秒」一眼可见。
  const log = typeof options.log === 'function' ? options.log : () => undefined
  // 广播注入点(仅测试);生产用原生 koffi 通道,不在时回落 PowerShell,都尽力而为。
  const notifyEnvironmentChanged = options.notifyEnvironmentChanged ?? defaultEnvironmentNotify
  // 本实例的「广播欠发位」(合批见上):同步批次内第一次来欠下,批次末(setImmediate)真发一次。
  // 写入函数拿到的 notify 就是这个合批闭包,它们只管在写完处调一次。
  let notifyBatchScheduled = false
  const notifyEnvironmentChangedBestEffort = () => {
    if (notifyBatchScheduled) return
    notifyBatchScheduled = true
    setImmediate(() => {
      notifyBatchScheduled = false
      // 通知发不出去 ⛔ 把已写好的注册表值翻成失败:守护会把这条账目结成「可选项未写入、保留原状」,
      // 而值其实已经写进注册表,从此没人负责删。发不出只影响 Explorer 缓存的环境块何时刷新
      // (下次任何软件广播环境变更、或注销重登都会刷新),AutoRun 与系统代理不受影响。
      for (let attempt = 1; ; attempt += 1) {
        try { notifyEnvironmentChanged(); return } catch {
          if (attempt >= NOTIFY_ATTEMPTS) return
          defaultSleep(NOTIFY_RETRY_MS)
        }
      }
    })
  }
  // 首个片段为 Documents 的目标(PowerShell profile)落在真实「文档」目录下。
  const documents = resolveDocumentsDirectory(run, home, options.documentsDirectory)
  const files = new Map(FILE_TARGETS.map((target) => {
    const base = target.relative[0] === 'Documents' ? documents : home
    const rest = target.relative[0] === 'Documents' ? target.relative.slice(1) : target.relative
    return [target.item, { ...target, path: join(base, ...rest) }]
  }))
  const expectedByItem = new Map()

  const disabled = () => { throw terminalError('TERMINAL_ENVIRONMENT_DISABLED') }

  return {
    service: TERMINAL_ENVIRONMENT_SERVICE,
    enabled,
    owns(ref) {
      return ref?.service === TERMINAL_ENVIRONMENT_SERVICE && typeof ref.item === 'string' &&
        (files.has(ref.item) || ref.item === AUTO_RUN_ITEM || ref.item === USER_ENVIRONMENT_LEGACY_ITEM ||
          USER_ENVIRONMENT_TARGETS.some((target) => target.item === ref.item))
    },
    // 在连通前先确认所有 profile、cmd AutoRun 和用户级环境变量都可安全读写，避免已改系统代理后才失败。
    preflight(proxy) {
      if (!enabled) return
      for (const managed of this.managedItems(proxy)) this.read(managed.ref)
    },
    managedItems(proxy) {
      if (!enabled) return []
      if (!safeProxy(proxy)) throw terminalError('TERMINAL_ENVIRONMENT_PROXY_INVALID')
      const state = readUserEnvironment(run)
      const targets = [...FILE_TARGETS, registryTarget()]
        .concat(userEnvironmentTargets().map((target) => target))
      return targets.map((target) => {
        const value = descriptorFor(target, proxy,
          target.style === 'user-environment' ? planForVariable(state, target.variable, proxy) : undefined)
        expectedByItem.set(target.item, value)
        return { ref: { service: TERMINAL_ENVIRONMENT_SERVICE, item: target.item }, value }
      })
    },
    read(ref) {
      if (!enabled) return disabled()
      if (ref?.service !== TERMINAL_ENVIRONMENT_SERVICE || typeof ref.item !== 'string') {
        throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
      }
      const expected = expectedByItem.get(ref.item)
      if (ref.item === AUTO_RUN_ITEM) {
        const raw = readAutoRun(run)
        return registrySnapshot(raw, expected)
      }
      if (isUserVariableItem(ref.item)) {
        const target = userVariableTargetForItem(ref.item)
        const state = readUserEnvironment(run)
        const entry = state.get(target.variable)
        const snapshot = {
          kind: 'terminal-registry-state',
          target: target.item,
          exists: true,
          // 归属判定材料:缺失记 absent,在的记单向指纹;外来值 ⛔ 明文进快照/账本。
          variables: { [target.variable]: entry === undefined ? 'absent' : environmentValueFingerprint(entry.data) }
        }
        if (expected !== undefined) {
          const judgment = judgeEnvironment(snapshot, expected)
          snapshot.ownBlockPresent = judgment.present
          snapshot.ownBlockComplete = judgment.complete
          if (judgment.complete) snapshot.ownBlockDigest = expected.blockDigest
        }
        return withManagedDescriptor(snapshot, expected)
      }
      if (ref.item === USER_ENVIRONMENT_LEGACY_ITEM) {
        // 旧账本(整项四变量)的恢复专用读数:新连接不再产出这个项。
        const state = readUserEnvironment(run)
        const snapshot = {
          kind: 'terminal-registry-state',
          target: USER_ENVIRONMENT_LEGACY_ITEM,
          exists: true,
          variables: Object.fromEntries(USER_ENVIRONMENT_NAMES.map((name) => {
            const entry = state.get(name)
            return [name, entry === undefined ? 'absent' : environmentValueFingerprint(entry.data)]
          }))
        }
        if (expected !== undefined) {
          const judgment = judgeEnvironment(snapshot, expected)
          snapshot.ownBlockPresent = judgment.present
          snapshot.ownBlockComplete = judgment.complete
          if (judgment.complete) snapshot.ownBlockDigest = expected.blockDigest
        }
        return withManagedDescriptor(snapshot, expected)
      }
      const target = fileTargetFor(ref.item, files)
      const content = readContent(target.path, home)
      return fileSnapshot(target, content.exists, inspectFileBlock(content.value, target.item), expected)
    },
    write(ref, value) {
      if (!enabled) return disabled()
      if (ref?.service !== TERMINAL_ENVIRONMENT_SERVICE || typeof ref.item !== 'string') {
        throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
      }
      const startedAt = Date.now()
      try {
        if (ref.item === AUTO_RUN_ITEM) {
          writeAutoRunValue(run, value, expectedByItem.get(ref.item))
          return
        }
        if (isUserVariableItem(ref.item)) {
          writeUserVariableValue(run, notifyEnvironmentChangedBestEffort, ref.item, value, expectedByItem.get(ref.item))
          return
        }
        if (ref.item === USER_ENVIRONMENT_LEGACY_ITEM) {
          writeUserEnvironmentValue(run, notifyEnvironmentChangedBestEffort, value, expectedByItem.get(ref.item))
          return
        }
        const target = fileTargetFor(ref.item, files)
        writeFileValue(target, value, expectedByItem.get(ref.item), home)
      } finally {
        const elapsedMs = Date.now() - startedAt
        log(`[terminal-env] ${ref.item} 写入耗时 ${String(elapsedMs)} ms${elapsedMs >= 1_000 ? '(慢)' : ''}`)
      }
    },
    valuesEqual(current, written) {
      if (written?.kind !== 'terminal-environment') return false
      const target = targetForItem(written.target, files)
      if (target === undefined) return false
      let descriptor
      try { descriptor = checkedDescriptor(target, written) } catch { return false }
      if (target.style === 'user-environment' || target.style === 'user-environment-legacy') {
        return current?.kind === 'terminal-registry-state' && current.target === target.item &&
          judgeEnvironment(current, descriptor).complete
      }
      const expectedKind = target.storage === 'registry' ? 'terminal-registry-state' : 'terminal-file-state'
      return current?.kind === expectedKind && current.target === target.item &&
        current.ownBlockPresent === true && current.ownBlockComplete === true &&
        current.ownBlockDigest === descriptor.blockDigest
    },
    restoredValueMatches(current, originalValue, writtenValue) {
      if (writtenValue?.kind !== 'terminal-environment') return false
      const target = targetForItem(originalValue?.target, files)
      if (target === undefined) return false
      let descriptor
      try { descriptor = checkedDescriptor(target, writtenValue) } catch { return false }
      if (target.style === 'user-environment' || target.style === 'user-environment-legacy') {
        // 「已恢复」=计划内(set)的名字里不再有任何一条还是我们写的值;被别人改掉的同样算
        // 恢复责任了结(⛔ 硬改回别人的现值)。按变量结算后计划里最多只有一条。
        return USER_ENVIRONMENT_NAMES.every((name) => {
          if (descriptor.variables[name] !== 'set') return true
          const state = current?.variables?.[name]
          return state === undefined || state === 'absent' ||
            state !== environmentValueFingerprint(expectedEnvironmentValue(name, descriptor.proxy))
        })
      }
      const expectedKind = target.storage === 'registry' ? 'terminal-registry-state' : 'terminal-file-state'
      return current?.kind === expectedKind && current.target === target.item && current.ownBlockPresent === false
    }
  }
}

function registryTarget() {
  return { item: AUTO_RUN_ITEM, style: 'cmd-autorun', storage: 'registry' }
}

function userEnvironmentTargets() {
  return USER_ENVIRONMENT_TARGETS.map((target) => ({ item: target.item, variable: target.variable, style: 'user-environment', storage: 'registry' }))
}

function legacyUserEnvironmentTarget() {
  return { item: USER_ENVIRONMENT_LEGACY_ITEM, style: 'user-environment-legacy', storage: 'registry' }
}

function isUserVariableItem(item) {
  return USER_ENVIRONMENT_TARGETS.some((target) => target.item === item)
}

function userVariableTargetForItem(item) {
  const found = USER_ENVIRONMENT_TARGETS.find((target) => target.item === item)
  if (found === undefined) throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  return { item: found.item, variable: found.variable, style: 'user-environment', storage: 'registry' }
}

function targetForItem(item, files) {
  if (item === AUTO_RUN_ITEM) return registryTarget()
  if (item === USER_ENVIRONMENT_LEGACY_ITEM) return legacyUserEnvironmentTarget()
  if (isUserVariableItem(item)) return userVariableTargetForItem(item)
  return files.get(item)
}

function fileTargetFor(item, files) {
  const target = files.get(item)
  if (target === undefined) throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  return target
}

function descriptorFor(target, proxy, plan) {
  const normalized = { host: proxy.host, port: proxy.port }
  const variables = normalizedEnvironmentPlan(target, plan)
  const block = blockFor(target, normalized, variables)
  const descriptor = {
    kind: 'terminal-environment',
    target: target.item,
    marker: markerFor(target.item),
    proxy: normalized
  }
  if (variables !== undefined) descriptor.variables = variables
  descriptor.blockDigest = digest(block)
  return descriptor
}

// 环境变量项的写入计划:undefined 视为全部接管;逐名只认 'set'(写我们的值)与 'skip'(别人的值,
// ⛔ 覆盖——账本只记所有权不记客户原值,覆盖了就再也还不回去)。按变量结算后,每项只携带自己的名字。
function normalizedEnvironmentPlan(target, plan) {
  if (target.style !== 'user-environment' && target.style !== 'user-environment-legacy') return undefined
  const names = target.variable !== undefined ? [target.variable] : USER_ENVIRONMENT_NAMES
  if (plan === undefined) return Object.fromEntries(names.map((name) => [name, 'set']))
  if (typeof plan !== 'object' || plan === null) throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
  for (const name of names) {
    if (plan[name] !== 'set' && plan[name] !== 'skip') throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
  }
  return Object.fromEntries(names.map((name) => [name, plan[name]]))
}

function checkedDescriptor(target, value) {
  if (value?.target !== target.item || value.marker !== markerFor(target.item) || !safeProxy(value.proxy)) {
    throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
  }
  const expected = descriptorFor(target, value.proxy, value.variables)
  if (value.blockDigest === expected.blockDigest) return expected
  // 旧账本兼容:0.5.x 写下的 AutoRun 块(rem 打头的死行)摘要照样认——移除时按账本摘要精确匹配那段旧文本。
  if (target.style === 'cmd-autorun' && value.blockDigest === digest(legacyAutoRunBlock())) {
    return { ...expected, blockDigest: value.blockDigest }
  }
  throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
}

function descriptorFromSnapshot(target, value, currentExpected) {
  if (value?.target !== target.item || value?.managed?.marker !== markerFor(target.item)) {
    throw terminalError('TERMINAL_ENVIRONMENT_RESTORE_DESCRIPTOR_INVALID')
  }
  const descriptor = checkedDescriptor(target, {
    kind: 'terminal-environment',
    target: target.item,
    marker: value.managed.marker,
    proxy: value.managed.proxy,
    ...(value.managed.variables !== undefined ? { variables: value.managed.variables } : {}),
    blockDigest: value.managed.blockDigest
  })
  if (currentExpected !== undefined && currentExpected.blockDigest !== descriptor.blockDigest &&
    !(target.style === 'cmd-autorun' && descriptor.blockDigest === digest(legacyAutoRunBlock()))) {
    throw terminalError('TERMINAL_ENVIRONMENT_RESTORE_DESCRIPTOR_INVALID')
  }
  return descriptor
}

function fileSnapshot(target, exists, inspection, expected) {
  const snapshot = {
    kind: 'terminal-file-state',
    target: target.item,
    exists,
    ownBlockPresent: inspection.present,
    ownBlockComplete: inspection.complete
  }
  if (inspection.complete) snapshot.ownBlockDigest = inspection.blockDigest
  return withManagedDescriptor(snapshot, expected)
}

function registrySnapshot(raw, expected) {
  const inspection = inspectRegistryBlock(raw.value)
  const snapshot = {
    kind: 'terminal-registry-state',
    target: AUTO_RUN_ITEM,
    exists: raw.exists,
    // 类型只用于本地恢复空字符串，不包含 AutoRun 的命令内容。
    registryType: raw.type,
    ownBlockPresent: inspection.present,
    ownBlockComplete: inspection.complete
  }
  if (inspection.complete) snapshot.ownBlockDigest = inspection.blockDigest
  return withManagedDescriptor(snapshot, expected)
}

function withManagedDescriptor(snapshot, expected) {
  if (expected !== undefined) {
    snapshot.managed = {
      marker: expected.marker,
      proxy: expected.proxy,
      blockDigest: expected.blockDigest
    }
    if (expected.variables !== undefined) snapshot.managed.variables = expected.variables
  }
  return snapshot
}

function writeFileValue(target, value, currentExpected, home) {
  if (value?.kind === 'terminal-environment') {
    const descriptor = checkedDescriptor(target, value)
    const current = readContent(target.path, home)
    const next = appendFileBlock(current.value, target.item, descriptor)
    writeContent(target.path, next, current.exists, false, home)
    return
  }
  if (value?.kind === 'terminal-file-state') {
    const descriptor = descriptorFromSnapshot(target, value, currentExpected)
    const current = readContent(target.path, home)
    const next = removeFileBlock(current.value, target.item, descriptor)
    writeContent(target.path, next, current.exists, value.exists === false, home)
    return
  }
  throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
}

function writeAutoRunValue(run, value, currentExpected) {
  const target = registryTarget()
  const raw = readAutoRun(run)
  if (value?.kind === 'terminal-environment') {
    const descriptor = checkedDescriptor(target, value)
    const next = appendAutoRunBlock(raw.value, descriptor)
    writeAutoRun(run, { exists: true, type: raw.exists ? raw.type : 'REG_SZ', value: next })
    return
  }
  if (value?.kind === 'terminal-registry-state') {
    const descriptor = descriptorFromSnapshot(target, value, currentExpected)
    const next = removeAutoRunBlock(raw.value, descriptor)
    if (next === '' && value.exists === false) {
      if (raw.exists) deleteAutoRun(run)
      return
    }
    writeAutoRun(run, { exists: true, type: raw.exists ? raw.type : value.registryType, value: next })
    return
  }
  throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
}

function writeUserEnvironmentValue(run, notify, value, currentExpected) {
  const target = legacyUserEnvironmentTarget()
  if (value?.kind === 'terminal-environment') {
    const descriptor = checkedDescriptor(target, value)
    const state = readUserEnvironment(run)
    for (const name of USER_ENVIRONMENT_NAMES) {
      if (descriptor.variables[name] !== 'set') continue
      const current = state.get(name)
      // 已是我们的值=幂等;别人写的值=⛔ 覆盖(计划里就是 skip)。只补缺失的名字。
      if (current !== undefined) continue
      run('reg.exe', ['add', USER_ENVIRONMENT_KEY, '/v', name, '/t', 'REG_SZ', '/d', expectedEnvironmentValue(name, descriptor.proxy), '/f'])
    }
    notify()
    return
  }
  if (value?.kind === 'terminal-registry-state') {
    const descriptor = descriptorFromSnapshot(target, value, currentExpected)
    const state = readUserEnvironment(run)
    for (const name of USER_ENVIRONMENT_NAMES) {
      if (descriptor.variables?.[name] !== 'set') continue
      const current = state.get(name)
      // 只删仍然原样是我们的值;被别人改掉的现值⛔ 碰。
      if (current === undefined || current.data !== expectedEnvironmentValue(name, descriptor.proxy)) continue
      run('reg.exe', ['delete', USER_ENVIRONMENT_KEY, '/v', name, '/f'])
    }
    notify()
    return
  }
  throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
}

// 按变量结算的写入/恢复:apply 只补缺失(别人写的值计划就是 skip,⛔ 覆盖);restore 只删**仍然
// 原样是我们写的值**——被客户或第三方改掉的现值一律保留,⛔ 硬改回。广播尽力而为:发不出去
// ⛔ 把已写好的注册表值翻成写入失败(那会让账本结成「可选项未写入」,值却已写进去,从此没人负责删)。
function writeUserVariableValue(run, notify, item, value, currentExpected) {
  const target = userVariableTargetForItem(item)
  const name = target.variable
  if (value?.kind === 'terminal-environment') {
    const descriptor = checkedDescriptor(target, value)
    if (descriptor.variables[name] !== 'set') {
      notify()
      return
    }
    const state = readUserEnvironment(run)
    if (!state.has(name)) {
      run('reg.exe', ['add', USER_ENVIRONMENT_KEY, '/v', name, '/t', 'REG_SZ', '/d', expectedEnvironmentValue(name, descriptor.proxy), '/f'])
    }
    notify()
    return
  }
  if (value?.kind === 'terminal-registry-state') {
    const descriptor = descriptorFromSnapshot(target, value, currentExpected)
    if (descriptor.variables?.[name] !== 'set') {
      notify()
      return
    }
    const state = readUserEnvironment(run)
    const current = state.get(name)
    if (current !== undefined && current.data === expectedEnvironmentValue(name, descriptor.proxy)) {
      run('reg.exe', ['delete', USER_ENVIRONMENT_KEY, '/v', name, '/f'])
    }
    notify()
    return
  }
  throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
}

// 连接时该变量的计划:缺失或已是我们的值(上次会话残留)→ 'set';别人写的值 → 'skip'。
function planForVariable(state, name, proxy) {
  const entry = state.get(name)
  const plan = entry === undefined || entry.data === expectedEnvironmentValue(name, proxy) ? 'set' : 'skip'
  return { [name]: plan }
}

function expectedEnvironmentValue(name, proxy) {
  const found = proxyVariables(proxy, false).find(([candidate]) => candidate === name)
  if (found === undefined) throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  return found[1]
}

function environmentValueFingerprint(data) {
  // 指纹而非原文:客户的原值(可能带代理凭据)⛔ 明文进账本;归属比对用单向摘要足够。
  return digest(`env-value:${data}`)
}

// 「我们写的环境变量还在」的判定,只看计划内(set)的名字:
// complete=每一条要么仍是我们的值、要么已缺失(外部删除容忍,恢复时把剩下的补删干净);
// 任一条被改成了别的值 → 现值归别人,complete/present 都不成立,恢复按 keptModified 保留。
// present=还有任一条是我们的值(残留诊断用)。
function judgeEnvironment(snapshot, descriptor) {
  let matched = 0
  for (const name of USER_ENVIRONMENT_NAMES) {
    if (descriptor.variables?.[name] !== 'set') continue
    const state = snapshot.variables?.[name]
    if (state === environmentValueFingerprint(expectedEnvironmentValue(name, descriptor.proxy))) {
      matched += 1
      continue
    }
    if (state !== undefined && state !== 'absent') return { present: matched > 0, complete: false }
  }
  return { present: matched > 0, complete: true }
}

function blockFor(target, proxy, plan) {
  const marker = markerFor(target.item)
  if (target.style === 'cmd-autorun') {
    // cmd 里 `rem` 把整行(连同 & 与其后的命令)当注释:块必须以真实的 call 打头才可能执行,
    // rem 只缀在我们那段的末尾。所有权标记一头藏在 call 的参数里、一头在结尾的 rem 里,
    // 两端都落在我们自己那段内——删除时整段精确切除,客户原有命令原样保留。
    // REM 行不能含 < 或 >；它们会被 cmd 当成重定向符，即使视觉上像注释。
    return `call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd" ${marker} & rem ${marker} END`
  }
  if (target.style === 'user-environment' || target.style === 'user-environment-legacy') {
    // 摘要的规范化原文:skip 的名字不承载我们的值,占位即可(它的现值⛔ 进任何快照)。
    const names = target.variable !== undefined ? [target.variable] : USER_ENVIRONMENT_NAMES
    return names
      .map((name) => `${name}=${plan?.[name] === 'skip' ? '(外部值,不接管)' : expectedEnvironmentValue(name, proxy)}`)
      .join('\n')
  }
  const vars = proxyVariables(proxy, target.style === 'sh')
  let body
  if (target.style === 'cmd-helper') {
    body = cmdEnvironmentLines(vars).join('\r\n')
  } else if (target.style === 'powershell') {
    body = powerShellEnvironmentLines(vars).join('\r\n')
  } else if (target.style === 'sh') {
    body = shellEnvironmentLines(vars).join('\n')
  } else {
    throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  }
  const lineBreak = target.style === 'sh' ? '\n' : '\r\n'
  const [begin, end] = fileMarkers(target)
  return `${begin}${lineBreak}${body}${lineBreak}${end}${lineBreak}`
}

// 0.5.5–0.5.x 写入的 AutoRun 块形态(rem 打头 → cmd 把整行当注释,call 从不执行)。
// 仅为识别与替换旧块、校验旧账本而保留;⛔ 再生成这种形态。
function legacyAutoRunBlock() {
  const marker = markerFor(AUTO_RUN_ITEM)
  return `rem ${marker} BEGIN & call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd" & rem ${marker} END`
}

function proxyVariables(proxy, includeLowercase) {
  const http = `http://${proxy.host}:${String(proxy.port)}`
  const socks = `socks5://${proxy.host}:${String(proxy.port)}`
  const bypass = 'localhost,127.0.0.1,::1'
  const upper = [['HTTP_PROXY', http], ['HTTPS_PROXY', http], ['ALL_PROXY', socks], ['NO_PROXY', bypass]]
  return includeLowercase ? [...upper, ['http_proxy', http], ['https_proxy', http], ['all_proxy', socks], ['no_proxy', bypass]] : upper
}

// NO_PROXY 是客户原有直连例外；只把必要回环例外前置，不丢弃已有条目。
function shellEnvironmentLines(vars) {
  return vars.map(([name, value]) => name.toLowerCase() === 'no_proxy'
    ? `export ${name}='${value}'\${${name}:+,$${name}}`
    : `export ${name}='${value}'`)
}

function powerShellEnvironmentLines(vars) {
  return vars
    .filter(([name]) => name === name.toUpperCase())
    .map(([name, value]) => name === 'NO_PROXY'
      ? `$env:NO_PROXY = if ([string]::IsNullOrWhiteSpace($env:NO_PROXY)) { '${value}' } else { '${value},' + $env:NO_PROXY }`
      : `$env:${name} = '${value}'`)
}

function cmdEnvironmentLines(vars) {
  return vars
    .filter(([name]) => name === name.toUpperCase())
    .map(([name, value]) => name === 'NO_PROXY'
      ? `@if defined NO_PROXY (set "NO_PROXY=${value},%NO_PROXY%") else (set "NO_PROXY=${value}")`
      : `@set "${name}=${value}"`)
}

function markerFor(item) {
  return `${MARKER_PREFIX}:${item}`
}

function inspectFileBlock(content, item) {
  const [begin, end] = fileMarkers(fileStyle(item))
  return inspectDelimitedBlock(content, begin, end)
}

// AutoRun 段定位:现行形态的段以「call … <标记>」打头;0.5.x 遗留形态以「rem <标记> BEGIN」打头;
// 两种形态的结尾都是「rem <标记> END」。段必须唯一(打头合计恰好一次),否则视为不完整、⛔ 硬碰。
function inspectRegistryBlock(value) {
  const marker = markerFor(AUTO_RUN_ITEM)
  const begins = [`call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd" ${marker}`, `rem ${marker} BEGIN`]
  const end = `rem ${marker} END`
  let beginCount = 0
  let beginHit
  for (const token of begins) {
    let offset = 0
    for (;;) {
      const index = value.indexOf(token, offset)
      if (index < 0) break
      beginCount += 1
      if (beginHit === undefined || index < beginHit.index) beginHit = { token, index }
      offset = index + token.length
    }
  }
  const endCount = countOccurrences(value, end)
  if (beginCount === 0 && endCount === 0) return { present: false, complete: false }
  if (beginCount !== 1 || endCount !== 1 || beginHit === undefined) return { present: true, complete: false }
  const endAt = value.indexOf(end, beginHit.index + beginHit.token.length)
  if (endAt < 0) return { present: true, complete: false }
  const finish = endAt + end.length
  const block = value.slice(beginHit.index, finish)
  return { present: true, complete: true, blockDigest: digest(block), start: beginHit.index, finish }
}

function fileMarkers(target) {
  const marker = markerFor(target.item)
  // :: 是 cmd 的伪标签，在某些上下文会有额外解析规则；用无重定向符的 REM 更稳定。
  if (target.style === 'cmd-helper') return [`rem ${marker} BEGIN`, `rem ${marker} END`]
  return [`# >>> ${marker} >>>`, `# <<< ${marker} <<<`]
}

function inspectDelimitedBlock(content, begin, end, includeFollowingLineBreak = true) {
  const start = content.indexOf(begin)
  const endAt = start < 0 ? -1 : content.indexOf(end, start + begin.length)
  const beginCount = countOccurrences(content, begin)
  const endCount = countOccurrences(content, end)
  if (start < 0 && endAt < 0 && beginCount === 0 && endCount === 0) return { present: false, complete: false }
  if (start < 0 || endAt < 0 || beginCount !== 1 || endCount !== 1) return { present: true, complete: false }
  let finish = endAt + end.length
  if (includeFollowingLineBreak) {
    if (content.slice(finish, finish + 2) === '\r\n') finish += 2
    else if (content.slice(finish, finish + 1) === '\n') finish += 1
  }
  const block = content.slice(start, finish)
  return { present: true, complete: true, blockDigest: digest(block), start, finish }
}

function appendFileBlock(content, item, descriptor) {
  const inspection = inspectFileBlock(content, item)
  if (inspection.present) {
    if (inspection.complete && inspection.blockDigest === descriptor.blockDigest) return content
    throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
  }
  const block = blockFor(fileStyle(item), descriptor.proxy)
  return content === '' ? block : `${content}${content.endsWith('\n') ? '' : '\n'}${block}`
}

function removeFileBlock(content, item, descriptor) {
  const inspection = inspectFileBlock(content, item)
  if (!inspection.present) return content
  if (!inspection.complete || inspection.blockDigest !== descriptor.blockDigest) throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
  return content.slice(0, inspection.start) + content.slice(inspection.finish)
}

function appendAutoRunBlock(value, descriptor) {
  const inspection = inspectRegistryBlock(value)
  let base = value
  if (inspection.present) {
    if (inspection.complete && inspection.blockDigest === descriptor.blockDigest) return value
    // 0.5.x 的遗留坏块(rem 打头,call 从不执行)所有权标记认得:移除后换成能执行的形态。
    if (inspection.complete && inspection.blockDigest === digest(legacyAutoRunBlock())) {
      base = cutDelimitedSegment(value, inspection)
    } else {
      throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
    }
  }
  const block = blockFor(registryTarget(), descriptor.proxy)
  return base === '' ? block : `${base} & ${block}`
}

function removeAutoRunBlock(value, descriptor) {
  const inspection = inspectRegistryBlock(value)
  if (!inspection.present) return value
  if (!inspection.complete || inspection.blockDigest !== descriptor.blockDigest) throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
  return cutDelimitedSegment(value, inspection)
}

function cutDelimitedSegment(value, inspection) {
  const before = value.slice(0, inspection.start)
  const after = value.slice(inspection.finish)
  if (before.endsWith(' & ')) return before.slice(0, -3) + after
  if (after.startsWith(' & ')) return before + after.slice(3)
  return before + after
}

// 用户级环境变量的读法与 AutoRun 同一判别:先查键,键不在再用必然存在的父键证明「注册表可读、
// 只是没配」,⛔ 把没配置当成读不了而拦住连接。
function readUserEnvironment(run) {
  let output
  try {
    output = run('reg.exe', ['query', USER_ENVIRONMENT_KEY])
  } catch (error) {
    // N-23:命令超时原样放行(独立受控码),⛔ 掉进「查父键判存在」把超时翻成「注册表不可读」。
    if (error?.code === 'TERMINAL_ENVIRONMENT_COMMAND_TIMEOUT') throw error
    if (REGISTRY_DENIED.test(registryErrorText(error))) throw terminalError('TERMINAL_ENVIRONMENT_REGISTRY_READ_FAILED')
    try {
      run('reg.exe', ['query', USER_ENVIRONMENT_PARENT_KEY])
      return new Map()
    } catch {
      throw terminalError('TERMINAL_ENVIRONMENT_REGISTRY_READ_FAILED')
    }
  }
  const values = new Map()
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*([^\s]+)\s+(REG_[A-Z0-9_]+)\s+(.*)$/)
    if (match === null || !USER_ENVIRONMENT_NAMES.includes(match[1])) continue
    values.set(match[1], { type: match[2], data: match[3].replace(/\r$/, '') })
  }
  return values
}

function fileStyle(item) {
  const target = FILE_TARGETS.find((candidate) => candidate.item === item)
  if (target === undefined) throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  return target
}

function readContent(path, home) {
  try {
    assertSafeParent(path, home)
    const leaf = leafState(path)
    if (!leaf.exists) return { exists: false, value: '' }
    return { exists: true, value: readFileSync(path, 'utf8') }
  } catch (error) {
    if (error?.code === 'TERMINAL_ENVIRONMENT_PROFILE_UNSAFE') throw error
    throw terminalError('TERMINAL_ENVIRONMENT_READ_FAILED')
  }
}

function writeContent(path, value, existedBefore, removeWhenEmpty, home) {
  try {
    assertSafeParent(path, home)
    const leaf = leafState(path)
    if (removeWhenEmpty && value === '') {
      if (leaf.exists) unlinkSync(path)
      return
    }
    const current = leaf.exists ? readFileSync(path, 'utf8') : undefined
    if (current === value) return
    ensureSafeParent(path, home)
    const mode = existedBefore && leaf.exists ? leaf.mode : 0o600
    const temporary = `${path}.laixin-terminal-${process.pid}-${Date.now()}.tmp`
    try {
      writeFileSync(temporary, value, { encoding: 'utf8', mode })
      renameSync(temporary, path)
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
      throw error
    }
  } catch (error) {
    if (error?.code === 'TERMINAL_ENVIRONMENT_PROFILE_UNSAFE') throw error
    throw terminalError('TERMINAL_ENVIRONMENT_WRITE_FAILED')
  }
}

// 只允许在 HOME 内普通目录层级下写 hook。叶子文件之外的符号链接同样不能跟随。
function assertSafeParent(path, home) {
  const parent = dirname(path)
  const parts = relativeParts(home, parent)
  let current = home
  for (const part of parts) {
    current = join(current, part)
    try {
      const state = lstatSync(current)
      if (state.isSymbolicLink() || !state.isDirectory()) throw terminalError('TERMINAL_ENVIRONMENT_PROFILE_UNSAFE')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

function ensureSafeParent(path, home) {
  const parent = dirname(path)
  const parts = relativeParts(home, parent)
  let current = home
  for (const part of parts) {
    current = join(current, part)
    let state
    try {
      state = lstatSync(current)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      try { mkdirSync(current, { mode: 0o700 }) } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError
      }
      state = lstatSync(current)
    }
    if (state.isSymbolicLink() || !state.isDirectory()) throw terminalError('TERMINAL_ENVIRONMENT_PROFILE_UNSAFE')
  }
}

function relativeParts(home, target) {
  const path = relative(home, target)
  if (path === '') return []
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw terminalError('TERMINAL_ENVIRONMENT_PROFILE_UNSAFE')
  }
  return path.split(sep).filter(Boolean)
}

function leafState(path) {
  try {
    const state = lstatSync(path)
    if (state.isSymbolicLink() || !state.isFile()) throw terminalError('TERMINAL_ENVIRONMENT_PROFILE_UNSAFE')
    return { exists: true, mode: state.mode & 0o777 }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, mode: 0o600 }
    throw error
  }
}

function readAutoRun(run) {
  let output
  try {
    output = run('reg.exe', ['query', COMMAND_PROCESSOR_KEY, '/v', 'AutoRun'])
  } catch {
    // /v 不存在时，先确认键本身仍可读。键也不在（新装 Windows 的 Command Processor 是可选键）不等于注册表不可读：
    // 再查一定存在的父键——父键可读且不是权限拒绝，才按「确认不存在」当空值；其余（拒绝访问、reg.exe 起不来、超时）照旧拒绝。
    try {
      run('reg.exe', ['query', COMMAND_PROCESSOR_KEY])
      return { exists: false, type: 'REG_SZ', value: '' }
    } catch (error) {
      if (REGISTRY_DENIED.test(registryErrorText(error))) throw terminalError('TERMINAL_ENVIRONMENT_REGISTRY_READ_FAILED')
      try {
        run('reg.exe', ['query', COMMAND_PROCESSOR_PARENT_KEY])
        return { exists: false, type: 'REG_SZ', value: '' }
      } catch {
        throw terminalError('TERMINAL_ENVIRONMENT_REGISTRY_READ_FAILED')
      }
    }
  }
  // 键可读但输出无法解释也不是“空值”，不能冒险覆盖客户 AutoRun。
  return parseAutoRun(output)
}

function registryErrorText(error) {
  return [error?.stderr, error?.stdout, error?.message].filter((part) => typeof part === 'string' || part instanceof Uint8Array).map(String).join('\n')
}

function parseAutoRun(output) {
  const match = String(output).match(/^[ \t]*AutoRun[ \t]+(REG_(?:SZ|EXPAND_SZ))(?:[ \t]+(.*))?$/im)
  if (match === null) throw terminalError('TERMINAL_ENVIRONMENT_REGISTRY_READ_FAILED')
  return { exists: true, type: match[1], value: (match[2] ?? '').replace(/\r$/, '') }
}

function writeAutoRun(run, value) {
  const type = value.type === 'REG_EXPAND_SZ' ? 'REG_EXPAND_SZ' : 'REG_SZ'
  try {
    run('reg.exe', ['add', COMMAND_PROCESSOR_KEY, '/v', 'AutoRun', '/t', type, '/d', value.value, '/f'])
  } catch {
    throw terminalError('TERMINAL_ENVIRONMENT_REGISTRY_WRITE_FAILED')
  }
}

function deleteAutoRun(run) {
  try {
    run('reg.exe', ['delete', COMMAND_PROCESSOR_KEY, '/v', 'AutoRun', '/f'])
  } catch {
    throw terminalError('TERMINAL_ENVIRONMENT_REGISTRY_WRITE_FAILED')
  }
}

/**
 * 进程内直接调 user32!SendMessageTimeoutW 广播环境变更(毫秒级、无子进程),Explorer 收到后才把
 * 新环境块交给新开的终端。随包的 koffi 不在或加载失败返回 undefined,调用方回落 PowerShell。
 * ⛔ 在这里抛:原生通道只是更快的一条路,不是唯一的路。
 */
export function loadEnvironmentNotifier(requireImpl = createRequire(import.meta.url)) {
  try {
    const koffi = requireImpl('koffi')
    const user32 = koffi.load('user32.dll')
    const sendMessageTimeout = user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t window, uint32 message, uintptr_t wParam, const wchar_t *lParam, uint32 flags, uint32 timeout, void *result)')
    return () => {
      const sent = sendMessageTimeout(NOTIFY_HWND_BROADCAST, NOTIFY_WM_SETTINGCHANGE, 0, 'Environment', NOTIFY_SMTO_ABORTIFHUNG, NOTIFY_TIMEOUT_MS, null)
      if (sent === 0) throw new Error('SendMessageTimeoutW failed')
    }
  } catch { return undefined }
}

let nativeEnvironmentNotifier

function defaultEnvironmentNotify() {
  // 原生通道进程内缓存;失灵一次本轮回落 PowerShell,下轮再试原生。
  if (nativeEnvironmentNotifier === undefined) nativeEnvironmentNotifier = loadEnvironmentNotifier() ?? null
  if (nativeEnvironmentNotifier !== null) {
    try { nativeEnvironmentNotifier(); return } catch { /* 回落 PowerShell */ }
  }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      input: ENVIRONMENT_NOTIFY_SCRIPT, encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch {
    throw terminalError('TERMINAL_ENVIRONMENT_NOTIFY_FAILED')
  }
}

// N-23 合批:一个同步写入批次(一次 apply/restore 的全部变量)只在批次末广播一次。
// 基线每个变量各广播一次,而广播回落通道是 PowerShell(慢机被杀软拖到 15s 超时×2 次重试,
// 真机实测每写 30-40s)——四个变量一轮就是两分多钟,把整轮恢复拖进「修复必然超时」。
// WM_SETTINGCHANGE 本来就不带值,Explorer 收到时整块重读:批末一次广播覆盖批内全部写入。
// 状态**按适配器实例**记:同进程的另一个实例(换实例恢复等)各有各的欠发位,⛔ 互相吞对方的广播。

// 默认同步休眠:Atomics.wait 阻塞当前线程,适配器操作是同步的,⛔ 用异步 setTimeout。
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function defaultRun(command, args) {
  // stdio 显式给:execFileSync 默认转发子进程 stderr,会被计划任务 2>&1 收进守护日志成为噪声
  // (与 adapter-wininet 同一处理,2026-09-15)。
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    // N-23:命令超时(killed + SIGTERM)给独立受控码,⛔ 与「注册表被拒/不可读」混同一归因——
    // 慢机上「5 秒没跑完」和「权限拒绝」的对策完全不同,账本备注与日志要分得开。
    if (error?.killed === true && error?.signal === 'SIGTERM') throw terminalError('TERMINAL_ENVIRONMENT_COMMAND_TIMEOUT')
    throw error
  }
}

function countOccurrences(value, needle) {
  let count = 0
  let offset = 0
  while (true) {
    const index = value.indexOf(needle, offset)
    if (index < 0) return count
    count += 1
    offset = index + needle.length
  }
}

function digest(value) {
  return createHash('sha256').update(value.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

function terminalError(code) {
  return Object.assign(new Error(code), { code })
}

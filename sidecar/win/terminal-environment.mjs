// Windows 终端环境适配器：只写受管 profile、Git Bash hook 与 cmd AutoRun。
// read() 只返回所有权快照，绝不把 PowerShell profile 或 AutoRun 原文放进恢复账本。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
        (files.has(ref.item) || ref.item === AUTO_RUN_ITEM)
    },
    // 在连通前先确认所有 profile 和 cmd AutoRun 都可安全读写，避免已改系统代理后才失败。
    preflight(proxy) {
      if (!enabled) return
      for (const managed of this.managedItems(proxy)) this.read(managed.ref)
    },
    managedItems(proxy) {
      if (!enabled) return []
      if (!safeProxy(proxy)) throw terminalError('TERMINAL_ENVIRONMENT_PROXY_INVALID')
      const targets = [...FILE_TARGETS, registryTarget()]
      return targets.map((target) => {
        const value = descriptorFor(target, proxy)
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
      const target = fileTargetFor(ref.item, files)
      const content = readContent(target.path, home)
      return fileSnapshot(target, content.exists, inspectFileBlock(content.value, target.item), expected)
    },
    write(ref, value) {
      if (!enabled) return disabled()
      if (ref?.service !== TERMINAL_ENVIRONMENT_SERVICE || typeof ref.item !== 'string') {
        throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
      }
      if (ref.item === AUTO_RUN_ITEM) {
        writeAutoRunValue(run, value, expectedByItem.get(ref.item))
        return
      }
      const target = fileTargetFor(ref.item, files)
      writeFileValue(target, value, expectedByItem.get(ref.item), home)
    },
    valuesEqual(current, written) {
      if (written?.kind !== 'terminal-environment') return false
      const target = targetForItem(written.target, files)
      if (target === undefined) return false
      let descriptor
      try { descriptor = checkedDescriptor(target, written) } catch { return false }
      const expectedKind = target.storage === 'registry' ? 'terminal-registry-state' : 'terminal-file-state'
      return current?.kind === expectedKind && current.target === target.item &&
        current.ownBlockPresent === true && current.ownBlockComplete === true &&
        current.ownBlockDigest === descriptor.blockDigest
    },
    restoredValueMatches(current, originalValue, writtenValue) {
      if (writtenValue?.kind !== 'terminal-environment') return false
      const target = targetForItem(originalValue?.target, files)
      if (target === undefined) return false
      const expectedKind = target.storage === 'registry' ? 'terminal-registry-state' : 'terminal-file-state'
      return current?.kind === expectedKind && current.target === target.item && current.ownBlockPresent === false
    }
  }
}

function registryTarget() {
  return { item: AUTO_RUN_ITEM, style: 'cmd-autorun', storage: 'registry' }
}

function targetForItem(item, files) {
  if (item === AUTO_RUN_ITEM) return registryTarget()
  return files.get(item)
}

function fileTargetFor(item, files) {
  const target = files.get(item)
  if (target === undefined) throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  return target
}

function descriptorFor(target, proxy) {
  const normalized = { host: proxy.host, port: proxy.port }
  const block = blockFor(target, normalized)
  return {
    kind: 'terminal-environment',
    target: target.item,
    marker: markerFor(target.item),
    proxy: normalized,
    blockDigest: digest(block)
  }
}

function checkedDescriptor(target, value) {
  if (value?.target !== target.item || value.marker !== markerFor(target.item) || !safeProxy(value.proxy)) {
    throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
  }
  const expected = descriptorFor(target, value.proxy)
  if (value.blockDigest !== expected.blockDigest) throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
  return expected
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
    blockDigest: value.managed.blockDigest
  })
  if (currentExpected !== undefined && currentExpected.blockDigest !== descriptor.blockDigest) {
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
  const inspection = inspectRegistryBlock(raw.value, AUTO_RUN_ITEM)
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

function blockFor(target, proxy) {
  const marker = markerFor(target.item)
  if (target.style === 'cmd-autorun') {
    // REM 行不能含 < 或 >；它们会被 cmd 当成重定向符，即使视觉上像注释。
    return `rem ${marker} BEGIN & call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd" & rem ${marker} END`
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

function inspectRegistryBlock(value, item) {
  return inspectDelimitedBlock(value, `rem ${markerFor(item)} BEGIN`, `rem ${markerFor(item)} END`, false)
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
  const inspection = inspectRegistryBlock(value, AUTO_RUN_ITEM)
  if (inspection.present) {
    if (inspection.complete && inspection.blockDigest === descriptor.blockDigest) return value
    throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
  }
  const block = blockFor(registryTarget(), descriptor.proxy)
  return value === '' ? block : `${value} & ${block}`
}

function removeAutoRunBlock(value, descriptor) {
  const inspection = inspectRegistryBlock(value, AUTO_RUN_ITEM)
  if (!inspection.present) return value
  if (!inspection.complete || inspection.blockDigest !== descriptor.blockDigest) throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
  const before = value.slice(0, inspection.start)
  const after = value.slice(inspection.finish)
  if (before.endsWith(' & ')) return before.slice(0, -3) + after
  if (after.startsWith(' & ')) return before + after.slice(3)
  return before + after
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

function defaultRun(command, args) {
  // stdio 显式给:execFileSync 默认转发子进程 stderr,会被计划任务 2>&1 收进守护日志成为噪声
  // (与 adapter-wininet 同一处理,2026-09-15)。
  return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
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

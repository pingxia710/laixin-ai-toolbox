// 终端环境适配器：只写受管 hook，不改 launchctl 或全局环境。
// 它的 read() 永远只返回所有权快照，绝不把 shell profile 原文放进恢复账本。
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export const TERMINAL_ENVIRONMENT_SERVICE = 'TerminalEnvironment'
const MARKER_PREFIX = 'LAIXIN_AI_TOOLBOX_TERMINAL_V1'
const ENVIRONMENT_GATE = 'TOOLBOX_REAL_TERMINAL_ENVIRONMENT'

const TARGETS = Object.freeze([
  { item: 'mac-sh-helper', relative: ['.laixin-ai-toolbox', 'terminal-proxy.sh'], style: 'sh-helper' },
  { item: 'mac-fish-helper', relative: ['.laixin-ai-toolbox', 'terminal-proxy.fish'], style: 'fish-helper' },
  { item: 'mac-zshenv', relative: ['.zshenv'], style: 'sh-hook' },
  { item: 'mac-bashrc', relative: ['.bashrc'], style: 'sh-hook' },
  { item: 'mac-bash-profile', relative: ['.bash_profile'], style: 'sh-hook' },
  { item: 'mac-profile', relative: ['.profile'], style: 'sh-hook' },
  { item: 'mac-fish-conf', relative: ['.config', 'fish', 'conf.d', 'laixin-ai-toolbox.fish'], style: 'fish-hook' }
])

// 仅允许守护的本地回环桥；不要把任意远端地址写进客户 shell profile。
function safeProxy(value) {
  return value !== null && typeof value === 'object' && value.host === '127.0.0.1' &&
    Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
}

export function createTerminalEnvironmentAdapter(options = {}) {
  const env = options.env ?? process.env
  const enabled = options.enabled === undefined ? env?.[ENVIRONMENT_GATE] === '1' : options.enabled === true
  const home = options.home ?? homedir()
  if (!isAbsolute(home)) throw terminalError('TERMINAL_ENVIRONMENT_HOME_INVALID')
  const targets = new Map(TARGETS.map((target) => [target.item, { ...target, path: join(home, ...target.relative) }]))
  const expectedByItem = new Map()

  const disabled = () => {
    throw terminalError('TERMINAL_ENVIRONMENT_DISABLED')
  }

  return {
    service: TERMINAL_ENVIRONMENT_SERVICE,
    enabled,
    owns(ref) {
      return ref?.service === TERMINAL_ENVIRONMENT_SERVICE && typeof ref.item === 'string' && targets.has(ref.item)
    },
    // 在连通前先确认所有 profile 都可安全读写，避免已改系统代理后才发现终端配置不能接入。
    preflight(proxy) {
      if (!enabled) return
      for (const managed of this.managedItems(proxy)) this.read(managed.ref)
    },
    managedItems(proxy) {
      if (!enabled) return []
      if (!safeProxy(proxy)) throw terminalError('TERMINAL_ENVIRONMENT_PROXY_INVALID')
      return TARGETS.map((target) => {
        const value = descriptorFor(target, proxy)
        expectedByItem.set(target.item, value)
        return { ref: { service: TERMINAL_ENVIRONMENT_SERVICE, item: target.item }, value }
      })
    },
    read(ref) {
      if (!enabled) return disabled()
      const target = targetFor(ref, targets)
      const content = readContent(target.path, home)
      const inspection = inspectOwnedBlock(content.value, target.item)
      const expected = expectedByItem.get(target.item)
      return snapshotFor(target, content.exists, inspection, expected)
    },
    write(ref, value) {
      if (!enabled) return disabled()
      const target = targetFor(ref, targets)
      if (value?.kind === 'terminal-environment') {
        const descriptor = checkedDescriptor(target, value)
        const current = readContent(target.path, home)
        const next = appendOwnedBlock(current.value, target.item, descriptor)
        writeContent(target.path, next, current.exists, false, home)
        return
      }
      if (value?.kind === 'terminal-file-state') {
        const descriptor = descriptorFromSnapshot(target, value, expectedByItem.get(target.item))
        const current = readContent(target.path, home)
        const next = removeOwnedBlock(current.value, target.item, descriptor)
        writeContent(target.path, next, current.exists, value.exists === false, home)
        return
      }
      throw terminalError('TERMINAL_ENVIRONMENT_VALUE_INVALID')
    },
    valuesEqual(current, written) {
      if (written?.kind !== 'terminal-environment') return false
      const target = targets.get(written.target)
      if (target === undefined) return false
      let descriptor
      try { descriptor = checkedDescriptor(target, written) } catch { return false }
      return current?.kind === 'terminal-file-state' && current.target === target.item &&
        current.ownBlockPresent === true && current.ownBlockComplete === true &&
        current.ownBlockDigest === descriptor.blockDigest
    },
    restoredValueMatches(current, originalValue, writtenValue) {
      if (writtenValue?.kind !== 'terminal-environment' || originalValue?.kind !== 'terminal-file-state') return false
      return current?.kind === 'terminal-file-state' && current.target === originalValue.target && current.ownBlockPresent === false
    }
  }
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
  const candidate = {
    kind: 'terminal-environment',
    target: target.item,
    marker: value.managed.marker,
    proxy: value.managed.proxy,
    blockDigest: value.managed.blockDigest
  }
  // 账本恢复应独立于本次进程内缓存；缓存只用于实时写入的同一语义核对。
  const descriptor = checkedDescriptor(target, candidate)
  if (currentExpected !== undefined && currentExpected.blockDigest !== descriptor.blockDigest) {
    // 正在连接另一条本地桥时，绝不利用旧账本删除不相同的 hook。
    throw terminalError('TERMINAL_ENVIRONMENT_RESTORE_DESCRIPTOR_INVALID')
  }
  return descriptor
}

function snapshotFor(target, exists, inspection, expected) {
  const snapshot = {
    kind: 'terminal-file-state',
    target: target.item,
    exists,
    ownBlockPresent: inspection.present,
    ownBlockComplete: inspection.complete
  }
  if (inspection.complete) snapshot.ownBlockDigest = inspection.blockDigest
  if (expected !== undefined) {
    snapshot.managed = {
      marker: expected.marker,
      proxy: expected.proxy,
      blockDigest: expected.blockDigest
    }
  }
  return snapshot
}

function targetFor(ref, targets) {
  if (ref?.service !== TERMINAL_ENVIRONMENT_SERVICE || typeof ref.item !== 'string') {
    throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  }
  const target = targets.get(ref.item)
  if (target === undefined) throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  return target
}

function blockFor(target, proxy) {
  const vars = proxyVariables(proxy)
  let body
  if (target.style === 'sh-helper') {
    body = [
      ...vars.map(([name, value]) => `export ${name}='${value}'`),
      'export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"',
      'export no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1,::1"'
    ].join('\n')
  } else if (target.style === 'fish-helper') {
    body = [
      ...vars.map(([name, value]) => `set -gx ${name} '${value}'`),
      'set -gx NO_PROXY (string join , $NO_PROXY localhost 127.0.0.1 ::1)',
      'set -gx no_proxy (string join , $no_proxy localhost 127.0.0.1 ::1)'
    ].join('\n')
  } else if (target.style === 'sh-hook') {
    body = 'if [ -f "$HOME/.laixin-ai-toolbox/terminal-proxy.sh" ]; then\n  . "$HOME/.laixin-ai-toolbox/terminal-proxy.sh"\nfi'
  } else if (target.style === 'fish-hook') {
    body = 'if test -f "$HOME/.laixin-ai-toolbox/terminal-proxy.fish"\n  source "$HOME/.laixin-ai-toolbox/terminal-proxy.fish"\nend'
  } else {
    throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  }
  return `# >>> ${markerFor(target.item)} >>>\n${body}\n# <<< ${markerFor(target.item)} <<<\n`
}

function proxyVariables(proxy) {
  const http = `http://${proxy.host}:${String(proxy.port)}`
  const socks = `socks5://${proxy.host}:${String(proxy.port)}`
  return [
    ['HTTP_PROXY', http], ['HTTPS_PROXY', http], ['ALL_PROXY', socks],
    ['http_proxy', http], ['https_proxy', http], ['all_proxy', socks]
  ]
}

function markerFor(item) {
  return `${MARKER_PREFIX}:${item}`
}

function inspectOwnedBlock(content, item) {
  const begin = `# >>> ${markerFor(item)} >>>`
  const end = `# <<< ${markerFor(item)} <<<`
  const start = content.indexOf(begin)
  const endAt = start < 0 ? -1 : content.indexOf(end, start + begin.length)
  const beginCount = countOccurrences(content, begin)
  const endCount = countOccurrences(content, end)
  if (start < 0 && endAt < 0 && beginCount === 0 && endCount === 0) {
    return { present: false, complete: false }
  }
  if (start < 0 || endAt < 0 || beginCount !== 1 || endCount !== 1) {
    return { present: true, complete: false }
  }
  let finish = endAt + end.length
  if (content.slice(finish, finish + 2) === '\r\n') finish += 2
  else if (content.slice(finish, finish + 1) === '\n') finish += 1
  const block = content.slice(start, finish)
  return { present: true, complete: true, blockDigest: digest(block), start, finish }
}

function appendOwnedBlock(content, item, descriptor) {
  const inspection = inspectOwnedBlock(content, item)
  if (inspection.present) {
    if (inspection.complete && inspection.blockDigest === descriptor.blockDigest) return content
    throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
  }
  const block = blockFor({ item, style: targetStyle(item) }, descriptor.proxy)
  return content === '' ? block : `${content}${content.endsWith('\n') ? '' : '\n'}${block}`
}

function removeOwnedBlock(content, item, descriptor) {
  const inspection = inspectOwnedBlock(content, item)
  if (!inspection.present) return content
  if (!inspection.complete || inspection.blockDigest !== descriptor.blockDigest) {
    throw terminalError('TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT')
  }
  return content.slice(0, inspection.start) + content.slice(inspection.finish)
}

function targetStyle(item) {
  const target = TARGETS.find((candidate) => candidate.item === item)
  if (target === undefined) throw terminalError('TERMINAL_ENVIRONMENT_ITEM_INVALID')
  return target.style
}

function readContent(path, home) {
  try {
    assertSafeParent(path, home)
    let stat
    try { stat = lstatSync(path) } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, value: '' }
      throw error
    }
    // Dotfile managers often use links. Replacing one would silently detach
    // customer-owned configuration, so a linked or non-regular profile is a
    // controlled failure rather than something we follow.
    if (!stat.isFile() || stat.isSymbolicLink()) throw terminalError('TERMINAL_ENVIRONMENT_PROFILE_UNSAFE')
    return { exists: true, value: readFileSync(path, 'utf8') }
  } catch (error) {
    if (error?.code === 'TERMINAL_ENVIRONMENT_PROFILE_UNSAFE') throw error
    throw terminalError('TERMINAL_ENVIRONMENT_READ_FAILED')
  }
}

function writeContent(path, value, existedBefore, removeWhenEmpty, home) {
  try {
    const currentState = readContent(path, home)
    if (removeWhenEmpty && value === '') {
      if (currentState.exists) unlinkSync(path)
      return
    }
    if (currentState.value === value) return
    ensureSafeParent(path, home)
    const mode = existedBefore && currentState.exists ? lstatSync(path).mode & 0o777 : 0o600
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

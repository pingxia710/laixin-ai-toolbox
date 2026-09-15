const managedCodexBegin = '# >>> Laixin AI Toolbox managed model connection >>>'
const managedCodexEnd = '# <<< Laixin AI Toolbox managed model connection <<<'

export const codexConnectionTopLevelKeys = [
  'model', 'model_provider', 'preferred_auth_method', 'forced_login_method', 'model_reasoning_effort', 'model_catalog_json'
] as const

export interface CodexToolboxConnection {
  readonly provider: string
}

export interface CodexTomlDocument {
  readonly toolboxConnection: CodexToolboxConnection | undefined
  /** Replaces a Toolbox connection without relying on marker comments. */
  replaceToolboxConnection(block: string): string
  /** Removes only a semantic Toolbox connection; unrelated configuration remains intact. */
  removeToolboxConnection(): string
}

interface Assignment {
  readonly line: number
  readonly path: readonly string[]
  readonly table: number | undefined
  readonly value: string
}

interface Table {
  readonly id: number
  readonly line: number
  readonly path: readonly string[]
  readonly array: boolean
}

interface ParsedDocument {
  readonly contents: string
  readonly lines: readonly string[]
  readonly assignments: readonly Assignment[]
  readonly tables: readonly Table[]
  readonly managedMarker: readonly [number, number] | undefined
}

/**
 * A deliberately conservative TOML document editor for the part of Codex configuration that
 * Toolbox owns. It rejects constructs it cannot safely keep intact, validates duplicate keys and
 * tables before a caller writes anything, and recognises a Toolbox connection by its semantic
 * provider table when a third-party tool has stripped comments.
 */
export function parseCodexTomlDocument(contents: string): CodexTomlDocument {
  const parsed = parse(contents)
  const toolboxConnection = connectionOf(parsed)
  return {
    toolboxConnection,
    replaceToolboxConnection(block) {
      const replacement = parse(block)
      if (connectionOf(replacement) === undefined) throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
      if (parsed.managedMarker !== undefined && !markerOwnsConnection(parsed, toolboxConnection)) {
        throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
      }
      const withoutExisting = removeToolboxConnection(parsed, toolboxConnection)
      const base = parse(withoutExisting)
      const withoutControlledRoot = removeRootConnectionKeys(base)
      const candidate = joinWithManagedBlock(withoutControlledRoot, block)
      parse(candidate)
      return candidate
    },
    removeToolboxConnection() {
      return removeToolboxConnection(parsed, toolboxConnection)
    }
  }
}

/** Stable semantic source for a fingerprint; marker comments and formatting do not affect it. */
export function codexToolboxSection(contents: string): string | undefined {
  const document = parse(contents)
  const connection = connectionOf(document)
  // A marker that still surrounds the Toolbox block is enough to recognise a changed managed
  // connection as externally modified. It is deliberately not enough for editing/removal, where
  // we still require the full semantic connection proof below.
  if (connection === undefined) return markedCodexSection(document)
  const providerTable = document.tables.find((table) => table.path.length === 2 && table.path[0] === 'model_providers' && table.path[1] === connection.provider)
  if (providerTable === undefined) return undefined
  const root = document.assignments
    .filter((assignment) => assignment.table === undefined && assignment.path.length === 1 && codexConnectionTopLevelKeys.includes(assignment.path[0] as typeof codexConnectionTopLevelKeys[number]))
    .map((assignment) => [assignment.path[0], assignment.value] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  const provider = document.assignments
    .filter((assignment) => assignment.table === providerTable.id)
    .map((assignment) => [assignment.path.join('.'), assignment.value] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify({ root, provider })
}

function markedCodexSection(document: ParsedDocument): string | undefined {
  if (document.managedMarker === undefined) return undefined
  const [start, end] = document.managedMarker
  const assignments = document.assignments
    .filter((assignment) => assignment.line > start && assignment.line < end)
    .map((assignment) => [assignment.table ?? '$root', assignment.path.join('.'), assignment.value] as const)
    .sort(([leftTable, leftPath], [rightTable, rightPath]) => leftTable === rightTable ? leftPath.localeCompare(rightPath) : String(leftTable).localeCompare(String(rightTable)))
  const tables = document.tables
    .filter((table) => table.line > start && table.line < end)
    .map((table) => [table.id, table.path.join('.'), table.array] as const)
    .sort(([left], [right]) => left - right)
  return JSON.stringify({ marker: true, assignments, tables })
}

/**
 * Restores a valid pre-connection snapshot while the current file still has a Toolbox connection.
 * After deactivation, recovery is allowed only for the exact form that deactivation produces: a
 * new root connection could be another customer's third-party route and must never be overwritten.
 */
export function restoreCodexTomlConnection(current: string | undefined, original: string | null): string | undefined {
  const deactivated = deactivatedCodexTomlConnection(original)
  if (current === undefined) {
    if (deactivated === undefined) return original ?? undefined
    throw new Error('AI_ACCESS_CONFIG_NOT_MANAGED')
  }
  const currentDocument = parseCodexTomlDocument(current)
  if (currentDocument.toolboxConnection === undefined) {
    if (!equalTomlContent(current, deactivated ?? '')) throw new Error('AI_ACCESS_CONFIG_NOT_MANAGED')
    return original ?? undefined
  }
  const currentWithoutToolbox = currentDocument.toolboxConnection === undefined ? current : currentDocument.removeToolboxConnection()
  const currentWithoutConnectionKeys = removeRootConnectionKeys(parse(currentWithoutToolbox))
  if (original === null) {
    return currentWithoutConnectionKeys === '' ? undefined : currentWithoutConnectionKeys
  }
  const originalDocument = parse(original)
  const originalWithoutConnectionKeys = removeRootConnectionKeys(originalDocument)
  if (equalTomlContent(currentWithoutConnectionKeys, originalWithoutConnectionKeys)) return original

  const originalConnectionLines = originalDocument.assignments
    .filter((assignment) => assignment.table === undefined && assignment.path.length === 1 && codexConnectionTopLevelKeys.includes(assignment.path[0] as typeof codexConnectionTopLevelKeys[number]))
    .map((assignment) => originalDocument.lines[assignment.line])
  const candidate = insertRootLines(currentWithoutConnectionKeys, originalConnectionLines)
  parse(candidate)
  return candidate === '' ? undefined : candidate
}

/** Mirrors apply + deactivate for an existing backup without ever adding a route back. */
function deactivatedCodexTomlConnection(original: string | null): string | undefined {
  if (original === null) return undefined
  const document = parse(original)
  const withoutExisting = removeToolboxConnection(document, connectionOf(document))
  const result = removeRootConnectionKeys(parse(withoutExisting))
  return result === '' ? undefined : result
}

function parse(contents: string): ParsedDocument {
  // A multiline string/array needs a complete TOML parser to preserve safely. Do not turn a
  // customer file we do not understand into a partial configuration.
  if (contents.includes('"""') || contents.includes("'''")) throw new Error('AI_ACCESS_CONFIG_TOML_UNSUPPORTED')
  const lines = contents.split('\n')
  const assignments: Assignment[] = []
  const tables: Table[] = []
  const markerLines: number[] = []
  let currentTable: number | undefined
  const seenTables = new Set<string>()
  const seenAssignments = new Map<string, readonly (readonly string[])[]>()

  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line]
    const trimmedRaw = raw.trim()
    if (trimmedRaw === managedCodexBegin || trimmedRaw === managedCodexEnd) markerLines.push(line)
    const source = stripComment(raw).trim()
    if (source === '') continue
    const table = tableHeader(source)
    if (table !== undefined) {
      const id = tables.length
      const key = pathKey(table.path)
      if (!table.array && seenTables.has(key)) throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
      if (!table.array) seenTables.add(key)
      tables.push({ id, line, path: table.path, array: table.array })
      currentTable = id
      continue
    }
    if (source.startsWith('[')) throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
    const equal = equalsIndex(source)
    if (equal <= 0 || source.slice(equal + 1).trim() === '') throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
    const path = parseKeyPath(source.slice(0, equal))
    if (path === undefined) throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
    const assignment: Assignment = { line, path, table: currentTable, value: source.slice(equal + 1).trim() }
    const tableKey = currentTable === undefined ? '$root' : String(currentTable)
    const prior = seenAssignments.get(tableKey) ?? []
    if (prior.some((known) => pathOverlaps(known, path))) throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
    seenAssignments.set(tableKey, [...prior, path])
    assignments.push(assignment)
  }

  if (markerLines.length === 0) return { contents, lines, assignments, tables, managedMarker: undefined }
  if (markerLines.length !== 2 || lines[markerLines[0]].trim() !== managedCodexBegin || lines[markerLines[1]].trim() !== managedCodexEnd || markerLines[0] >= markerLines[1]) {
    throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
  }
  return { contents, lines, assignments, tables, managedMarker: [markerLines[0], markerLines[1]] }
}

function connectionOf(document: ParsedDocument): CodexToolboxConnection | undefined {
  const provider = document.assignments.find((item) => item.table === undefined && item.path.length === 1 && item.path[0] === 'model_provider')
  if (provider === undefined) return undefined
  const name = tomlBasicString(provider.value)
  if (name === undefined || !isToolboxProvider(name)) return undefined
  const providerTable = document.tables.find((table) => table.path.length === 2 && table.path[0] === 'model_providers' && table.path[1] === name)
  return providerTable !== undefined && isSemanticToolboxConnection(document, name, providerTable) ? { provider: name } : undefined
}

function removeToolboxConnection(document: ParsedDocument, connection: CodexToolboxConnection | undefined): string {
  if (document.managedMarker !== undefined) {
    if (!markerOwnsConnection(document, connection)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    const remove = new Set<number>()
    for (let index = document.managedMarker[0]; index <= document.managedMarker[1]; index += 1) remove.add(index)
    return withoutLines(document.lines, remove)
  }
  if (connection === undefined) return document.contents
  const remove = new Set<number>()
  for (const assignment of document.assignments) {
    if (assignment.table === undefined && assignment.path.length === 1 && codexConnectionTopLevelKeys.includes(assignment.path[0] as typeof codexConnectionTopLevelKeys[number])) {
      remove.add(assignment.line)
    }
  }
  const managedTable = document.tables.find((table) => table.path.length === 2 && table.path[0] === 'model_providers' && table.path[1] === connection.provider)
  if (managedTable !== undefined) {
    remove.add(managedTable.line)
    for (const assignment of document.assignments) if (assignment.table === managedTable.id) remove.add(assignment.line)
  }
  return withoutLines(document.lines, remove)
}

/** A marker is never sufficient ownership evidence: it must wrap the complete semantic connection we generate. */
function markerOwnsConnection(document: ParsedDocument, connection: CodexToolboxConnection | undefined): boolean {
  if (document.managedMarker === undefined || connection === undefined) return false
  const [start, end] = document.managedMarker
  const providerTable = document.tables.find((table) => table.path.length === 2 && table.path[0] === 'model_providers' && table.path[1] === connection.provider)
  if (providerTable === undefined) return false
  const root = document.assignments.filter((assignment) => assignment.table === undefined && assignment.path.length === 1 && codexConnectionTopLevelKeys.includes(assignment.path[0] as typeof codexConnectionTopLevelKeys[number]))
  const table = document.assignments.filter((assignment) => assignment.table === providerTable.id)
  return providerTable.line >= start && providerTable.line <= end &&
    root.every((assignment) => assignment.line >= start && assignment.line <= end) &&
    table.every((assignment) => assignment.line >= start && assignment.line <= end)
}

/**
 * CC Switch and user files may use arbitrary comments or `laixin-*` table names. Before we ever
 * remove one, require the complete route shape emitted by this Toolbox: a recognised provider,
 * API-mode sidecar, its isolated model catalog, a responses table, and the documented local or
 * direct endpoint for that provider.
 */
function isSemanticToolboxConnection(document: ParsedDocument, provider: string, providerTable: Table): boolean {
  const providerMatch = /^laixin-(deepseek|zhipu-api|zhipu|kimi|moonshot)(-local)?$/.exec(provider)
  if (providerMatch === null) return false
  const providerId = providerMatch[1]
  const local = providerMatch[2] === '-local'
  const root = rootValueMap(document)
  const table = tableValueMap(document, providerTable.id)
  const catalog = tomlBasicString(root.model_catalog_json ?? '')
  const baseUrl = tomlBasicString(table.base_url ?? '')
  const token = tomlBasicString(table.experimental_bearer_token ?? '')
  const model = tomlBasicString(root.model ?? '')
  const forced = tomlBasicString(root.forced_login_method ?? '')
  const wireApi = tomlBasicString(table.wire_api ?? '')
  return tomlBasicString(root.model_provider ?? '') === provider && forced === 'api' && model !== undefined && model !== '' &&
    catalog !== undefined && /(?:^|[\\/])laixin-models\.json$/.test(catalog) && token !== undefined && token !== '' && wireApi === 'responses' &&
    baseUrl !== undefined && (local ? localBaseUrl(providerId, baseUrl) : directBaseUrl(providerId, baseUrl))
}

function rootValueMap(document: ParsedDocument): Record<string, string> {
  return Object.fromEntries(document.assignments
    .filter((assignment) => assignment.table === undefined && assignment.path.length === 1)
    .map((assignment) => [assignment.path[0], assignment.value]))
}

function tableValueMap(document: ParsedDocument, table: number): Record<string, string> {
  return Object.fromEntries(document.assignments
    .filter((assignment) => assignment.table === table && assignment.path.length === 1)
    .map((assignment) => [assignment.path[0], assignment.value]))
}

function localBaseUrl(provider: string, value: string): boolean {
  return new RegExp(`^http://127\\.0\\.0\\.1:[0-9]{1,5}/codex/${escapeRegex(provider)}/v1$`).test(value)
}

function directBaseUrl(provider: string, value: string): boolean {
  // Keep the current Codex Responses endpoint and the endpoints emitted by older Toolbox
  // builds. Both variants are exact, provider-specific values: accepting either lets a
  // customer switch or disconnect an existing Toolbox connection without claiming an
  // arbitrary third-party TOML table.
  const bases: Readonly<Record<string, readonly string[]>> = {
    deepseek: ['https://api.deepseek.com/'],
    'zhipu-api': ['https://open.bigmodel.cn/api/v1', 'https://open.bigmodel.cn/api/paas/v4'],
    zhipu: ['https://open.bigmodel.cn/api/v1', 'https://open.bigmodel.cn/api/coding/paas/v4'],
    kimi: ['https://api.kimi.com/coding/v1'],
    moonshot: ['https://api.moonshot.cn/v1']
  }
  return bases[provider]?.includes(value) === true
}

function removeRootConnectionKeys(document: ParsedDocument): string {
  const remove = new Set<number>()
  for (const assignment of document.assignments) {
    if (assignment.table === undefined && assignment.path.length === 1 && codexConnectionTopLevelKeys.includes(assignment.path[0] as typeof codexConnectionTopLevelKeys[number])) {
      remove.add(assignment.line)
    }
  }
  return withoutLines(document.lines, remove)
}

function joinWithManagedBlock(source: string, block: string): string {
  const parsed = parse(source)
  const firstTableLine = parsed.tables[0]?.line
  const root = firstTableLine === undefined ? source : parsed.lines.slice(0, firstTableLine).join('\n')
  const tables = firstTableLine === undefined ? '' : parsed.lines.slice(firstTableLine).join('\n')
  return [trimBlankEdges(root), trimBlankEdges(block), trimBlankEdges(tables)]
    .filter((part) => part !== '')
    .join('\n\n')
    .concat('\n')
}

function insertRootLines(source: string, additions: readonly string[]): string {
  if (additions.length === 0) return source
  const parsed = parse(source)
  const firstTableLine = parsed.tables[0]?.line
  const root = firstTableLine === undefined ? source : parsed.lines.slice(0, firstTableLine).join('\n')
  const tables = firstTableLine === undefined ? '' : parsed.lines.slice(firstTableLine).join('\n')
  return [trimBlankEdges(additions.join('\n')), trimBlankEdges(root), trimBlankEdges(tables)]
    .filter((part) => part !== '')
    .join('\n\n')
    .concat('\n')
}

function withoutLines(lines: readonly string[], remove: ReadonlySet<number>): string {
  if (remove.size === 0) return lines.join('\n')
  return trimBlankEdges(lines.filter((_, index) => !remove.has(index)).join('\n'))
}

function trimBlankEdges(value: string): string { return value.replace(/^\n+|\n+$/g, '') }

function equalTomlContent(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
  return normalize(left) === normalize(right)
}

function tableHeader(source: string): { readonly path: readonly string[]; readonly array: boolean } | undefined {
  const array = source.startsWith('[[')
  const openLength = array ? 2 : source.startsWith('[') ? 1 : 0
  if (openLength === 0) return undefined
  const close = array ? ']]' : ']'
  if (!source.endsWith(close)) throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
  const interior = source.slice(openLength, -close.length)
  const path = parseKeyPath(interior)
  if (path === undefined) throw new Error('AI_ACCESS_CONFIG_TOML_INVALID')
  return { path, array }
}

function parseKeyPath(source: string): readonly string[] | undefined {
  const keys: string[] = []
  let index = 0
  for (;;) {
    while (/\s/.test(source[index] ?? '')) index += 1
    const start = index
    let key: string | undefined
    const quote = source[index]
    if (quote === '"') {
      index += 1
      let escaped = false
      while (index < source.length) {
        const character = source[index]
        index += 1
        if (escaped) { escaped = false; continue }
        if (character === '\\') { escaped = true; continue }
        if (character === '"') break
      }
      if (source[index - 1] !== '"') return undefined
      try { key = JSON.parse(source.slice(start, index)) as string } catch { return undefined }
    } else if (quote === "'") {
      index += 1
      const end = source.indexOf("'", index)
      if (end < 0) return undefined
      key = source.slice(index, end)
      index = end + 1
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index))
      if (match === null) return undefined
      key = match[0]
      index += key.length
    }
    if (key === '') return undefined
    keys.push(key)
    while (/\s/.test(source[index] ?? '')) index += 1
    if (index === source.length) return keys
    if (source[index] !== '.') return undefined
    index += 1
  }
}

function stripComment(source: string): string {
  let quote: 'basic' | 'literal' | undefined
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote === 'basic') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = undefined
      continue
    }
    if (quote === 'literal') {
      if (character === "'") quote = undefined
      continue
    }
    if (character === '"') quote = 'basic'
    else if (character === "'") quote = 'literal'
    else if (character === '#') return source.slice(0, index)
  }
  return source
}

function equalsIndex(source: string): number {
  let quote: 'basic' | 'literal' | undefined
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote === 'basic') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = undefined
      continue
    }
    if (quote === 'literal') {
      if (character === "'") quote = undefined
      continue
    }
    if (character === '"') quote = 'basic'
    else if (character === "'") quote = 'literal'
    else if (character === '=') return index
  }
  return -1
}

function pathKey(path: readonly string[]): string { return path.join('\u0000') }

function pathOverlaps(left: readonly string[], right: readonly string[]): boolean {
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) if (left[index] !== right[index]) return false
  return true
}

function tomlBasicString(value: string): string | undefined {
  const source = value.trim()
  if (!source.startsWith('"')) return undefined
  let escaped = false
  let end = 1
  for (; end < source.length; end += 1) {
    if (escaped) { escaped = false; continue }
    if (source[end] === '\\') { escaped = true; continue }
    if (source[end] === '"') break
  }
  if (end >= source.length) return undefined
  try { return JSON.parse(source.slice(0, end + 1)) as string } catch { return undefined }
}

function isToolboxProvider(provider: string): boolean { return /^laixin-[a-z0-9-]+(?:-local)?$/.test(provider) }

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

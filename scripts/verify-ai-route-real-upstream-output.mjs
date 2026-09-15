/**
 * Pure checks for the real-provider runner. They deliberately retain only the fixed CC Switch
 * fixture fields needed to prove restore safety; arbitrary customer TOML never leaves the runner.
 */
export function nativeRouteModelAccepted(shell, configuredModel, observedModel, allowedModels) {
  if (typeof configuredModel !== 'string' || typeof observedModel !== 'string' || !Array.isArray(allowedModels)) return false
  return shell === 'claude' ? allowedModels.includes(observedModel) : observedModel === configuredModel
}

/**
 * Gateway snapshots are newest-first.  The runner keeps the prior newest record as a boundary,
 * then accepts only records prepended by the native process.  If the bounded gateway history
 * has rotated that boundary away, fail closed rather than treating old traffic as fresh proof.
 */
export function newlyPrependedGatewayRecords(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return []
  if (before.length === 0) return [...after]
  const boundary = after.indexOf(before[0])
  return boundary < 0 ? [] : after.slice(0, boundary)
}

/** Safe runner evidence: request count and the fixed failure code only, never a prompt, response, header or Key. */
export function nativeClientEvidence(records, shell, provider) {
  if (!Array.isArray(records) || !['codex', 'claude', 'hermes'].includes(shell) || typeof provider !== 'string') {
    return { requests: 0, succeeded: false, cancelled: 0, failure: null }
  }
  const matching = records.filter(record => record && record.source === 'client' && record.shell === shell && record.provider === provider)
  const cancelled = matching.filter(record => record.code === 'client_aborted')
  const failed = matching.find(record => record.ok !== true && record.code !== 'client_aborted' && typeof record.code === 'string' && /^[a-z_]{1,64}$/.test(record.code))
  return { requests: matching.length, succeeded: matching.some(record => record.ok === true), cancelled: cancelled.length, failure: failed?.code ?? null }
}

import { posix, win32 } from 'node:path'

/** Only Kimi's two separately billed products can prove a Key-source mismatch by probing a sister. */
export function expectedProviderMismatchSuggestion(provider) {
  return provider === 'kimi' ? 'moonshot' : provider === 'moonshot' ? 'kimi' : undefined
}

/** A local outage or generic auth failure must never become an expected-failure green result. */
export function expectedProviderMismatchAccepted(provider, expectedSuggestion, attempt) {
  return typeof expectedSuggestion === 'string' && expectedProviderMismatchSuggestion(provider) === expectedSuggestion &&
    attempt?.ok === false && attempt.code === 'key_product_mismatch' && attempt.suggestedProvider === expectedSuggestion
}

/**
 * Native acceptance must start with an isolated, platform-native baseline.  In particular,
 * Windows cannot inherit a caller's SystemRoot/PATH while still claiming to verify a native app.
 */
export function isolatedNativeEnvironment(platform, home, hermesHome, temporaryDirectory, trustedWindowsRoot) {
  const common = {
    HOME: home,
    CODEX_HOME: platform === 'win32' ? win32.join(home, '.codex') : posix.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: platform === 'win32' ? win32.join(home, '.claude') : posix.join(home, '.claude'),
    HERMES_HOME: hermesHome,
    TMPDIR: temporaryDirectory,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  }
  if (platform === 'win32') {
    if (trustedWindowsRoot !== 'C:\\Windows') throw new Error('windows_root_invalid')
    const path = `${win32.join(trustedWindowsRoot, 'System32')};${trustedWindowsRoot}`
    return {
      ...common,
      PATH: path,
      Path: path,
      SystemRoot: trustedWindowsRoot,
      SYSTEMROOT: trustedWindowsRoot,
      COMSPEC: win32.join(trustedWindowsRoot, 'System32', 'cmd.exe'),
      USERPROFILE: home,
      APPDATA: win32.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: win32.join(home, 'AppData', 'Local'),
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory
    }
  }
  return {
    ...common,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    XDG_CONFIG_HOME: posix.join(home, '.xdg', 'config'),
    XDG_DATA_HOME: posix.join(home, '.xdg', 'data'),
    XDG_STATE_HOME: posix.join(home, '.xdg', 'state'),
    XDG_CACHE_HOME: posix.join(home, '.xdg', 'cache')
  }
}

/** Parses the bounded fixture written by seedCcSwitch(), not general customer TOML. */
export function ccSwitchFixtureSnapshot(contents) {
  if (typeof contents !== 'string') return undefined
  let table = ''
  const fields = {}
  for (const line of contents.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/.exec(line)
    if (header) { table = header[1]; continue }
    const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line)
    if (!assignment) continue
    const value = tomlString(assignment[2])
    if (value === undefined) return undefined
    const key = table === '' && assignment[1] === 'model' ? 'model'
      : table === '' && assignment[1] === 'model_provider' ? 'modelProvider'
        : table === 'model_providers.deepseek' && assignment[1] === 'name' ? 'providerName'
          : table === 'model_providers.deepseek' && assignment[1] === 'base_url' ? 'providerBaseUrl'
            : table === 'mcp_servers.customer-tool' && assignment[1] === 'command' ? 'mcpCommand'
              : undefined
    if (key === undefined) continue
    if (fields[key] !== undefined) return undefined
    fields[key] = value
  }
  const required = ['model', 'modelProvider', 'providerName', 'providerBaseUrl', 'mcpCommand']
  if (required.some(key => typeof fields[key] !== 'string')) return undefined
  return Object.freeze({
    model: fields.model,
    modelProvider: fields.modelProvider,
    providerName: fields.providerName,
    providerBaseUrl: fields.providerBaseUrl,
    mcpCommand: fields.mcpCommand
  })
}

export function sameCcSwitchFixture(before, after) {
  return before !== undefined && after !== undefined &&
    before.model === after.model && before.modelProvider === after.modelProvider &&
    before.providerName === after.providerName && before.providerBaseUrl === after.providerBaseUrl &&
    before.mcpCommand === after.mcpCommand
}

/**
 * `useOfficial()` restores the pre-Toolbox CC Switch document while it is still Toolbox-managed,
 * then clears Toolbox sidecars. The official selection only means the Toolbox route is gone;
 * third-party auth remains classified as login-required rather than being erased.
 */
export function ccSwitchFixtureIsDetachedFromToolbox(contents) {
  if (typeof contents !== 'string') return false
  return !contents.includes('# >>> Laixin AI Toolbox managed model connection >>>') &&
    !contents.includes('# <<< Laixin AI Toolbox managed model connection <<<') &&
    !/^\s*model_provider\s*=\s*["']laixin-(?:deepseek|zhipu-api|zhipu|kimi|moonshot)(?:-local)?["']\s*(?:#.*)?$/m.test(contents) &&
    !/^\s*\[\s*model_providers\.laixin-(?:deepseek|zhipu-api|zhipu|kimi|moonshot)(?:-local)?\s*\]\s*(?:#.*)?$/m.test(contents)
}

export function ccSwitchDetachAccepted(before, afterAuthHash, afterConfigHash, selected, authentication, contents) {
  return typeof before?.authHash === 'string' && before.authHash === afterAuthHash && selected === 'official' &&
    authentication?.state === 'login-required' && authentication.reason === 'other-tool-api-key' &&
    typeof before?.configHash === 'string' && before.configHash === afterConfigHash &&
    sameCcSwitchFixture(before.config, ccSwitchFixtureSnapshot(contents))
}

function tomlString(value) {
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : undefined
    } catch { return undefined }
  }
  return value.slice(1, -1)
}

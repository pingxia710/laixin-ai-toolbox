#!/usr/bin/env node
/* global Buffer, clearTimeout, process, setTimeout */
/**
 * Real-provider acceptance for the three native clients.
 *
 * This intentionally goes through AiAccessService.configureProvider(), then launches an
 * explicitly supplied native binary against its isolated configuration. It never reads a Key
 * from a shell environment, prints a Key/auth file/upstream error, or falls back to PATH.
 *
 * Example:
 * node scripts/verify-ai-route-real-upstream.mjs \
 *   --provider deepseek --key-file /private/path/keys.json --key-field deepseek \
 *   --codex-bin /Applications/ChatGPT.app/Contents/Resources/codex \
 *   --claude-bin /absolute/claude --hermes-bin /absolute/hermes
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { nativeAssistantReplyCompleted } from './verify-ai-route-cli-output.mjs'
import {
  ccSwitchDetachAccepted,
  ccSwitchFixtureSnapshot,
  expectedProviderMismatchAccepted,
  expectedProviderMismatchSuggestion,
  isolatedNativeEnvironment,
  nativeClientEvidence,
  newlyPrependedGatewayRecords,
  nativeRouteModelAccepted
} from './verify-ai-route-real-upstream-output.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repository, 'package.json'))
const ts = require('typescript')
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, file)

const { AiGateway } = require(join(repository, 'app/main/ai-access/gateway.ts'))
const { createDeepSeekAdapters } = require(join(repository, 'app/main/ai-access/adapters.ts'))
const { createManagedTextFile } = require(join(repository, 'app/main/ai-access/file.ts'))
const { AiAccessService } = require(join(repository, 'app/main/ai-access/service.ts'))
const { isProviderShellSupported, modelProviderIds, providerShellContract } = require(join(repository, 'app/shared/model-providers.ts'))
const { trustedCliCommandCandidates, trustedHermesEnvironment, trustedHermesExecutable, trustedWindowsSystemRoot } = require(join(repository, 'app/main/shells/inventory.ts'))

const options = parseOptions(process.argv.slice(2))
const provider = requiredOption(options, 'provider')
if (!modelProviderIds.includes(provider)) fail('provider_invalid')
const keyFile = requiredOption(options, 'key-file')
const keyField = requiredOption(options, 'key-field')
const requestedShells = splitOption(options, 'shells')
const shells = requestedShells.length === 0
  ? ['codex', 'claude', 'hermes'].filter(shell => isProviderShellSupported(provider, shell))
  : requestedShells
if (shells.length === 0 || shells.some(shell => !['codex', 'claude', 'hermes'].includes(shell))) fail('shell_invalid')
if (shells.some(shell => !isProviderShellSupported(provider, shell))) fail('provider_shell_not_supported')

const explicitModel = validatedExplicitModel(options.get('model'), provider, shells)
const key = readKey(keyFile, keyField)
const expectedMismatch = validatedExpectedProviderMismatch(options, provider, shells)
const binaries = expectedMismatch === undefined ? await readBinaries(options, shells) : {}
const ccSwitch = options.has('cc-switch')
if (ccSwitch && (provider !== 'deepseek' || shells.length !== 1 || shells[0] !== 'codex')) fail('cc_switch_requires_deepseek_codex')
if (expectedMismatch !== undefined && ccSwitch) fail('expected_failure_cannot_use_cc_switch')

const root = await mkdtemp(join(tmpdir(), 'laixin-real-provider-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const hermesHome = join(home, '.hermes')
let state = { version: 1, selected: {} }
const store = { read: async () => state, write: async next => { state = next } }
const gateway = new AiGateway({ timeoutMs: 90_000 })
const results = []
let ccSwitchBefore

try {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(join(root, 'tmp'), { recursive: true })])
  if (ccSwitch) {
    await seedCcSwitch(home)
    const codex = join(home, '.codex')
    const config = await readFile(join(codex, 'config.toml'), 'utf8')
    ccSwitchBefore = {
      authHash: createHash('sha256').update(await readFile(join(codex, 'auth.json'))).digest('hex'),
      configHash: createHash('sha256').update(config).digest('hex'),
      config: ccSwitchFixtureSnapshot(config)
    }
  }
  const file = createManagedTextFile()
  // The real native Hermes executable remains independently verified below. These two hooks only
  // write this runner's temporary config document, so adapter setup never treats a real launcher
  // as though it belonged to the temporary HERMES_HOME.
  const hermesSettings = new Map()
  const syncHermesSettings = async () => {
    const lines = ['model:']
    for (const key of ['provider', 'default', 'base_url', 'api_key', 'api_mode', 'context_length']) {
      const value = hermesSettings.get(`model.${key}`)
      if (value !== undefined) lines.push(`  ${key}: ${JSON.stringify(value)}`)
    }
    await mkdir(hermesHome, { recursive: true, mode: 0o700 })
    await writeFile(join(hermesHome, 'config.yaml'), `${lines.join('\n')}\n`, { mode: 0o600 })
  }
  const runHermes = async (_command, args) => {
    if (args[0] === 'config' && args[1] === 'set') hermesSettings.set(args[2], args[3])
    if (args[0] === 'config' && args[1] === 'unset') hermesSettings.delete(args[2])
    await syncHermesSettings()
  }
  const readHermesConfig = async (_command, key) => hermesSettings.get(key)
  const adapters = createDeepSeekAdapters({
    home,
    platform: process.platform,
    hermesHome,
    file,
    findHermesCommand: async () => binaries.hermes,
    runHermes,
    readHermesConfig
  })
  const service = new AiAccessService(store, adapters, gateway)

  for (const shell of shells) {
    const contract = providerShellContract(provider, shell)
    const model = explicitModel ?? contract.defaultModel
    const configured = await service.configureProvider(shell, provider, key, model)
    const attempt = configured.attempt
    if (expectedMismatch !== undefined) {
      const matches = expectedProviderMismatchAccepted(provider, expectedMismatch.suggestedProvider, attempt)
      results.push({ shell, phase: 'expected-provider-failure', passed: matches, code: attempt?.code ?? null,
        suggestedProvider: attempt?.suggestedProvider ?? null })
      continue
    }
    if (attempt?.ok !== true || configured.shells[shell].selected !== provider) {
      results.push({ shell, phase: 'provider-probe', passed: false, code: attempt?.code ?? 'unknown' })
      continue
    }
    const before = gateway.snapshot().requests
    const isolated = isolatedEnvironment(home, hermesHome, join(root, 'tmp'))
    const native = await runNative(shell, binaries[shell], nativeArgs(shell), shell === 'hermes'
      ? { ...isolated, ...trustedHermesEnvironment(process.platform, hermesHome, isolated) }
      : isolated, workspace)
    // configureProvider() has already appended its own source:'test' probe. Gateway history is
    // newest-first, so only records prepended after the native client starts can prove this run.
    const records = newlyPrependedGatewayRecords(before, gateway.snapshot().requests)
    const accepted = gateway.clientAcceptances()[shell]
    const client = nativeClientEvidence(records, shell, provider)
    const clientSuccess = client.succeeded
    const passed = native.exitCode === 0 && native.hasCompletedAnswer && clientSuccess && accepted?.provider === provider &&
      nativeRouteModelAccepted(shell, model, accepted?.model, contract.models)
    results.push({ shell, phase: 'native-real-provider', passed, exitCode: native.exitCode, clientSuccess,
      nativeAnswer: native.hasCompletedAnswer, accepted: accepted !== undefined, observedModel: accepted?.model ?? null,
      clientRequests: client.requests, ...(client.cancelled === 0 ? {} : { clientCancelled: client.cancelled }),
      ...(client.failure === null ? {} : { clientFailure: client.failure }) })
  }

  if (ccSwitch && expectedMismatch === undefined) results.push(...await verifyCcSwitchRestore(home, service, ccSwitchBefore))
  const passed = results.every(result => result.passed)
  // Only a model admitted by the selected product-and-shell contract is ever rendered.
  process.stdout.write(`${JSON.stringify({ provider, model: explicitModel ?? null, results, passed }, null, 2)}\n`)
  if (!passed) process.exitCode = 1
} catch {
  process.stdout.write(`${JSON.stringify({ provider, results, passed: false, reason: 'runner_failed' }, null, 2)}\n`)
  process.exitCode = 1
} finally {
  await gateway.stop().catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

function parseOptions(items) {
  const parsed = new Map()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item.startsWith('--')) fail('argument_invalid')
    const name = item.slice(2)
    if (!name || parsed.has(name)) fail('argument_invalid')
    const next = items[index + 1]
    if (next === undefined || next.startsWith('--')) parsed.set(name, true)
    else { parsed.set(name, next); index += 1 }
  }
  return parsed
}

function requiredOption(options, name) {
  const value = options.get(name)
  if (typeof value !== 'string' || value === '') fail(`missing_${name}`)
  return value
}

function splitOption(options, name) {
  const value = options.get(name)
  if (value === undefined) return []
  if (typeof value !== 'string') fail('argument_invalid')
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function validatedExplicitModel(value, provider, shells) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) fail('model_invalid')
  for (const shell of shells) {
    const contract = providerShellContract(provider, shell)
    if (contract.status !== 'supported' || !contract.models.includes(value)) fail('model_invalid')
  }
  return value
}

/**
 * This runner has exactly one expected-failure acceptance: a Kimi Key rejected by the wrong
 * product and then proven usable by its named sister product.  Generic local/configuration
 * failures are never acceptance evidence, even when an operator asks for that error code.
 */
function validatedExpectedProviderMismatch(options, provider, shells) {
  const code = options.get('expect-code')
  const suggestion = options.get('expect-suggested-provider')
  if (code === undefined && suggestion === undefined) return undefined
  const expectedSuggestion = expectedProviderMismatchSuggestion(provider)
  if (code !== 'key_product_mismatch' || typeof suggestion !== 'string' ||
    suggestion !== expectedSuggestion || suggestion === provider ||
    shells.some(shell => !isProviderShellSupported(suggestion, shell))) {
    fail('expected_provider_mismatch_invalid')
  }
  return { suggestedProvider: suggestion }
}

function readKey(path, field) {
  let contents
  try { contents = JSON.parse(readFileSync(path, 'utf8')) } catch { fail('key_file_unavailable') }
  const candidate = contents?.[field]
  const key = typeof candidate === 'string' ? candidate : typeof candidate?.key === 'string' ? candidate.key : candidate?.apiKey
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{16,512}$/.test(key)) fail('key_unavailable')
  return key
}

async function readBinaries(options, shells) {
  const result = {}
  for (const shell of shells) {
    const value = options.get(`${shell}-bin`)
    if (typeof value !== 'string' || !isAbsolute(value)) fail(`missing_${shell}_bin`)
    if (!await trustedNativeBinary(shell, value)) fail(`unsafe_${shell}_bin`)
    result[shell] = value
  }
  return result
}

async function trustedNativeBinary(shell, path) {
  const normalized = resolve(path)
  // A terminal symlink is never an acceptance executable. The explicit `--*-bin` argument is
  // only a selection among fixed official candidates; it cannot turn a PATH or temp binary into
  // a real-Key acceptance executable.
  const info = await lstat(normalized).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) return false

  const home = trustedCliHome()
  if (home === undefined) return false
  const inventoryShell = shell === 'claude' ? 'claude-code' : shell
  // Candidate locations are derived only from the current OS account's fixed installation roots.
  // An invoking terminal's HOME/APPDATA/HERMES_HOME values must not turn a temporary or
  // relocated launcher into a real-Key acceptance executable.
  const candidates = (await trustedCliCommandCandidates(inventoryShell, process.platform, home, {}))
    // `~/.local/bin/claude` is a launcher/wrapper location.  It must never be an acceptance
    // executable, even when it happens to have a native-file magic prefix.
    .filter(candidate => shell !== 'claude' || resolve(candidate) !== claudeLauncherPath(home))
  const candidateIndex = candidates.findIndex(candidate => resolve(candidate) === normalized)
  if (candidateIndex < 0 || await realpath(normalized).catch(() => '') !== normalized) return false

  // Hermes is a generated console script, not a native binary. It is accepted only after the
  // selected path has matched the current account's fixed inventory candidate above; checking
  // its body alone would still let an arbitrary sibling python3 run with a real provider Key.
  if (shell === 'hermes') return trustedHermesExecutable(normalized, process.platform)
  return nativeExecutable(normalized)
}

async function nativeExecutable(path) {
  const file = await open(path, 'r').catch(() => undefined)
  if (!file) return false
  const header = Buffer.alloc(4)
  try { await file.read(header, 0, header.length, 0) } finally { await file.close() }
  const value = header.length === 4 ? header.readUInt32BE(0) : 0
  return (header[0] === 0x4d && header[1] === 0x5a) || value === 0x7f454c46 ||
    value === 0xfeedface || value === 0xfeedfacf || value === 0xcefaedfe || value === 0xcffaedfe ||
    value === 0xcafebabe || value === 0xbebafeca || value === 0xcafebabf || value === 0xbfbafeca
}

function trustedCliHome() {
  try {
    const value = userInfo().homedir
    return isAbsolute(value) ? resolve(value) : undefined
  } catch { return undefined }
}

function claudeLauncherPath(home) {
  return resolve(join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'))
}

function nativeArgs(shell) {
  if (shell === 'codex') return ['exec', '--skip-git-repo-check', '--json', '--sandbox', 'read-only', 'Reply only OK. Do not use any tools.']
  if (shell === 'claude') return ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', 'Reply only OK. Do not use any tools.']
  return ['chat', '--oneshot', '-Q', '--ignore-rules', '--max-turns', '1', '--run-budget', '25', '-q', 'Reply only OK. Do not use any tools.']
}

function isolatedEnvironment(home, hermesHome, temporaryDirectory) {
  return isolatedNativeEnvironment(process.platform, home, hermesHome, temporaryDirectory, trustedWindowsSystemRoot)
}

async function runNative(shell, executable, args, environment, cwd) {
  // Recheck immediately before spawning: the earlier input validation alone would leave a
  // time window in which a selected path could be replaced with a wrapper.
  if (!await trustedNativeBinary(shell, executable)) return { exitCode: null, hasCompletedAnswer: false }
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    const collect = chunk => { if (stdout.length < 64 * 1024) stdout += String(chunk) }
    child.stdout.on('data', collect)
    // Drain stderr without retaining or interpreting private prompts, errors, or credentials.
    child.stderr.on('data', () => undefined)
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: null, hasCompletedAnswer: false }) })
    child.once('close', code => { clearTimeout(timer); resolve({ exitCode: code, hasCompletedAnswer: nativeAssistantReplyCompleted(shell, stdout) }) })
  })
}

async function seedCcSwitch(home) {
  const codex = join(home, '.codex')
  await mkdir(codex, { recursive: true, mode: 0o700 })
  await writeFile(join(codex, 'config.toml'), [
    'model = "deepseek-chat"',
    'model_provider = "deepseek"',
    '',
    '[model_providers.deepseek]',
    'name = "CC Switch"',
    'base_url = "https://api.deepseek.com"',
    '',
    '[model_providers.customer-secondary]',
    'name = "Customer secondary"',
    'base_url = "https://customer-secondary.invalid/v1"',
    '',
    '[mcp_servers.customer-tool]',
    'command = "customer-tool"',
    '',
    '[mcp_servers.customer-review]',
    'command = "customer-review"'
  ].join('\n').concat('\n'), { mode: 0o600 })
  await writeFile(join(codex, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-cc-switch-isolated-fixture-0123456789' }), { mode: 0o600 })
}

async function verifyCcSwitchRestore(home, service, before) {
  const codex = join(home, '.codex')
  const authPath = join(codex, 'auth.json')
  const configPath = join(codex, 'config.toml')
  let detached
  let detachedAuth
  let detachedConfig
  let backupExists
  try {
    detached = await service.useOfficial('codex')
    detachedAuth = await readFile(authPath)
    detachedConfig = await readFile(configPath, 'utf8')
    backupExists = await readFile(join(codex, 'laixin-model-api-backup.json')).then(() => true, () => false)
  } catch {
    return [{ shell: 'codex', phase: 'cc-switch-detach-and-restore', passed: false }]
  }

  const authentication = detached.officialAuthentication?.codex
  const detachedPassed = ccSwitchDetachAccepted(before, createHash('sha256').update(detachedAuth).digest('hex'),
    createHash('sha256').update(detachedConfig).digest('hex'), detached.shells.codex.selected, authentication, detachedConfig)
  return [{ shell: 'codex', phase: 'cc-switch-detach-and-restore', passed: detachedPassed && backupExists === false }]
}

function fail(reason) {
  process.stdout.write(`${JSON.stringify({ passed: false, reason })}\n`)
  process.exit(2)
}

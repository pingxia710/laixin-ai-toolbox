import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { nativeAssistantReplyIsOk, safeCliResult } from './verify-ai-route-cli-output.mjs'

// Runs installed, unwrapped CLI binaries against a deterministic in-memory upstream.
// Profiles and output are isolated. No account tokens or real provider requests are used.
const require = createRequire(import.meta.url)
const ts = require('typescript')
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
const { AiGateway } = require('../app/main/ai-access/gateway.ts')
const { createDeepSeekAdapters } = require('../app/main/ai-access/adapters.ts')
const { createManagedTextFile } = require('../app/main/ai-access/file.ts')
const { trustedCliExecutable, trustedHermesEnvironment } = require('../app/main/shells/inventory.ts')
const root = await mkdtemp(join(tmpdir(), 'laixin-native-api-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)
const token = 'laixin-isolated-client-token-0123456789'
const key = 'sk-isolated-upstream-key-0123456789'
const requested = []
const gateway = new AiGateway({ fetch: async (url, init) => {
  const shell = String(url).split('/').at(-1)
  requested.push({ shell, stream: JSON.parse(init.body).stream === true })
  return modelReply(shell, JSON.parse(init.body).stream === true)
} })
await gateway.start(0, token)
gateway.setRoutes(['codex','claude','hermes'].map(shell => ({ shell, provider: 'deepseek', model: 'deepseek-flash', key, endpoint: `https://fixture.invalid/${shell}` })))
const results = []
const baseEnv = { PATH: process.platform === 'win32'
  ? (process.env.SYSTEMROOT ? `${process.env.SYSTEMROOT}\\System32;${process.env.SYSTEMROOT}` : 'C:\\Windows\\System32;C:\\Windows')
  : '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TERM: 'dumb',
  DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
try {
  const installedHome = process.platform === 'win32' ? process.env.USERPROFILE ?? process.env.HOME : process.env.HOME
  const trusted = installedHome && isAbsolute(installedHome)
    ? {
        codex: await trustedCliExecutable('codex', process.platform, installedHome, process.env),
        claude: await trustedCliExecutable('claude-code', process.platform, installedHome, process.env),
        hermes: await trustedCliExecutable('hermes', process.platform, installedHome, process.env)
      }
    : { codex: undefined, claude: undefined, hermes: undefined }
  // Optional CLI arguments are selectors only. They cannot turn a PATH wrapper or a temporary
  // binary into a runnable acceptance client.
  const explicit = { claude: process.argv[2], hermes: process.argv[3] }
  const select = (shell, candidate) => {
    const requested = explicit[shell]
    return typeof requested === 'string' && candidate && resolve(requested) !== resolve(candidate) ? undefined : candidate
  }
  const binaries = { codex: trusted.codex, claude: select('claude', trusted.claude), hermes: select('hermes', trusted.hermes) }
  for (const shell of ['codex','claude','hermes']) {
    const executable = binaries[shell]
    if (!executable || !isAbsolute(executable)) { results.push(safeCliResult(shell, 'not-tested-no-native-binary')); continue }
    const home = join(root, shell)
    await mkdir(home)
    const hermesHome = join(home, '.hermes')
    const file = createManagedTextFile()
    const hermesSettings = new Map()
    const syncHermesSettings = async () => {
      const lines = ['model:']
      for (const key of ['provider', 'default', 'base_url', 'api_key', 'api_mode', 'context_length']) {
        const value = hermesSettings.get(`model.${key}`)
        if (value !== undefined) lines.push(`  ${key}: ${JSON.stringify(value)}`)
      }
      await file.write(join(hermesHome, 'config.yaml'), `${lines.join('\n')}\n`)
    }
    const runHermes = async (_command, args) => {
      if (args[0] === 'config' && args[1] === 'set') hermesSettings.set(args[2], args[3])
      if (args[0] === 'config' && args[1] === 'unset') hermesSettings.delete(args[2])
      await syncHermesSettings()
    }
    const readHermesConfig = async (_command, key) => hermesSettings.get(key)
    const adapters = createDeepSeekAdapters({ home, platform: process.platform, hermesHome, file,
      findHermesCommand: async () => executable,
      ...(shell === 'hermes' ? { runHermes, readHermesConfig } : {}) })
    try {
      await adapters.find(a => a.shell === shell).applyConnection('deepseek', { baseUrl: `${gateway.baseUrl}/${shell}/deepseek${shell === 'claude' ? '' : '/v1'}`, apiKey: token, model: 'deepseek-flash' })
      const args = shell === 'codex' ? ['exec','--skip-git-repo-check','--json','--sandbox','read-only','Reply only OK. Do not use any tools.']
        : shell === 'claude' ? ['-p','--output-format','json','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','Reply only OK.']
          : ['chat','--oneshot','-Q','--ignore-rules','--max-turns','1','--run-budget','25','-q','Reply only OK. Do not use any tools.']
      const before = requested.length
      const isolated = { ...baseEnv, HOME: home, CODEX_HOME: join(home,'.codex'), CLAUDE_CONFIG_DIR: join(home,'.claude'), HERMES_HOME: hermesHome }
      const output = await run(executable, args, shell === 'hermes'
        ? { ...isolated, ...trustedHermesEnvironment(process.platform, hermesHome, isolated) }
        : isolated)
      results.push(safeCliResult(shell,
        output.code === 0 && nativeAssistantReplyIsOk(shell, output.stdout) && requested.length > before ? 'passed-native-cli-local-upstream' : 'failed',
        { exitCode: output.code, requests: requested.length - before }))
    } catch { results.push(safeCliResult(shell, 'configuration-failed')) }
  }
  console.log(JSON.stringify({ results }, null, 2))
  if (results.some(r => r.status === 'failed' || r.status === 'configuration-failed')) process.exitCode = 1
} finally { await gateway.stop() }

function run(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: workspace, env, stdio: ['ignore','pipe','pipe'] })
    let stdout = ''
    const collect = chunk => { if (stdout.length < 64 * 1024) stdout += chunk.toString() }
    child.stdout.on('data',collect); child.stderr.on('data', () => undefined)
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45000)
    child.once('error',error => { clearTimeout(timeout); reject(error) })
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout }) })
  })
}
function modelReply(shell, stream) {
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
  const output = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
  const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: 'deepseek-flash', output: [output], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }
  const chat = { id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }
  if (!stream) return Response.json(shell === 'codex' ? response : shell === 'claude' ? message : chat)
  const frames = shell === 'codex' ? [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: output.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: output.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', item_id: output.id, output_index: 0, content_index: 0, text: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item: output }, { type: 'response.completed', response }
  ] : shell === 'claude' ? [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }
  ] : [{ ...chat, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }, { ...chat, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
  return new Response(frames.map((frame,i) => `${frame.type ? `event: ${frame.type}\n` : ''}data: ${JSON.stringify({ ...frame, sequence_number: i })}\n\n`).join('') + (shell === 'hermes' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}

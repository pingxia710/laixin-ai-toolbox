import readline from 'node:readline'
import process from 'node:process'

const mode = process.argv[2] || 'ready'
const expectedCodexHome = process.argv[3]
let initialized = false
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\n')

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') return reply(request.id, {})
  if (request.method === 'initialized') { initialized = true; return }
  if (!initialized) throw new Error('initialize handshake missing')
  if (request.method === 'account/login/start') {
    if (mode === 'require-codex-home' && process.env.CODEX_HOME !== expectedCodexHome) process.exit(3)
    reply(request.id, { type: 'chatgpt', loginId: 'login-fixture', authUrl: mode === 'unexpected-url' ? 'https://elsewhere.example.test/authorize' : 'https://chatgpt.com/authorize' })
    if (mode === 'ready' || mode === 'require-codex-home') setTimeout(() => notify('account/login/completed', { loginId: 'login-fixture', success: true, error: null }), 10)
    if (mode === 'rejected') setTimeout(() => notify('account/login/completed', { loginId: 'login-fixture', success: false, error: 'fixture-private-error' }), 10)
    // hang＝浏览器开了但客户一直不在浏览器里完成授权：登录永远不决议，等总超时来收场。
    return
  }
  if (request.method === 'account/login/cancel') {
    notify('account/login/completed', { loginId: request.params.loginId, success: false, error: 'cancelled' })
    return reply(request.id, {})
  }
  process.exitCode = 1
})

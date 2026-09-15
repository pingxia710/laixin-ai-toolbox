import readline from 'node:readline'
import fs from 'node:fs'
import process from 'node:process'
import { setInterval } from 'node:timers'
const mode = process.argv[2] || 'ready'
let initialized = false
let reads = 0
if (process.env.USAGE_FIXTURE_PID) fs.writeFileSync(process.env.USAGE_FIXTURE_PID, String(process.pid))
if (mode === 'hang') setInterval(() => {}, 10_000)
if (mode === 'ignore-term') process.on('SIGTERM', () => {})
const secret = 'fixture-secret-must-not-leak'
const reply = (id, result) => {
  const line = JSON.stringify({ id, result }) + '\n'
  process.stdout.write(line.slice(0, 5))
  process.stdout.write(line.slice(5))
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (process.env.USAGE_FIXTURE_REQUESTS) fs.appendFileSync(process.env.USAGE_FIXTURE_REQUESTS, JSON.stringify(request) + '\n')
  if (mode === 'hang' || mode === 'ignore-term') return
  if (mode === 'exit') return process.exit(1)
  if (mode === 'oversize') return process.stdout.write('x'.repeat(1_100_000))
  if (mode === 'malformed') return process.stdout.write('not-json\n')
  if (request.method === 'initialize') return reply(request.id, {})
  if (request.method === 'initialized') { initialized = true; return }
  if (!initialized) throw new Error('initialize handshake missing')
  if (request.method === 'account/read') {
    reads++
    return reply(request.id, { account: mode === 'signed-out' ? null : mode === 'api-key' ? { type: 'apiKey' } : {
      type: 'chatgpt', email: mode === 'changed' && reads > 1 ? 'other@example.test' : 'demo@example.test', planType: 'plus'
    } })
  }
  if (request.method === 'account/rateLimits/read') {
    if (mode === 'unsupported-method') return process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
    if (mode === 'failure') return process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: secret } }) + '\n')
    return reply(request.id, {
      rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 10800 }, secondary: { usedPercent: 65, windowDurationMins: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 345600 } } },
      ignoredCredential: secret
    })
  }
  throw new Error('Unexpected mutating method')
})

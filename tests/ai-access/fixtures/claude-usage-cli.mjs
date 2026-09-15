import readline from 'node:readline'
import process from 'node:process'
import { appendFileSync } from 'node:fs'
const mode = process.argv[2]
readline.createInterface({ input: process.stdin }).on('line', line => {
  const input = JSON.parse(line)
  if (process.env.CLAUDE_USAGE_REQUESTS) appendFileSync(process.env.CLAUDE_USAGE_REQUESTS, line + '\n')
  if (mode === 'hang') return
  if (mode === 'invalid') { process.stdout.write('bad json\n'); return }
  if (mode === 'request') { process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'unexpected', request: { subtype: 'can_use_tool' } }) + '\n'); return }
  const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 23, resets_at: '2026-09-13T00:00:00Z' }, seven_day: { utilization: null, resets_at: null } }, session: { secret: 'fixture-private' }, behaviors: { secret: 'fixture-private' } }
  const result = input.request.subtype === 'get_usage' ? mode === 'empty' ? { rate_limits_available: false, rate_limits: null } : usage : {}
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: mode === 'unsupported' ? 'error' : 'success', request_id: input.request_id, response: result, error: mode === 'unsupported' ? 'fixture-private' : undefined } }) + '\n')
})

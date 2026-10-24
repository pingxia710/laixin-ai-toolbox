import { readFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import readline from 'node:readline'

// Read only generated fixture identities inside the explicitly supplied temporary directory.
// No default home, real auth store, login, token refresh, or usage request is involved.
const base = process.argv[2]
const root = process.env.CODEX_HOME ?? (base ? join(base, '.codex') : undefined)
const inside = base && root ? relative(base, root) : undefined
let account = null
if (inside !== undefined && !inside.startsWith('..') && !isAbsolute(inside)) {
  account = JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8'))
}
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`)
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') return reply(request.id, {})
  if (request.method === 'initialized') return
  if (request.method === 'account/read') return reply(request.id, { account })
  throw new Error('Unexpected method in account-only fixture')
})

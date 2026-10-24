import { appendFileSync, writeFileSync } from 'node:fs'

writeFileSync(process.env.WORKSPACE_FIXTURE_PID, String(process.pid))
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end < 0) break
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    appendFileSync(process.env.WORKSPACE_FIXTURE_REQUESTS, `${JSON.stringify(request)}\n`)
    if (request.id === undefined) continue
    if (request.method === 'initialize') respond(request.id, { userAgent: 'fixture' })
    else if (request.method === 'thread/start') respond(request.id, {
      thread: { id: '01999999-1111-7111-8111-111111111111', modelProvider: request.params.modelProvider, model: request.params.model ?? 'gpt-fixture' },
      model: request.params.model ?? 'gpt-fixture', modelProvider: request.params.modelProvider
    })
    else respond(request.id, {})
  }
})
process.stdin.on('end', () => globalThis.setInterval(() => undefined, 1_000))
function respond(id, result) { process.stdout.write(`${JSON.stringify({ id, result })}\n`) }

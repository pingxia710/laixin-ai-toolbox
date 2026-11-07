import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const execFileAsync = promisify(execFile)
const files = [
  'sidecar/shared/connection-funnel.mjs', 'sidecar/shared/daemon-core.mjs', 'sidecar/shared/runtime-observation.mjs', 'sidecar/shared/entry-health.mjs',
  'sidecar/shared/restore.mjs', 'sidecar/shared/write-right-owner.mjs', 'app/main/tunnel/connection-attempt-queue.ts'
]

it('关键持久化路径不再使用共享固定 .tmp 文件名', () => {
  for (const file of files) {
    const source = readFileSync(`${root}/${file}`, 'utf8')
    expect(source, file).not.toMatch(/\$\{[^}]+\}\.tmp(?:['"`]|$)/m)
    expect(source, file).not.toContain('connection-verified.json.tmp')
    expect(source, file).not.toContain('.tmp-recovery`')
  }
})

it('两个守护进程并发写同一 state 时最终文件仍是完整 JSON 且不留临时文件', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/laixin-temp-race-`)
  const daemon = fileURLToPath(new URL('../../sidecar/mac/daemon-core.mjs', import.meta.url))
  const source = `import { writeState } from ${JSON.stringify(daemon)}; for (let i = 0; i < 100; i += 1) writeState(process.argv[1], { state: 'connected', i });`
  try {
    await Promise.all([1, 2].map(() => execFileAsync(process.execPath, ['--input-type=module', '-e', source, dataDir], { timeout: 10_000 })))
    const state = JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state?: string }
    expect(state.state).toBe('connected')
    expect(readdirSync(dataDir).filter((name) => name.includes('.tmp'))).toEqual([])
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

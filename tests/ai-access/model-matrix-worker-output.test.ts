import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { finishMatrixWorker, fixedMatrixWorkerEntry, fixedMatrixWorkerFailure } = require('../../scripts/model-matrix-worker-output.cjs') as {
  finishMatrixWorker: (service: { probeMatrix(): Promise<{ entries: readonly unknown[] }>; stop(): Promise<void> }, write: (line: string) => void, exit: (code: number) => void, afterReport?: (report: unknown) => Promise<void> | void) => Promise<unknown>
  fixedMatrixWorkerEntry: (entry: unknown) => string
  fixedMatrixWorkerFailure: (reason: unknown) => string
}

describe('真实矩阵 worker 的进程输出', () => {
  it('真实 Key 矩阵只做可信候选存在性检查，不调用会执行 PATH 命令的通用安装盘点', () => {
    const worker = readFileSync(join(process.cwd(), 'scripts', 'model-matrix-worker.cjs'), 'utf8')

    expect(worker).toContain('trustedCliInstalled')
    expect(worker).not.toMatch(new RegExp('\\bShellInventory\\s*\\('))
    expect(worker).not.toMatch(new RegExp('\\binventory\\.inspect\\s*\\('))
  })

  it('敏感路径与异常原文不进入 stdout 或 stderr 格式化输出', () => {
    const privatePath = '/private/customer/very-secret/keys.json'
    const privateError = `provider returned ${privatePath} and fixture-secret-key-1234567890`

    const entry = fixedMatrixWorkerEntry({ state: 'failed', provider: privatePath, shell: 'codex', code: privateError })
    const failure = fixedMatrixWorkerFailure(privateError)

    expect(entry).toBe('{"status":"failed","shell":"codex"}')
    expect(failure).toBe('{"status":"failed","reason":"matrix_failed"}')
    expect(`${entry}\n${failure}`).not.toContain(privatePath)
    expect(`${entry}\n${failure}`).not.toContain('fixture-secret-key')
  })

  it('异步矩阵保存未完成前不输出完成状态，也不退出 worker', async () => {
    let releaseProbe: () => void = () => undefined
    const reportReady = new Promise<void>(resolve => { releaseProbe = resolve })
    const output: string[] = []
    const exits: number[] = []
    const service = {
      probeMatrix: async () => {
        await reportReady
        return { entries: [{ state: 'passed', provider: 'deepseek', shell: 'codex' }] }
      },
      stop: async () => undefined
    }
    const pending = finishMatrixWorker(service, line => output.push(line), code => exits.push(code))

    await Promise.resolve()
    expect(output).toEqual([])
    expect(exits).toEqual([])
    releaseProbe()
    await pending
    expect(output).toEqual(['{"status":"passed","provider":"deepseek","shell":"codex"}', '{"status":"completed"}'])
    expect(exits).toEqual([0])
  })
})

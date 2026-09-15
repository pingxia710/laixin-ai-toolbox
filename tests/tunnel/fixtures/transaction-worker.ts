// 事务 worker(判据 13③④):测试先用 esbuild 打成单文件 mjs 再以 plain node 跑,
// 提供真实 SIGKILL 窗口。打到 stdout 的 PHASE 行是测试的 kill 信号点。
// 用法:
//   import --data-dir D --package P --pause-after-validation-ms N
//   apply  --data-dir D --pause-before-current-write-ms N | --pause-after-current-write-ms N
import { importConfig } from '../../../app/main/tunnel/import-service'
import { applyPending } from '../../../app/main/tunnel/transactions'
import { loadTrustContext, TRUST_LINES } from '../../../app/main/tunnel/trust'

const [command, ...rest] = process.argv.slice(2)
const flags: Record<string, string> = {}
for (let index = 0; index < rest.length; index += 2) {
  flags[
    rest[index].replace(/^--/, '').replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())
  ] = rest[index + 1]
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function pause(phase: string, ms: string | undefined): Promise<void> {
  if (ms === undefined) {
    return
  }
  process.stdout.write(`PHASE=${phase}\n`)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, Number.parseInt(ms, 10)))
}

async function main(): Promise<void> {
  if (command === 'import') {
    const outcome = await importConfig({
      dataDir: flags['dataDir'],
      picker: () => Promise.resolve(flags['package']),
      trust: loadTrustContext(process.env, { allowTestKeys: true }),
      now: () => Date.parse('2026-10-01T00:00:00Z'),
      sourceLineOf: (validated) => TRUST_LINES[validated.trust.tier],
      afterValidation: () => pause('AFTER_VALIDATION', flags['pauseAfterValidationMs'])
    })
    process.stdout.write(`OUTCOME=${JSON.stringify(outcome)}\n`)
    return
  }
  if (command === 'apply') {
    const outcome = applyPending(flags['dataDir'], {
      beforeCurrentWrite: () => {
        if (flags['pauseBeforeCurrentWriteMs'] !== undefined) {
          process.stdout.write('PHASE=BEFORE_CURRENT_WRITE\n')
          sleepSync(Number.parseInt(flags['pauseBeforeCurrentWriteMs'], 10))
        }
      },
      afterCurrentWrite: () => {
        if (flags['pauseAfterCurrentWriteMs'] !== undefined) {
          process.stdout.write('PHASE=AFTER_CURRENT_WRITE\n')
          sleepSync(Number.parseInt(flags['pauseAfterCurrentWriteMs'], 10))
        }
      }
    })
    process.stdout.write(`OUTCOME=${JSON.stringify(outcome)}\n`)
    return
  }
  process.stderr.write(`未知命令:${command}\n`)
  process.exit(64)
}

void main()

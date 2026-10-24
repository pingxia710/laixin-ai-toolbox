import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('../../sidecar/mac/bin/write-lock', import.meta.url))
const modulePath = fileURLToPath(new URL('../../sidecar/mac/macos-write-right.mjs', import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function run(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'mac-process-identity-'))
  roots.push(root)
  const script = `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = cp.execFileSync;
    const helper = ${JSON.stringify(helper)};
    const lockPath = ${JSON.stringify(join(root, 'owner.json'))};
    const legacy = original('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }
    }).trim();
    cp.execFileSync = (file, ...args) => {
      if (file === '/bin/ps' || file === 'ps') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    const { acquireWriteRight } = await import(${JSON.stringify(modulePath)});
    ${body}
  `
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20_000
  })) as Record<string, unknown>
}

describe.skipIf(process.platform !== 'darwin')('macOS ps 被禁止时的进程身份兼容', () => {
  it.each(['UTC', 'Asia/Shanghai', 'America/Los_Angeles'])('原生启动标识与旧版 ps 完全相同，时区 %s', (timezone) => {
    const options = { encoding: 'utf8' as const, env: { ...process.env, LC_ALL: 'C', TZ: timezone } }
    const expected = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], options).trim()
    expect(execFileSync(helper, ['--process-start', String(process.pid)], options).trim()).toBe(expected)
  })

  it('ps 返回 EPERM 时仍能真实取得、核验和交还写入权，重连不留旧席位', () => {
    expect(run(String.raw`
      const first = acquireWriteRight({ lockPath });
      if (first.acquired) first.assertHeld();
      const released = first.acquired && first.release();
      const second = acquireWriteRight({ lockPath });
      console.log(JSON.stringify({ acquired: first.acquired, released,
        reacquired: second.acquired, releasedAgain: second.acquired && second.release(),
        ownerRemaining: fs.existsSync(lockPath) }));
    `)).toEqual({ acquired: true, released: true, reacquired: true, releasedAgain: true, ownerRemaining: false })
  })

  it('ps 被拒绝时也不抢占活着的旧版持有者，旧席位字节不变', () => {
    expect(run(String.raw`
      const raw = JSON.stringify({ version: 1, pid: process.pid, startIdentity: legacy, token: 'a'.repeat(32) }) + '\n';
      fs.writeFileSync(lockPath, raw, { mode: 0o600 });
      const right = acquireWriteRight({ lockPath });
      console.log(JSON.stringify({ right, unchanged: fs.readFileSync(lockPath, 'utf8') === raw }));
    `)).toEqual({ right: { acquired: false, reason: 'held' }, unchanged: true })
  })

  it.each(['EPERM', 'ETIMEDOUT'])('原生查询也失败时拒绝写入且保留旧席位：%s', (code) => {
    expect(run(String.raw`
      const raw = JSON.stringify({ version: 1, pid: process.pid, startIdentity: legacy, token: 'b'.repeat(32) }) + '\n';
      fs.writeFileSync(lockPath, raw, { mode: 0o600 });
      const deniedPs = cp.execFileSync;
      cp.execFileSync = (file, args, ...rest) => {
        if (file === helper && args[0] === '--process-start') throw Object.assign(new Error('unavailable'), { code: ${JSON.stringify(code)} });
        return deniedPs(file, args, ...rest);
      };
      syncBuiltinESMExports();
      const right = acquireWriteRight({ lockPath });
      console.log(JSON.stringify({ right, unchanged: fs.readFileSync(lockPath, 'utf8') === raw }));
    `)).toEqual({ right: { acquired: false, reason: 'unavailable' }, unchanged: true })
  })

  it.each(['', '0', '-1', '1x', ' 1', '+1', '2147483648', '999999999999999999999999'])('异常 PID %j 不输出身份', (pid) => {
    const result = spawnSync(helper, ['--process-start', pid], { encoding: 'utf8' })
    expect(result.status).toBe(64)
    expect(result.stdout).toBe('')
  })

  it('不存在或其他用户的进程不可冒充同用户身份', () => {
    for (const pid of ['2147483647', '1']) {
      const result = spawnSync(helper, ['--process-start', pid], { encoding: 'utf8' })
      expect(result.status).toBe(74)
      expect(result.stdout).toBe('')
    }
  })

  it('进程身份查询不接受多余参数或执行附带命令', () => {
    expect(spawnSync(helper, ['--process-start', String(process.pid), '/usr/bin/true']).status).toBe(64)
  })
})

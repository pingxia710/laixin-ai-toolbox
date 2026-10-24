import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { missingSidecarComponents } from '../../app/main/tunnel/sidecar-path'

const helper = fileURLToPath(new URL('../../sidecar/mac/bin/write-lock', import.meta.url))
const modulePath = fileURLToPath(new URL('../../sidecar/mac/macos-write-right.mjs', import.meta.url))
const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'intel-write-lock-'))
  roots.push(root)
  const lock = join(root, '空 格.lock')
  writeFileSync(lock, '', { mode: 0o600 })
  return { root, lock }
}

describe.skipIf(process.platform !== 'darwin')('旧版 macOS 随包写锁', () => {
  it('组件缺失闸随 bin 目录变化失效，安装后丢失写锁组件也能发现', () => {
    const { root } = fixture()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    expect(missingSidecarComponents('macos', root)).toContain('bin/write-lock')
    const executable = join(bin, 'write-lock')
    writeFileSync(executable, '', { mode: 0o755 })
    expect(missingSidecarComponents('macos', root)).not.toContain('bin/write-lock')
    rmSync(executable)
    expect(missingSidecarComponents('macos', root)).toContain('bin/write-lock')
  })

  it('系统没有 lockf 时，真实写权仍能安全取得和交还', () => {
    const { root } = fixture()
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = cp.execFileSync;
      cp.execFileSync = (file, ...args) => {
        if (file === '/usr/bin/lockf') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return original(file, ...args);
      };
      syncBuiltinESMExports();
      const { acquireWriteRight } = await import(${JSON.stringify(modulePath)});
      const right = acquireWriteRight({lockPath: ${JSON.stringify(join(root, 'right.json'))}, dataDir: ${JSON.stringify(join(root, 'data'))}});
      console.log(JSON.stringify({ acquired: right.acquired, released: right.acquired && right.release() }));
    `
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })))
      .toEqual({ acquired: true, released: true })
  })

  it('随包包含 Intel 与 Apple Silicon、最低 macOS 12 的可执行文件', () => {
    expect(existsSync(helper)).toBe(true)
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', helper], { encoding: 'utf8' })
    expect(architectures).toContain('x86_64')
    expect(architectures).toContain('arm64')
    const loads = execFileSync('/usr/bin/otool', ['-arch', 'all', '-l', helper], { encoding: 'utf8' })
    expect(loads.match(/minos 12\.0/g)).toHaveLength(2)
  })

  it('exec 后保持同一把锁，杀死持有进程后内核自动交还', async () => {
    const { lock } = fixture()
    const child = spawn(helper, ['0', lock, process.execPath, '-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve())
      child.once('error', reject)
    })
    expect(spawnSync(helper, ['0', lock, '/usr/bin/true']).status).toBe(75)
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
    expect(spawnSync(helper, ['0', lock, '/usr/bin/true']).status).toBe(0)
  })

  it('拒绝符号链接和非私有锁文件，不执行写入程序', () => {
    const { root, lock } = fixture()
    const link = join(root, 'link')
    symlinkSync(lock, link)
    expect(spawnSync(helper, ['0', link, '/usr/bin/true']).status).toBe(74)
    chmodSync(lock, 0o644)
    expect(spawnSync(helper, ['0', lock, '/usr/bin/true']).status).toBe(74)
  })

  it('原样返回命令失败码，不将执行失败假报为取得写权', () => {
    const { lock } = fixture()
    expect(spawnSync(helper, ['0', lock, process.execPath, '-e', 'process.exit(42)']).status).toBe(42)
    expect(spawnSync(helper, ['0', lock, '/missing-laixin-command']).status).toBe(74)
  })
})

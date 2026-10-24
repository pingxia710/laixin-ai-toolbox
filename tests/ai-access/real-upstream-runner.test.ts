import { execFile as execFileCallback } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const runner = join(process.cwd(), 'scripts', 'verify-ai-route-real-upstream.mjs')

function officialHermesConsoleScript(): string {
  return [
    '#!/bin/sh',
    `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python3' "$0" "$@"`,
    "' '''",
    '# -*- coding: utf-8 -*-',
    'import sys',
    'from hermes_cli.main import main',
    'if __name__ == "__main__":',
    '    if sys.argv[0].endswith("-script.pyw"):',
    '        sys.argv[0] = sys.argv[0][:-11]',
    '    elif sys.argv[0].endswith(".exe"):',
    '        sys.argv[0] = sys.argv[0][:-4]',
    '    sys.exit(main())',
    ''
  ].join('\n')
}

describe('真实上游验收脚本', () => {
  it.skipIf(process.platform === 'win32')('拒绝临时伪造的 Codex 或 Claude 原生文件，绝不因文件魔数执行它', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-real-upstream-runner-private-'))
    const fakeNative = join(root, 'fake-native')
    const keyFile = join(root, 'keys.json')
    try {
      // Mach-O magic alone is not identity proof. This path is outside every fixed official
      // installation root, so the runner must reject it before a client process is spawned.
      await writeFile(fakeNative, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o700 })
      await chmod(fakeNative, 0o700)
      await writeFile(keyFile, JSON.stringify({ test: 'sk-isolated-not-a-real-provider-key-0123456789' }), { mode: 0o600 })

      for (const shell of ['codex', 'claude'] as const) {
        let result: { code?: number | string | null; stdout?: string; stderr?: string } | undefined
        try {
          await execFile(process.execPath, [
            runner, '--provider', 'deepseek', '--key-file', keyFile, '--key-field', 'test',
            '--shells', shell, `--${shell}-bin`, fakeNative
          ], { cwd: process.cwd(), timeout: 2_000 })
        } catch (error) { result = error as { code?: number | string | null; stdout?: string; stderr?: string } }

        expect(result?.code).toBe(2)
        expect(result?.stdout).toContain(`unsafe_${shell}_bin`)
        expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain(root)
        expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain('sk-isolated-not-a-real-provider-key')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('拒绝目录形状正确但经软链逃出的 Hermes 启动器', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-real-upstream-runner-'))
    const hermes = join(root, 'hermes-agent', 'venv', 'bin', 'hermes')
    const target = join(root, 'unknown-wrapper')
    const marker = join(root, 'wrapper-executed')
    const keyFile = join(root, 'keys.json')
    try {
      await mkdir(dirname(hermes), { recursive: true })
      await writeFile(target, `#!/bin/sh\n: > ${marker}\n`, { mode: 0o700 })
      await chmod(target, 0o700)
      await symlink(target, hermes)
      await writeFile(keyFile, JSON.stringify({ test: 'sk-isolated-not-a-real-provider-key-0123456789' }), { mode: 0o600 })

      let result: { code?: number | string | null; stdout?: string } | undefined
      try {
        await execFile(process.execPath, [
          runner, '--provider', 'deepseek', '--key-file', keyFile, '--key-field', 'test',
          '--shells', 'hermes', '--hermes-bin', hermes
        ], { cwd: process.cwd(), timeout: 2_000 })
      } catch (error) { result = error as { code?: number | string | null; stdout?: string } }

      expect(result?.code).toBe(2)
      expect(result?.stdout).toContain('unsafe_hermes_bin')
      await expect(access(marker)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('拒绝搬家目录中即使正文完全相同的 Hermes console-script，不能执行同目录 python3', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-real-upstream-runner-')))
    const hermes = join(root, 'customer', 'relocated-hermes', 'hermes-agent', 'venv', 'bin', 'hermes')
    const python = join(root, 'customer', 'relocated-hermes', 'hermes-agent', 'venv', 'bin', 'python3')
    const marker = join(root, 'relocated-python-executed')
    const keyFile = join(root, 'keys.json')
    try {
      await mkdir(dirname(hermes), { recursive: true })
      await writeFile(hermes, officialHermesConsoleScript(), { mode: 0o700 })
      await writeFile(python, `#!/bin/sh\n: > ${marker}\n`, { mode: 0o700 })
      await chmod(python, 0o700)
      await writeFile(keyFile, JSON.stringify({ test: 'sk-isolated-not-a-real-provider-key-0123456789' }), { mode: 0o600 })

      let result: { code?: number | string | null; stdout?: string; stderr?: string } | undefined
      try {
        await execFile(process.execPath, [
          runner, '--provider', 'deepseek', '--key-file', keyFile, '--key-field', 'test',
          '--shells', 'hermes', '--hermes-bin', hermes, '--cc-switch'
        ], { cwd: process.cwd(), timeout: 2_000 })
      } catch (error) { result = error as { code?: number | string | null; stdout?: string; stderr?: string } }

      expect(result?.code).toBe(2)
      expect(result?.stdout).toContain('unsafe_hermes_bin')
      await expect(access(marker)).rejects.toThrow()
      expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain(root)
      expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain('sk-isolated-not-a-real-provider-key')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('拒绝目录形状正确但正文不是 Hermes console-script 的 --hermes-bin', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-real-upstream-runner-')))
    const hermes = join(root, 'hermes-agent', 'venv', 'bin', 'hermes')
    const marker = join(root, 'wrapper-executed')
    const keyFile = join(root, 'keys.json')
    try {
      await mkdir(dirname(hermes), { recursive: true })
      // A matching shebang and directory shape alone must never make a customer-controlled
      // wrapper executable.
      await writeFile(hermes, `#!/bin/sh\n: > ${marker}\n`, { mode: 0o700 })
      await chmod(hermes, 0o700)
      await writeFile(keyFile, JSON.stringify({ test: 'sk-isolated-not-a-real-provider-key-0123456789' }), { mode: 0o600 })

      let result: { code?: number | string | null; stdout?: string } | undefined
      try {
        await execFile(process.execPath, [
          runner, '--provider', 'deepseek', '--key-file', keyFile, '--key-field', 'test',
          '--shells', 'hermes', '--hermes-bin', hermes
        ], { cwd: process.cwd(), timeout: 2_000 })
      } catch (error) { result = error as { code?: number | string | null; stdout?: string } }

      expect(result?.code).toBe(2)
      expect(result?.stdout).toContain('unsafe_hermes_bin')
      await expect(access(marker)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('不把调用终端伪造的 HOME 中 Claude 启动包装器当作原生验收程序', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-real-upstream-runner-private-'))
    const launcher = join(root, '.local', 'bin', 'claude')
    const keyFile = join(root, 'keys.json')
    try {
      await mkdir(dirname(launcher), { recursive: true })
      // A native-file prefix must not make the caller-controlled launcher location executable.
      await writeFile(launcher, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o700 })
      await chmod(launcher, 0o700)
      await writeFile(keyFile, JSON.stringify({ test: 'sk-isolated-not-a-real-provider-key-0123456789' }), { mode: 0o600 })

      let result: { code?: number | string | null; stdout?: string; stderr?: string } | undefined
      try {
        await execFile(process.execPath, [
          runner, '--provider', 'deepseek', '--key-file', keyFile, '--key-field', 'test',
          '--shells', 'claude', '--claude-bin', launcher
        ], { cwd: process.cwd(), timeout: 2_000, env: { ...process.env, HOME: root } })
      } catch (error) { result = error as { code?: number | string | null; stdout?: string; stderr?: string } }

      expect(result?.code).toBe(2)
      expect(result?.stdout).toContain('unsafe_claude_bin')
      expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain(root)
      expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain('sk-isolated-not-a-real-provider-key')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('只允许有明确 Kimi 姐妹入口证明的预期失败，不能把本机故障或任意产品组合变成绿灯', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-real-upstream-runner-private-'))
    const keyFile = join(root, 'keys.json')
    try {
      await writeFile(keyFile, JSON.stringify({ test: 'sk-isolated-not-a-real-provider-key-0123456789' }), { mode: 0o600 })
      for (const extra of [
        ['--provider', 'deepseek', '--expect-code', 'port_unavailable'],
        ['--provider', 'kimi', '--expect-code', 'key_product_mismatch'],
        ['--provider', 'kimi', '--expect-code', 'key_product_mismatch', '--expect-suggested-provider', 'zhipu']
      ]) {
        let result: { code?: number | string | null; stdout?: string; stderr?: string } | undefined
        try {
          await execFile(process.execPath, [
            runner, ...extra, '--key-file', keyFile, '--key-field', 'test'
          ], { cwd: process.cwd(), timeout: 2_000 })
        } catch (error) { result = error as { code?: number | string | null; stdout?: string; stderr?: string } }

        expect(result?.code).toBe(2)
        expect(result?.stdout).toContain('expected_provider_mismatch_invalid')
        expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain(root)
        expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain('sk-isolated-not-a-real-provider-key')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('在写任何隔离配置前拒绝不属于当前产品合同的 --model，且输出不回显模型路径或形似 Key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-real-upstream-runner-private-'))
    const keyFile = join(root, 'keys.json')
    const unsafeModel = `${root}/sk-private-model-like-key-0123456789`
    try {
      await writeFile(keyFile, JSON.stringify({ test: 'sk-isolated-not-a-real-provider-key-0123456789' }), { mode: 0o600 })
      let result: { code?: number | string | null; stdout?: string; stderr?: string } | undefined
      try {
        await execFile(process.execPath, [
          runner, '--provider', 'deepseek', '--key-file', keyFile, '--key-field', 'test',
          '--shells', 'codex', '--model', unsafeModel
        ], { cwd: process.cwd(), timeout: 2_000 })
      } catch (error) { result = error as { code?: number | string | null; stdout?: string; stderr?: string } }

      expect(result?.code).toBe(2)
      expect(result?.stdout).toContain('model_invalid')
      expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain(root)
      expect(`${result?.stdout ?? ''}${result?.stderr ?? ''}`).not.toContain('sk-private-model-like-key')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

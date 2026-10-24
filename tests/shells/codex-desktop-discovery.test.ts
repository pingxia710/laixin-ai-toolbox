import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import { trustedCliCommandCandidates, trustedCliExecutables } from '../../app/main/shells/inventory'
import { findCodexDesktopCommand, isCodexDesktopExecutable } from '../../app/main/codex-usage/runtime'
import { ApplicationLauncher } from '../../app/main/desktop/applications'

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  files: new Map<string, { header?: string; symlink?: boolean; resolved?: string }>()
}))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: fixture.read })
}))
vi.mock('node:fs/promises', () => ({
  access: vi.fn(), readFile: vi.fn(), readdir: async () => [],
  lstat: async (path: string) => {
    const file = fixture.files.get(path)
    if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { isFile: () => true, isSymbolicLink: () => file.symlink ?? false }
  },
  realpath: async (path: string) => fixture.files.get(path)?.resolved ?? path,
  open: async (path: string) => ({
    read: async (buffer: Buffer) => ({ bytesRead: Buffer.from(fixture.files.get(path)?.header ?? 'cffaedfe', 'hex').copy(buffer) }),
    close: async () => undefined
  })
}))

const packageRoot = 'D:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.0.0_x64__2p2nqsd0c76g0'
const packagedCli = `${packageRoot}\\app\\resources\\codex.exe`
const packageInfo = {
  Family: 'OpenAI.Codex_2p2nqsd0c76g0', AppId: 'App', Version: '26.915.0.0',
  InstallLocation: packageRoot, Executable: 'app\\Codex.exe'
}
const windowsHome = 'C:\\Users\\customer'

beforeEach(() => {
  fixture.files.clear()
  fixture.read.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('Codex Desktop 安装发现兼容性', () => {
  it.each(['codex', 'codex-cli/bin/codex', 'codex-cli/CodexCLI.app/Contents/MacOS/codex'])('发现 Mac 新旧包内原生文件 %s，不启动它', async relative => {
    const candidate = `/Applications/ChatGPT.app/Contents/Resources/${relative}`
    fixture.files.set(candidate, {})
    expect(await trustedCliCommandCandidates('codex', 'darwin', '/Users/customer', {})).toContain(candidate)
    expect(isCodexDesktopExecutable(candidate, 'darwin')).toBe(true)
    expect(await findCodexDesktopCommand('/Users/customer', 'darwin', {})).toEqual({ executable: candidate, args: ['app-server', '--listen', 'stdio://'] })
    expect(fixture.read).not.toHaveBeenCalled()
  })

  it('当前用户 Applications 的新布局也可发现', async () => {
    const candidate = '/Users/customer/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex'
    fixture.files.set(candidate, {})
    expect((await findCodexDesktopCommand('/Users/customer', 'darwin', {}))?.executable).toBe(candidate)
  })

  it('当前 Mac bin/codex 是脚本时跳过它，继续选择内层原生文件', async () => {
    const root = '/Applications/ChatGPT.app/Contents/Resources/codex-cli'
    fixture.files.set(`${root}/bin/codex`, { header: '23212f62' })
    fixture.files.set(`${root}/CodexCLI.app/Contents/MacOS/codex`, {})
    expect((await findCodexDesktopCommand('/Users/customer', 'darwin', {}))?.executable).toBe(`${root}/CodexCLI.app/Contents/MacOS/codex`)
    expect(fixture.read).not.toHaveBeenCalled()
  })

  it('Store 安装用官方包 manifest 定位 CLI，不运行 Desktop 主程序或 PATH alias', async () => {
    fixture.read.mockResolvedValue({ stdout: JSON.stringify(packageInfo), stderr: '' })
    fixture.files.set(packagedCli, { header: '4d5a9000' })
    expect(await trustedCliCommandCandidates('codex', 'win32', windowsHome, { PATH: 'C:\\wrappers' })).toContain(packagedCli)
    expect(isCodexDesktopExecutable(packagedCli, 'win32')).toBe(true)
    expect(await findCodexDesktopCommand(windowsHome, 'win32', {})).toEqual({ executable: packagedCli, args: ['app-server', '--listen', 'stdio://'] })
    expect(fixture.read.mock.calls.every(([command, args]) => command === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' && args[3].includes('Get-AppxPackage -Name OpenAI.Codex') && args[3].includes('Get-AppxPackageManifest'))).toBe(true)
    expect(fixture.read).toHaveBeenCalled()
  })

  it.each(['SystemRoot', 'SYSTEMROOT', 'systemroot'])('非 C 系统通过 %s 发现 Store CLI，不写死系统盘', async key => {
    fixture.read.mockImplementation(async command => {
      if (command !== 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') throw new Error('fixture missing system executable')
      return { stdout: JSON.stringify(packageInfo), stderr: '' }
    })
    fixture.files.set(packagedCli, { header: '4d5a9000' })
    expect((await findCodexDesktopCommand(windowsHome, 'win32', { [key]: 'D:\\WinNT' }))?.executable).toBe(packagedCli)
  })

  it('原有 Windows 应用启动入口在非 C 系统也使用同一系统 PowerShell', async () => {
    vi.stubEnv('SystemRoot', 'D:\\WinNT')
    const read = vi.fn(async command => {
      if (command !== 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') throw new Error('fixture missing system executable')
      return JSON.stringify(packageInfo)
    })
    const dispatch = vi.fn(async () => undefined)
    const launcher = new ApplicationLauncher(windowsHome, 'win32', async () => '', read, dispatch)
    await expect(launcher.open('codex')).resolves.toMatchObject({ opened: true })
    expect(dispatch).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'])
  })

  it.each(['relative', 'D:\\other\\..\\WinNT', '\\\\server\\Windows', 'D:\\WinNT\n'])('无效 SystemRoot %j 仍使用默认绝对系统工具路径', async SystemRoot => {
    fixture.read.mockResolvedValue({ stdout: JSON.stringify(packageInfo), stderr: '' })
    fixture.files.set(packagedCli, { header: '4d5a9000' })
    expect((await findCodexDesktopCommand(windowsHome, 'win32', { SystemRoot }))?.executable).toBe(packagedCli)
    expect(fixture.read.mock.calls[0][0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it.each([
    { Family: 'Other.Codex_2p2nqsd0c76g0' },
    { Family: 'OpenAI.Codex_aaaaaaaaaaaaa' },
    { InstallLocation: 'relative\\package' },
    { InstallLocation: '\\\\server\\package' },
    { Executable: '..\\outside\\Codex.exe' },
    { Executable: 'C:\\outside\\Codex.exe' },
    { Executable: 'app\\launcher.cmd' },
    { AppId: 'App;calc' }
  ])('未知身份或越出包目录的 manifest 不变成执行候选 %j', async override => {
    const standard = await trustedCliCommandCandidates('codex', 'win32', windowsHome, {})
    fixture.read.mockResolvedValue({ stdout: JSON.stringify({ ...packageInfo, ...override }), stderr: '' })
    fixture.files.set(packagedCli, { header: '4d5a9000' })
    expect(await trustedCliCommandCandidates('codex', 'win32', windowsHome, {})).toEqual(standard)
    expect(await findCodexDesktopCommand(windowsHome, 'win32', {})).toBeNull()
  })

  it.each(['missing', 'malformed', 'failed'])('Store 查询 %s 不影响传统安装', async state => {
    if (state === 'failed') fixture.read.mockRejectedValue(new Error('fixture appx unavailable'))
    else fixture.read.mockResolvedValue({ stdout: state === 'malformed' ? '{' : '', stderr: '' })
    const candidate = 'D:\\Local Data\\Programs\\Codex\\resources\\codex.exe'
    fixture.files.set(candidate, { header: '4d5a9000' })
    expect((await findCodexDesktopCommand(windowsHome, 'win32', { LOCALAPPDATA: 'D:\\Local Data' }))?.executable).toBe(candidate)
  })

  it.each([
    { symlink: true }, { resolved: '/elsewhere/codex' }, { header: '23212f62' }
  ])('新布局仍拒绝链接、重定向和脚本 %j', async details => {
    const candidate = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
    fixture.files.set(candidate, details)
    expect(await trustedCliExecutables('codex', 'darwin', '/Users/customer', {})).toEqual([])
  })

  it.each([{ symlink: true }, { resolved: 'C:\\wrappers\\codex.exe' }, { header: '23212f62' }])('Store 包内链接、重定向或脚本不能执行 %j', async details => {
    fixture.read.mockResolvedValue({ stdout: JSON.stringify(packageInfo), stderr: '' })
    fixture.files.set(packagedCli, details)
    expect(await findCodexDesktopCommand(windowsHome, 'win32', {})).toBeNull()
  })

  it('npm CLI、WindowsApps alias 和 Desktop 主程序都不当作包内 CLI', () => {
    for (const candidate of [
      'C:\\Users\\customer\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe',
      `${packageRoot}\\app\\Codex.exe`,
      'C:\\Users\\customer\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe'
    ]) expect(isCodexDesktopExecutable(candidate, 'win32')).toBe(false)
  })
})

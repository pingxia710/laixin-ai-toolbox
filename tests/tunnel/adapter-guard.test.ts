import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOGIN_ITEM_POLICY, macDaemonLaunch } from '../../app/main/tunnel/platform/mac'
import {
  WINDOWS_PLATFORM_CAPABILITIES,
  unsupportedWindowsCapability,
  windowsDaemonLaunch
} from '../../app/main/tunnel/platform/win'
import { daemonLaunchFor } from '../../app/main/tunnel/platform/launch'
import {
  missingSidecarComponents,
  platformForRuntime,
  resolveSidecarDir,
  sidecarComponents
} from '../../app/main/tunnel/sidecar-path'

const REAL_ADAPTER = fileURLToPath(new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url))
const REAL_WININET_ADAPTER = fileURLToPath(new URL('../../sidecar/win/adapter-wininet.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

describe('真实适配器守卫(判据 7)与平台原语', () => {
  it('未放行环境加载真实适配器 → 守卫拒绝(闸能响;闸被移除则本测试报红)', async () => {
    expect(process.env.TOOLBOX_REAL_NETWORK_ADAPTER).toBeUndefined()
    await expect(import(REAL_ADAPTER)).rejects.toThrowError(/REAL_ADAPTER_GUARD/)
    await expect(import(REAL_WININET_ADAPTER)).rejects.toThrowError(/REAL_ADAPTER_GUARD/)
  })

  it('整套测试与主进程代码里,放行钥匙只出现在 platform/{mac,win}.ts 与适配器本体', () => {
    const hits: string[] = []
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry)
        if (['node_modules', '.git', 'out', 'release'].includes(entry)) {
          continue
        }
        if (statSync(path).isDirectory()) {
          scan(path)
          continue
        }
        if (!/\.(ts|mjs|mts)$/.test(entry)) {
          continue
        }
        const source = readFileSync(path, 'utf8')
        if (source.includes('TOOLBOX_REAL_NETWORK_ADAPTER')) {
          hits.push(relative(REPO_ROOT, path))
        }
      }
    }
    scan(join(REPO_ROOT, 'app'))
    scan(join(REPO_ROOT, 'sidecar'))
    scan(join(REPO_ROOT, 'tests'))
    // 测试文件本身是闸的检验方,允许引用;生产代码只许 platform/{mac,win}.ts + 适配器本体。
    expect(hits.sort()).toEqual([
      'app/main/tunnel/platform/mac.ts',
      'app/main/tunnel/platform/win.ts',
      'sidecar/mac/adapter-networksetup.mjs',
      'sidecar/win/adapter-wininet.mjs',
      'tests/tunnel/adapter-guard.test.ts',
      // 守护常驻的描述文件必须把放行钥匙原样带上,否则常驻起来的守护写不了系统设置;这条用例就是在钉它。
      'tests/tunnel/resident-agent.test.ts',
      'tests/tunnel/system-adapters-reliability.test.ts',
      'tests/tunnel/win-adapter.test.ts',
      'tests/tunnel/win-daemon-entry.test.ts'
    ])
  })

  it('判据 11 包内定位:isPackaged 真 → resourcesPath;假 → 仓路径(两平台各自目录)', () => {
    const packaged = resolveSidecarDir({
      platform: 'macos',
      isPackaged: true,
      resourcesPath: '/Applications/来信AI工具箱.app/Contents/Resources',
      repoRoot: '/repo'
    })
    expect(packaged).toBe('/Applications/来信AI工具箱.app/Contents/Resources/sidecar/mac')

    const development = resolveSidecarDir({ platform: 'macos', isPackaged: false, resourcesPath: '/ignored', repoRoot: '/repo' })
    expect(development).toBe('/repo/sidecar/mac')

    const windows = resolveSidecarDir({ platform: 'windows', isPackaged: true, resourcesPath: '/r', repoRoot: '/repo' })
    expect(windows).toBe('/r/sidecar/win')
  })

  it('组件缺失可观察:缺文件时列出缺失清单(⛔ 静默)', () => {
    const sidecarDir = resolveSidecarDir({ platform: 'macos', isPackaged: false, resourcesPath: '', repoRoot: REPO_ROOT })
    expect(missingSidecarComponents('macos', sidecarDir)).toEqual([])
    expect(missingSidecarComponents('macos', '/nonexistent')).toEqual([
      'tunnel-daemon.mjs',
      'adapter-networksetup.mjs',
      'managed-adapter.mjs',
      'terminal-environment.mjs',
      'power-events.mjs',
      'ledger.mjs',
      'restore.mjs',
      'daemon-core.mjs',
      'routes.default.json',
      'local-bridge.mjs',
      'xray-runner.mjs',
      'vless-connector.mjs',
      'vless-settings.mjs',
      'instance-lock.mjs',
      'resident-integrity.mjs',
      'xray',
      'geoip.dat',
      'geosite.dat'
    ])
    expect(missingSidecarComponents('windows', '/nonexistent')).toEqual([
      'tunnel-daemon.mjs',
      'adapter-wininet.mjs',
      'managed-adapter.mjs',
      'terminal-environment.mjs',
      'wininet-settings.ps1',
      'power-events.mjs',
      'ledger.mjs',
      'restore.mjs',
      'daemon-core.mjs',      'routes.default.json',
      'local-bridge.mjs',
      'xray-runner.mjs',
      'vless-connector.mjs',
      'vless-settings.mjs',
      'instance-lock.mjs',
      'resident-integrity.mjs',
      'xray.exe',
      'geoip.dat',
      'geosite.dat'
    ])
  })

  it('运行平台解析:darwin → macos,win32 → windows,其余受控拒', () => {
    expect(platformForRuntime('darwin')).toBe('macos')
    expect(platformForRuntime('win32')).toBe('windows')
    expect(() => platformForRuntime('linux')).toThrowError(/TUNNEL_PLATFORM_UNSUPPORTED:linux/)
  })

  it('首版启动项策略:⛔ 注册任何开机启动项 / 登录项(契约项)', () => {
    expect(LOGIN_ITEM_POLICY).toBe('none')
  })

  it('platform/mac.ts 拼装的真实启动参数指向 sidecar 内组件', () => {
    const launch = macDaemonLaunch('/x/sidecar/mac')
    expect(launch.daemonPath).toBe('/x/sidecar/mac/tunnel-daemon.mjs')
    expect(launch.adapterPath).toBe('/x/sidecar/mac/managed-adapter.mjs')
    expect(launch.env.TOOLBOX_REAL_NETWORK_ADAPTER).toBe('1')
    expect(launch.env.TOOLBOX_REAL_TERMINAL_ENVIRONMENT).toBe('1')
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('platform/win.ts 拼装的真实启动参数指向 sidecar/win 组件,形态与 mac 侧同构', () => {
    const launch = windowsDaemonLaunch('/x/sidecar/win')
    expect(launch.daemonPath).toBe('/x/sidecar/win/tunnel-daemon.mjs')
    expect(launch.adapterPath).toBe('/x/sidecar/win/managed-adapter.mjs')
    expect(launch.env.TOOLBOX_REAL_NETWORK_ADAPTER).toBe('1')
    expect(launch.env.TOOLBOX_REAL_TERMINAL_ENVIRONMENT).toBe('1')
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')

    expect(daemonLaunchFor('windows', '/x/sidecar/win')).toEqual(launch)
    expect(daemonLaunchFor('macos', '/x/sidecar/mac').adapterPath).toBe('/x/sidecar/mac/managed-adapter.mjs')
  })

  it('平台能力标志:WinINET 按用户代理支持;WinHTTP / 服务 / 计划任务明确不支持(受控码 ⛔ 假成功)', () => {
    expect(WINDOWS_PLATFORM_CAPABILITIES.winInetUserProxy).toBe('supported')
    expect(unsupportedWindowsCapability('winHttpMachineProxy')).toEqual({
      code: 'PLATFORM_CAPABILITY_UNSUPPORTED',
      capability: 'winHttpMachineProxy'
    })
    expect(sidecarComponents('windows')).toContain('adapter-wininet.mjs')
  })
})

describe('组件缺失时给客户看什么', () => {
  it('给一句能照做的话 + 前几项线索，⛔ 把十几个文件名摊给客户；长度留在动作结果限长内', async () => {
    const { componentMissingMessage } = await import('../../app/main/tunnel/tunnel-service')
    const many = missingSidecarComponents('macos', '/nonexistent')
    expect(many.length).toBeGreaterThan(10)
    const text = componentMissingMessage(many)
    expect(text).toContain('组件缺失')
    expect(text).toContain('请安装完整的最新版工具箱')
    expect(text).toContain(`等 ${String(many.length)} 项`)
    // 客户看不懂也做不了的东西 ⛔ 摊给他：只留前三项当线索
    expect(text).not.toContain(many[5])
    // 动作结果 message 上限是 300；清单再长也不能把它顶过去（顶过去整个结果会被判非法）
    expect(text.length).toBeLessThanOrEqual(300)
    expect(componentMissingMessage(Array.from({ length: 200 }, (_, index) => `component-${String(index)}.mjs`)).length).toBeLessThanOrEqual(300)
    // 只缺一两项时不说「等 N 项」
    expect(componentMissingMessage(['xray'])).not.toContain('等 ')
  })
})

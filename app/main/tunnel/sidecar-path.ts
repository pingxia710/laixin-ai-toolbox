import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isPlatform, type Platform } from '../precheck/software-platform'
import { statSignature } from './paths'

interface SidecarPlatformSpec {
  readonly directory: string
  readonly components: readonly string[]
}

// 各平台 sidecar 目录与随包组件清单;缺失任何一项 = 「组件缺失」⛔ 静默起连接。
const SIDECAR_BY_PLATFORM: Record<Platform, SidecarPlatformSpec> = {
  macos: {
    directory: 'mac',
    components: ['tunnel-daemon.mjs', 'adapter-networksetup.mjs', 'managed-adapter.mjs', 'terminal-environment.mjs', 'power-events.mjs', 'ledger.mjs', 'restore.mjs', 'daemon-core.mjs', 'routes.default.json', 'local-bridge.mjs', 'xray-runner.mjs', 'vless-connector.mjs', 'vless-settings.mjs', 'instance-lock.mjs', 'resident-integrity.mjs']
  },
  windows: {
    directory: 'win',
    components: ['tunnel-daemon.mjs', 'adapter-wininet.mjs', 'managed-adapter.mjs', 'terminal-environment.mjs', 'wininet-settings.ps1', 'power-events.mjs', 'ledger.mjs', 'restore.mjs', 'daemon-core.mjs', 'routes.default.json', 'local-bridge.mjs', 'xray-runner.mjs', 'vless-connector.mjs', 'vless-settings.mjs', 'instance-lock.mjs', 'resident-integrity.mjs']
  }
}

// sidecar 包内定位(判据 11):打包态从 process.resourcesPath 定位,开发态从仓路径定位。
export interface SidecarLocationInput {
  readonly platform: Platform
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly repoRoot: string
}

export function resolveSidecarDir(input: SidecarLocationInput): string {
  const { directory } = SIDECAR_BY_PLATFORM[input.platform]
  return input.isPackaged
    ? join(input.resourcesPath, 'sidecar', directory)
    : join(input.repoRoot, 'sidecar', directory)
}

export function sidecarComponents(platform: Platform): readonly string[] {
  return SIDECAR_BY_PLATFORM[platform].components
}

// 随包 OpenSSH 是「按需」组件:只分配到 SSH 稳定版的配置才要求;VLESS(升级版)不依赖。
// 供应链核准的二进制放在 sidecar/win/bin/ssh.exe,缺失时按需闸拦下并如实展示,⛔ 静默起连接。
export function sshBinaryPath(sidecarDir: string): string {
  return join(sidecarDir, 'bin', 'ssh.exe')
}

export function sshBinaryPresent(platform: Platform, sidecarDir: string): boolean {
  return platform !== 'windows' || existsSync(sshBinaryPath(sidecarDir))
}

export interface SidecarComponentGateOptions {
  // 当前生效配置是否走 SSH 稳定版连接器(默认 false = 仅查脚本与内核等必备件)。
  readonly requireSshBinary?: boolean
}

// N-25 诊断计数:组件清单的真实 existsSync 探测次数(供测试断言读取节奏)。
let sidecarGateProbeCount = 0

export function sidecarGateProbes(): number {
  return sidecarGateProbeCount
}

// N-25:组件清单是随包安装的静态文件,探测结果按 (平台, 目录, 是否要求 ssh) 进程内缓存,
// 把状态轮询每轮 19+ 次 existsSync 降到几次 stat。失效仍只认盘面:键里带 sidecarDir、bin 与
// xray 内核目录的 mtime+size 签名——任何组件被放入/移除,所在目录 mtime 必变,缓存即翻新
// (会话内补装组件的闸重新判得准;⛔ TTL 时间窗)。缓存键含 sidecarDir,测试的独立目录天然隔离。
const componentGateCache = new Map<string, readonly string[]>()

// 缺失即「组件缺失」(判据 10 反证:去掉 extraResources 后 ⛔ 静默)。
// ssh.exe 只在 requireSshBinary 时计入缺失;一键诊断用 sshBinaryPresent 如实展示有无。
export function missingSidecarComponents(
  platform: Platform,
  sidecarDir: string,
  options: SidecarComponentGateOptions = {}
): string[] {
  const runtimeRoot = join(sidecarDir, '..', '..')
  const requireSsh = options.requireSshBinary === true
  const target = `${platform === 'macos' ? 'mac' : 'win'}-${process.arch}`
  const watchedDirs = [sidecarDir, sshBinaryPath(sidecarDir), join(runtimeRoot, 'xray'),
    join(runtimeRoot, 'vendor', 'xray', target)]
  const cacheKey = `${platform}\u0000${sidecarDir}\u0000${requireSsh ? 'ssh' : 'base'}\u0000${watchedDirs.map(statSignature).join(':')}`
  const cached = componentGateCache.get(cacheKey)
  if (cached !== undefined) return [...cached]
  const probe = (path: string): boolean => {
    sidecarGateProbeCount += 1
    return existsSync(path)
  }
  const missing = sidecarComponents(platform).filter((name) => !probe(join(sidecarDir, name)))
  const executable = platform === 'windows' ? 'xray.exe' : 'xray'
  for (const file of [executable, 'geoip.dat', 'geosite.dat']) {
    if (!probe(join(runtimeRoot, 'xray', file)) && !probe(join(runtimeRoot, 'vendor', 'xray', target, file))) missing.push(file)
  }
  if (platform === 'windows' && requireSsh && !probe(sshBinaryPath(sidecarDir))) {
    missing.push(join('bin', 'ssh.exe'))
  }
  componentGateCache.set(cacheKey, missing)
  return [...missing]
}

export function platformForRuntime(nodePlatform: NodeJS.Platform): Platform {
  const platform = nodePlatform === 'darwin' ? 'macos' : nodePlatform === 'win32' ? 'windows' : undefined
  if (!isPlatform(platform)) {
    throw new Error(`TUNNEL_PLATFORM_UNSUPPORTED:${nodePlatform}`)
  }
  return platform
}

import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { machine, release, totalmem } from 'node:os'
import type { DeviceFacts } from '../../customer-ops-types'

export interface DeviceReaders {
  systemVersion(): Promise<string>
  architecture(): Promise<string>
  memoryBytes(): Promise<number>
  availableDiskBytes(): Promise<number>
}

// Only these four local facts are collected. Paths, machine names and identifiers are not part of the payload.
export async function readDeviceFacts(platform: DeviceFacts['platform'], toolboxVersion: string, readers: DeviceReaders): Promise<DeviceFacts> {
  const bounded = (read: () => Promise<unknown>) => new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DEVICE_READ_TIMEOUT')), 3500)
    void Promise.resolve().then(read).then(resolve, reject).finally(() => clearTimeout(timer))
  })
  const values = await Promise.allSettled([
    bounded(() => readers.systemVersion()), bounded(() => readers.architecture()), bounded(() => readers.memoryBytes()), bounded(() => readers.availableDiskBytes())
  ])
  const [version, architecture, memory, disk] = values.map((value) => value.status === 'fulfilled' ? value.value : null)
  const bytes = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  return { platform, toolboxVersion,
    systemVersion: typeof version === 'string' && /^[A-Za-z0-9 ._()+-]{1,120}$/.test(version) ? version : null,
    architecture: architecture === 'arm64' || architecture === 'aarch64' ? 'arm64'
      : ['x86_64', 'x64', 'AMD64'].includes(String(architecture)) ? 'x86_64' : 'unknown',
    memoryBytes: bytes(memory), availableDiskBytes: bytes(disk) }
}

export function collectDeviceFacts(toolboxVersion: string, dataDirectory: string): Promise<DeviceFacts> {
  if (!['darwin', 'win32'].includes(process.platform)) return Promise.reject(new Error('DEVICE_PLATFORM_UNSUPPORTED'))
  return readDeviceFacts(process.platform === 'darwin' ? 'macos' : 'windows', toolboxVersion, {
    systemVersion: () => process.platform === 'win32' ? Promise.resolve(release()) : new Promise((resolve, reject) => {
      execFile('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout.trim())
      })
    }),
    architecture: async () => machine(),
    memoryBytes: async () => totalmem(),
    availableDiskBytes: async () => { const disk = await statfs(dataDirectory); return disk.bavail * disk.bsize }
  })
}

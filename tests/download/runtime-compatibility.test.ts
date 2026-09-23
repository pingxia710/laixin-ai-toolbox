import { describe, expect, it } from 'vitest'
import { canChooseLocalDownload, runtimeDownloadArchitecture } from '../../app/main/download/runtime-compatibility'
import type { DownloadResource } from '../../app/main/download/types'

const macArm64 = { type: 'download', platform: 'macos', architecture: 'arm64' } as DownloadResource
const macX64 = { type: 'download', platform: 'macos', architecture: 'x86_64' } as DownloadResource
const windowsX64 = { type: 'download', platform: 'windows', architecture: 'x86_64' } as DownloadResource

describe('本地 AI 安装包架构校验', () => {
  it('将 Node 的 Intel 架构映射为目录中的 x86_64', () => {
    expect(runtimeDownloadArchitecture('darwin', 'x64')).toBe('x86_64')
    expect(runtimeDownloadArchitecture('darwin', 'arm64')).toBe('arm64')
  })

  it('Intel Mac 只能导入 x86_64 的 macOS 安装包', () => {
    expect(canChooseLocalDownload({ platform: 'darwin', architecture: 'x64' }, macX64)).toBe(true)
    expect(canChooseLocalDownload({ platform: 'darwin', architecture: 'x64' }, macArm64)).toBe(false)
  })

  it('不同系统或 CPU 架构不能绕过本地导入入口', () => {
    expect(canChooseLocalDownload({ platform: 'darwin', architecture: 'arm64' }, macX64)).toBe(false)
    expect(canChooseLocalDownload({ platform: 'darwin', architecture: 'x64' }, windowsX64)).toBe(false)
  })
})

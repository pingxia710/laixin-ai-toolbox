import { open } from 'node:fs/promises'
import type { StoredDownloadTask } from './types'
import type { DownloadResource } from './types'
import type { DownloadArtifactInspector } from './types'

// Container shape only. DownloadManager additionally requires the exact approved SHA-256.
// A ZIP header alone is not MSIX identity or signature verification; Windows verifies the signature when installing.
export class WinArtifactInspector implements DownloadArtifactInspector {
  async inspect(input: Parameters<DownloadArtifactInspector['inspect']>[0]): Promise<Awaited<ReturnType<DownloadArtifactInspector['inspect']>>> {
    if (input.format !== 'exe' && input.format !== 'msix') {
      return { kind: 'not-installer', identity: null }
    }
    const handle = await open(input.artifactPath, 'r')
    try {
      const magic = Buffer.alloc(4)
      const { bytesRead } = await handle.read(magic, 0, 4, 0)
      const matches = input.format === 'msix'
        ? bytesRead === 4 && magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        : bytesRead >= 2 && magic.subarray(0, 2).toString('ascii') === 'MZ'
      if (!matches) {
        return { kind: 'not-installer', identity: null }
      }
      return { kind: 'installer', identity: null }
    } finally {
      await handle.close()
    }
  }
}

// MSIX opens Windows App Installer after re-verification; its Install button remains the customer's action.
export class WinInstallerHandoff {
  constructor(
    private readonly reveal: (filePath: string) => void = () => undefined,
    private readonly openPackage?: (filePath: string) => Promise<string>
  ) {}

  // 箭头属性:动作侧以方法引用直传,保住 this.reveal。
  handoff = async (task: StoredDownloadTask, resource: DownloadResource): Promise<string> => {
    if (resource.format === 'msix') {
      if (!this.openPackage) throw new Error('DOWNLOAD_HANDOFF_UNAVAILABLE')
      const error = await this.openPackage(task.artifactPath)
      if (error) throw new Error('WINDOWS_APP_INSTALLER_UNAVAILABLE')
      return '已打开 Windows 安装程序，请按提示安装 ChatGPT；安装结果请在下一步确认。'
    }
    if (resource.format !== 'exe') {
      return '请在下载目录中找到安装器，自行运行'
    }
    this.reveal(task.artifactPath)
    return '已在文件夹中选中安装器，请双击运行选中的文件'
  }
}

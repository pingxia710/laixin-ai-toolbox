// 批次元信息:导入提交时随批次目录落一份 import-meta.json(来源行 / 整包摘要 / 导入时刻),
// 供状态展示回读。凭据内容 ⛔ 进此文件。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { layout, writeFileAtomic } from './paths'
import { currentBatchId, pendingBatchId } from './transactions'

export interface ImportMeta {
  readonly accountId?: string
  readonly sourceLine: string
  readonly packageDigest: string
  readonly importedAt: string
}

export interface CurrentInfo {
  readonly accountId?: string
  readonly protocol: 'ssh-socks' | 'vless-reality'
  readonly verifyUrl?: string
  readonly verifyFallbackUrl?: string
  readonly batchId: string
  readonly configVersion: number
  readonly authorizationId: string
  readonly node: { readonly host: string; readonly port: number; readonly sshUser?: string }
  /** 隐藏多节点:这份授权带的所有入口(第一项即 `node`)。单节点包解析出来就是一项,上层不必分两条路走。 */
  readonly nodes: readonly { readonly host: string; readonly port: number; readonly credentialName: string; readonly verifyUrl?: string }[]
  readonly credentialName: string
  readonly expiresAt: string
  readonly sourceLine: string
}

export function writeImportMeta(dataDir: string, batchId: string, meta: ImportMeta): void {
  writeFileAtomic(join(layout.batchDir(dataDir, batchId), 'import-meta.json'), `${JSON.stringify(meta)}\n`)
}

// 多入口清单:包里写了就用包里的(第一项已在校验时确认与 node 同址),没写就是单节点。
// 每项的凭据文件缺省沿用主凭据——同一节点开多个端口时通常共用一份凭据。
function readNodeList(
  manifest: { node?: { host?: unknown; port?: unknown }; nodes?: unknown },
  credentialName: string
): CurrentInfo['nodes'] {
  const single = [{ host: String(manifest.node?.host), port: Number(manifest.node?.port), credentialName }]
  if (!Array.isArray(manifest.nodes) || manifest.nodes.length === 0) return single
  const parsed: { host: string; port: number; credentialName: string; verifyUrl?: string }[] = []
  for (const raw of manifest.nodes as { host?: unknown; port?: unknown; credentialFile?: unknown; verifyUrl?: unknown }[]) {
    if (typeof raw?.host !== 'string' || typeof raw.port !== 'number') return single
    parsed.push({
      host: raw.host, port: raw.port,
      credentialName: typeof raw.credentialFile === 'string' ? raw.credentialFile : credentialName,
      verifyUrl: typeof raw.verifyUrl === 'string' ? raw.verifyUrl : undefined
    })
  }
  return parsed
}

function readInfo(dataDir: string, batchId: string): CurrentInfo | undefined {
  const dir = layout.batchDir(dataDir, batchId)
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return undefined
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      protocol?: unknown
      verifyUrl?: unknown
      verifyFallbackUrl?: unknown
      configVersion?: unknown
      authorizationId?: unknown
      node?: { host?: unknown; port?: unknown; sshUser?: unknown }
      nodes?: unknown
      expiresAt?: unknown
      files?: Record<string, unknown>
    }
    if (
      typeof manifest.configVersion !== 'number' ||
      typeof manifest.authorizationId !== 'string' ||
      typeof manifest.node?.host !== 'string' ||
      typeof manifest.node.port !== 'number' ||
      (manifest.protocol !== 'vless-reality' && typeof manifest.node.sshUser !== 'string') ||
      typeof manifest.expiresAt !== 'string'
    ) {
      return undefined
    }
    const credentialName = Object.keys(manifest.files ?? {})
      .find((path) => path.startsWith('credentials/'))
      ?.slice('credentials/'.length)
    if (credentialName === undefined || credentialName.includes('/')) {
      return undefined
    }
    let sourceLine = ''
    let accountId: string | undefined
    const metaPath = join(dir, 'import-meta.json')
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { sourceLine?: unknown; accountId?: unknown }
      if (typeof meta.accountId === 'string') accountId = meta.accountId
      if (typeof meta.sourceLine === 'string') {
        sourceLine = meta.sourceLine
      }
    }
    return {
      accountId,
      protocol: manifest.protocol === 'vless-reality' ? 'vless-reality' : 'ssh-socks',
      verifyUrl: typeof manifest.verifyUrl === 'string' ? manifest.verifyUrl : undefined,
      verifyFallbackUrl: typeof manifest.verifyFallbackUrl === 'string' ? manifest.verifyFallbackUrl : undefined,
      batchId,
      configVersion: manifest.configVersion,
      authorizationId: manifest.authorizationId,
      node: { host: manifest.node.host, port: manifest.node.port, sshUser: typeof manifest.node.sshUser === 'string' ? manifest.node.sshUser : undefined },
      nodes: readNodeList(manifest, credentialName),
      credentialName,
      expiresAt: manifest.expiresAt,
      sourceLine
    }
  } catch {
    return undefined
  }
}

export function readCurrentInfo(dataDir: string): CurrentInfo | undefined {
  const batchId = currentBatchId(dataDir)
  return batchId === undefined ? undefined : readInfo(dataDir, batchId)
}

export function readPendingInfo(dataDir: string): CurrentInfo | undefined {
  const batchId = pendingBatchId(dataDir)
  return batchId === undefined ? undefined : readInfo(dataDir, batchId)
}

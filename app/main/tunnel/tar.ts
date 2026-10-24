// 配置包安全解包(判据 16):ustar 读取;含 ../、绝对路径、符号链接 / 硬链接、重名条目的包
// 在「写任何一个字节之前」整体拒绝。零依赖,支持 GNU longname('L')。
export interface TarEntry {
  readonly path: string
  readonly data: Buffer
}

export class UnsafePackageEntry extends Error {
  constructor(readonly detail: string) {
    super(`PACKAGE_ENTRY_UNSAFE:${detail}`)
    this.name = 'UnsafePackageEntry'
  }
}

const BLOCK = 512

export function parseTarEntries(content: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  const seen = new Set<string>()
  let offset = 0
  let pendingLongName: string | undefined

  while (offset + BLOCK <= content.length) {
    const header = content.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (header.every((byte) => byte === 0)) {
      break
    }
    const name = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156])
    const prefix = readString(header, 345, 155)
    const data = content.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (typeflag === '5') {
      continue // 目录条目:仅创建逻辑需要,内容由文件条目携带
    }
    if (typeflag !== '0' && typeflag !== '') {
      throw new UnsafePackageEntry(`不允许的条目类型 '${typeflag}':${name}`)
    }
    const fullName = pendingLongName ?? (prefix === '' ? name : `${prefix}/${name}`)
    pendingLongName = undefined
    assertSafeRelativePath(fullName)
    if (seen.has(fullName)) {
      throw new UnsafePackageEntry(`重名条目:${fullName}`)
    }
    seen.add(fullName)
    entries.push({ path: fullName, data })
  }
  return entries
}

export function assertSafeRelativePath(path: string): void {
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    throw new UnsafePackageEntry(`绝对路径:${path}`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new UnsafePackageEntry(`越界或空段路径:${path}`)
  }
  if (path.includes('\0')) {
    throw new UnsafePackageEntry(`含 NUL 的路径`)
  }
}

function readString(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length)
  const nul = raw.indexOf(0)
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8')
}

function readOctal(header: Buffer, start: number, length: number): number {
  const text = readString(header, start, length).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

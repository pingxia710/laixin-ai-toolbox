// 测试用 ustar 写入器:可构造恶意条目(符号链接 / 越界路径 / 绝对路径 / 重名)。
import type { PackageEntry } from '../../../app/main/tunnel/package-format'

export interface TarSpecEntry {
  readonly name: string
  readonly data: Buffer
  readonly typeflag?: string // 缺省 '0';'2' = 符号链接(恶意 fixture)
}

const BLOCK = 512

export function writeTar(entries: readonly TarSpecEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    chunks.push(headerBlock(entry))
    chunks.push(entry.data)
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(chunks)
}

export function tarFromPackageEntries(entries: readonly PackageEntry[]): Buffer {
  return writeTar(entries.map((entry) => ({ name: entry.path, data: entry.data })))
}

function headerBlock(entry: TarSpecEntry): Buffer {
  const header = Buffer.alloc(BLOCK)
  header.write(entry.name, 0, 'utf8')
  header.write('0000644\0', 100, 'utf8')
  header.write('0000000\0', 108, 'utf8')
  header.write('0000000\0', 116, 'utf8')
  header.write(entry.data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
  header.write('00000000000\0', 136, 'utf8')
  header.write('        ', 148, 'utf8') // checksum 先填空格
  header.write(entry.typeflag ?? '0', 156, 'utf8')
  header.write('ustar\0', 257, 'utf8')
  let checksum = 0
  for (const byte of header) {
    checksum += byte
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
  return header
}

import { open } from 'node:fs/promises'

// macOS unzip converts unflagged UTF-8 names using a legacy encoding. Read the central
// directory bytes directly so a Chinese app name is validated before ditto extracts it.
export async function updateArchivePaths(path: string): Promise<string[]> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const tail = Buffer.alloc(Math.min(size, 65_557))
    if ((await file.read(tail, 0, tail.length, size - tail.length)).bytesRead !== tail.length) throw new Error('UPDATE_ARCHIVE_INVALID')
    const end = tail.lastIndexOf(Buffer.from('504b0506', 'hex'))
    if (end < 0 || end + 22 > tail.length || end + 22 + tail.readUInt16LE(end + 20) !== tail.length ||
      tail.readUInt32LE(end + 4) !== 0 || tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)) throw new Error('UPDATE_ARCHIVE_INVALID')
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16)
    if (!count || count === 65535 || length > 8 * 1024 ** 2 || offset + length > size - tail.length + end) throw new Error('UPDATE_ARCHIVE_INVALID')
    const entries = Buffer.alloc(length)
    if ((await file.read(entries, 0, length, offset)).bytesRead !== length) throw new Error('UPDATE_ARCHIVE_INVALID')
    const names: string[] = []; let position = 0
    for (let index = 0; index < count; index++) {
      if (position + 46 > entries.length || entries.readUInt32LE(position) !== 0x02014b50) throw new Error('UPDATE_ARCHIVE_INVALID')
      const nameLength = entries.readUInt16LE(position + 28)
      const next = position + 46 + nameLength + entries.readUInt16LE(position + 30) + entries.readUInt16LE(position + 32)
      if (!nameLength || next > entries.length) throw new Error('UPDATE_ARCHIVE_INVALID')
      const raw = entries.subarray(position + 46, position + 46 + nameLength), name = raw.toString('utf8')
      if (!Buffer.from(name).equals(raw) || name.includes('\0') || name.includes('\\')) throw new Error('UPDATE_ARCHIVE_INVALID')
      names.push(name); position = next
    }
    if (position !== entries.length) throw new Error('UPDATE_ARCHIVE_INVALID')
    return names
  } finally { await file.close() }
}

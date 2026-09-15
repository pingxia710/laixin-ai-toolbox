interface VersionSpec {
  readonly version: number
  readonly dataCodewords: number
  readonly errorCorrectionCodewords: number
}

const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, dataCodewords: 19, errorCorrectionCodewords: 7 },
  { version: 2, dataCodewords: 34, errorCorrectionCodewords: 10 },
  { version: 3, dataCodewords: 55, errorCorrectionCodewords: 15 },
  { version: 4, dataCodewords: 80, errorCorrectionCodewords: 20 },
  { version: 5, dataCodewords: 108, errorCorrectionCodewords: 26 },
  { version: 6, dataCodewords: 136, errorCorrectionCodewords: 36 }
]

export interface LocalQrCode {
  readonly modules: readonly (readonly boolean[])[]
  readonly functionModules: readonly (readonly boolean[])[]
  readonly version: number
}

export function createLocalQrCode(value: string): LocalQrCode {
  const bytes = new TextEncoder().encode(value)
  const spec = VERSION_SPECS.find((candidate) => bytes.length <= byteCapacity(candidate))
  if (spec === undefined) {
    throw new Error('SUPPORT_CONTACT_QR_TOO_LONG')
  }
  const codewords = makeCodewords(bytes, spec)
  const base = createBaseMatrix(spec.version)
  let best: LocalQrCode | undefined
  let bestPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = base.modules.map((row) => [...row])
    drawFormatBits(modules, base.functionModules, mask)
    drawCodewords(modules, base.functionModules, codewords, mask)
    const candidate: LocalQrCode = { modules, functionModules: base.functionModules, version: spec.version }
    const penalty = maskPenalty(modules)
    if (penalty < bestPenalty) {
      best = candidate
      bestPenalty = penalty
    }
  }
  if (best === undefined) {
    throw new Error('SUPPORT_CONTACT_QR_BUILD_FAILED')
  }
  return best
}

export function decodeLocalQrCode(code: LocalQrCode): string {
  const formatBits = readFormatBits(code.modules)
  const rawFormat = formatBits ^ 0x5412
  const mask = (rawFormat >>> 10) & 0b111
  if (!hasValidFormat(rawFormat)) {
    throw new Error('SUPPORT_CONTACT_QR_FORMAT_INVALID')
  }
  const spec = VERSION_SPECS.find((candidate) => candidate.version === code.version)
  if (spec === undefined) {
    throw new Error('SUPPORT_CONTACT_QR_VERSION_INVALID')
  }
  const bits = readDataBits(code.modules, code.functionModules, mask, codewordsLength(spec) * 8)
  const codewords = bytesFromBits(bits)
  const data = codewords.slice(0, spec.dataCodewords)
  const errorCorrection = codewords.slice(spec.dataCodewords)
  if (!equalBytes(errorCorrection, reedSolomonRemainder(data, spec.errorCorrectionCodewords))) {
    throw new Error('SUPPORT_CONTACT_QR_ECC_INVALID')
  }
  const reader = new BitReader(data)
  if (reader.read(4) !== 0b0100) {
    throw new Error('SUPPORT_CONTACT_QR_MODE_INVALID')
  }
  const byteLength = reader.read(8)
  const payload = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    payload[index] = reader.read(8)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(payload)
}

function byteCapacity(spec: VersionSpec): number {
  return Math.floor((spec.dataCodewords * 8 - 12) / 8)
}

function makeCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const writer = new BitWriter()
  writer.write(0b0100, 4)
  writer.write(bytes.length, 8)
  for (const byte of bytes) {
    writer.write(byte, 8)
  }
  writer.write(0, Math.min(4, spec.dataCodewords * 8 - writer.length))
  writer.padToByte()
  const data = writer.toBytes()
  const padded = new Uint8Array(spec.dataCodewords)
  padded.set(data)
  for (let index = data.length; index < padded.length; index += 1) {
    padded[index] = index % 2 === data.length % 2 ? 0xec : 0x11
  }
  const errorCorrection = reedSolomonRemainder(padded, spec.errorCorrectionCodewords)
  return concatBytes(padded, errorCorrection)
}

function createBaseMatrix(version: number): { modules: boolean[][]; functionModules: boolean[][] } {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const functionModules = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return
    }
    modules[y][x] = dark
    functionModules[y][x] = true
  }
  drawFinder(set, 0, 0)
  drawFinder(set, size - 7, 0)
  drawFinder(set, 0, size - 7)
  for (let index = 8; index < size - 8; index += 1) {
    set(6, index, index % 2 === 0)
    set(index, 6, index % 2 === 0)
  }
  for (const x of alignmentCenters(version)) {
    for (const y of alignmentCenters(version)) {
      if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) {
        continue
      }
      drawAlignment(set, x, y)
    }
  }
  drawFormatBits(modules, functionModules, 0)
  return { modules, functionModules }
}

function drawFinder(set: (x: number, y: number, dark: boolean) => void, x: number, y: number): void {
  for (let deltaY = -1; deltaY <= 7; deltaY += 1) {
    for (let deltaX = -1; deltaX <= 7; deltaX += 1) {
      const inBox = deltaX >= 0 && deltaX <= 6 && deltaY >= 0 && deltaY <= 6
      const distance = Math.max(Math.abs(deltaX - 3), Math.abs(deltaY - 3))
      set(x + deltaX, y + deltaY, inBox && (distance !== 1 && distance !== 2))
    }
  }
}

function drawAlignment(set: (x: number, y: number, dark: boolean) => void, x: number, y: number): void {
  for (let deltaY = -2; deltaY <= 2; deltaY += 1) {
    for (let deltaX = -2; deltaX <= 2; deltaX += 1) {
      const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY))
      set(x + deltaX, y + deltaY, distance !== 1)
    }
  }
}

function alignmentCenters(version: number): readonly number[] {
  return version === 1 ? [] : [6, version * 4 + 10]
}

function drawFormatBits(modules: boolean[][], functionModules: boolean[][], mask: number): void {
  const size = modules.length
  const value = formatBits(mask)
  const set = (x: number, y: number, dark: boolean): void => {
    modules[y][x] = dark
    functionModules[y][x] = true
  }
  for (let index = 0; index <= 5; index += 1) {
    set(8, index, bit(value, index))
  }
  set(8, 7, bit(value, 6))
  set(8, 8, bit(value, 7))
  set(7, 8, bit(value, 8))
  for (let index = 9; index < 15; index += 1) {
    set(14 - index, 8, bit(value, index))
  }
  for (let index = 0; index < 8; index += 1) {
    set(size - 1 - index, 8, bit(value, index))
  }
  for (let index = 8; index < 15; index += 1) {
    set(8, size - 15 + index, bit(value, index))
  }
  set(8, size - 8, true)
}

function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask
  const codeword = data << 10
  let remainder = codeword
  for (let index = 14; index >= 10; index -= 1) {
    if (bit(remainder, index)) {
      remainder ^= 0x537 << (index - 10)
    }
  }
  return (codeword | remainder) ^ 0x5412
}

function hasValidFormat(value: number): boolean {
  let remainder = value
  for (let index = 14; index >= 10; index -= 1) {
    if (bit(remainder, index)) {
      remainder ^= 0x537 << (index - 10)
    }
  }
  return remainder === 0 && value >>> 13 === 0b01
}

function drawCodewords(modules: boolean[][], functionModules: boolean[][], codewords: Uint8Array, mask: number): void {
  const size = modules.length
  let bitIndex = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5
    }
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical
      for (let x = right; x >= right - 1; x -= 1) {
        if (functionModules[y][x]) {
          continue
        }
        const codewordBit = bitIndex < codewords.length * 8 ? bit(codewords[Math.floor(bitIndex / 8)], 7 - (bitIndex % 8)) : false
        modules[y][x] = codewordBit !== maskBit(mask, x, y)
        bitIndex += 1
      }
    }
  }
}

function readDataBits(modules: readonly (readonly boolean[])[], functionModules: readonly (readonly boolean[])[], mask: number, length: number): boolean[] {
  const size = modules.length
  const result: boolean[] = []
  for (let right = size - 1; right >= 1 && result.length < length; right -= 2) {
    if (right === 6) {
      right = 5
    }
    for (let vertical = 0; vertical < size && result.length < length; vertical += 1) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical
      for (let x = right; x >= right - 1 && result.length < length; x -= 1) {
        if (!functionModules[y][x]) {
          result.push(modules[y][x] !== maskBit(mask, x, y))
        }
      }
    }
  }
  return result
}

function readFormatBits(modules: readonly (readonly boolean[])[]): number {
  let value = 0
  for (let index = 0; index <= 5; index += 1) {
    value |= Number(modules[index][8]) << index
  }
  value |= Number(modules[7][8]) << 6
  value |= Number(modules[8][8]) << 7
  value |= Number(modules[8][7]) << 8
  for (let index = 9; index < 15; index += 1) {
    value |= Number(modules[8][14 - index]) << index
  }
  return value
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5:
      return (x * y) % 2 + (x * y) % 3 === 0
    case 6:
      return ((x * y) % 2 + (x * y) % 3) % 2 === 0
    case 7:
      return ((x * y) % 3 + (x + y) % 2) % 2 === 0
    default:
      throw new Error('SUPPORT_CONTACT_QR_MASK_INVALID')
  }
}

function maskPenalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length
  let penalty = 0
  for (const row of modules) {
    penalty += runPenalty(row)
  }
  for (let x = 0; x < size; x += 1) {
    penalty += runPenalty(modules.map((row) => row[x]))
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      if (modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) {
        penalty += 3
      }
    }
  }
  const dark = modules.flat().filter(Boolean).length
  penalty += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  return penalty
}

function runPenalty(line: readonly boolean[]): number {
  let penalty = 0
  let run = 1
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === line[index - 1]) {
      run += 1
    } else {
      penalty += run >= 5 ? run - 2 : 0
      run = 1
    }
  }
  return penalty + (run >= 5 ? run - 2 : 0)
}

function reedSolomonRemainder(data: Uint8Array, degree: number): Uint8Array {
  let divisor = new Uint8Array([1])
  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(divisor.length + 1)
    for (let coefficient = 0; coefficient < divisor.length; coefficient += 1) {
      next[coefficient] ^= divisor[coefficient]
      next[coefficient + 1] ^= multiplyGalois(divisor[coefficient], powerGalois(2, index))
    }
    divisor = next
  }
  const remainder = new Uint8Array(degree)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[degree - 1] = 0
    for (let index = 0; index < degree; index += 1) {
      remainder[index] ^= multiplyGalois(divisor[index + 1], factor)
    }
  }
  return remainder
}

function multiplyGalois(left: number, right: number): number {
  let result = 0
  let value = left
  let multiplier = right
  while (multiplier > 0) {
    if ((multiplier & 1) !== 0) {
      result ^= value
    }
    value = (value << 1) ^ ((value >>> 7) * 0x11d)
    multiplier >>>= 1
  }
  return result
}

function powerGalois(value: number, exponent: number): number {
  let result = 1
  for (let index = 0; index < exponent; index += 1) {
    result = multiplyGalois(result, value)
  }
  return result
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

function codewordsLength(spec: VersionSpec): number {
  return spec.dataCodewords + spec.errorCorrectionCodewords
}

function bytesFromBits(bits: readonly boolean[]): Uint8Array {
  const bytes = new Uint8Array(bits.length / 8)
  for (let index = 0; index < bits.length; index += 1) {
    bytes[Math.floor(index / 8)] |= Number(bits[index]) << (7 - (index % 8))
  }
  return bytes
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class BitWriter {
  private readonly bits: boolean[] = []

  get length(): number {
    return this.bits.length
  }

  write(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push(bit(value, index))
    }
  }

  padToByte(): void {
    while (this.bits.length % 8 !== 0) {
      this.bits.push(false)
    }
  }

  toBytes(): Uint8Array {
    return bytesFromBits(this.bits)
  }
}

class BitReader {
  private position = 0

  constructor(private readonly bytes: Uint8Array) {}

  read(length: number): number {
    if (this.position + length > this.bytes.length * 8) {
      throw new Error('SUPPORT_CONTACT_QR_DATA_TRUNCATED')
    }
    let result = 0
    for (let index = 0; index < length; index += 1) {
      result = (result << 1) | Number(bit(this.bytes[Math.floor(this.position / 8)], 7 - (this.position % 8)))
      this.position += 1
    }
    return result
  }
}

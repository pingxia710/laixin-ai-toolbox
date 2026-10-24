import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('来信品牌素材', () => {
  it('使用保留透明通道的原图裁切，不依赖用户下载目录', () => {
    const png = readFileSync('app/renderer/src/assets/brand/laixin-icon.png')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([336, 338])
    expect(png[25]).toBe(6)
    const html = readFileSync('app/renderer/index.html', 'utf8')
    expect(html).toContain('src="./src/assets/brand/laixin-icon.png"')
    expect(html).toContain('来信 AI 工具箱')
    expect(html).not.toContain('/Users/')
  })

  it('双端打包指向有效的新品牌图标', () => {
    const { build } = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(build.mac.icon).toBe('build/laixin-icon.icns')
    expect(build.win.icon).toBe('build/laixin-icon.ico')
    const icns = readFileSync(build.mac.icon)
    expect(icns.subarray(0, 4).toString()).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const ico = readFileSync(build.win.icon)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(7)
    for (let index = 0; index < 7; index++) {
      const entry = 6 + index * 16
      const size = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(offset + size).toBeLessThanOrEqual(ico.length)
      expect(ico.subarray(offset + 1, offset + 4).toString()).toBe('PNG')
    }
  })
})

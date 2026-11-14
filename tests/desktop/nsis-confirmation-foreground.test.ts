import { expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)

it('Windows 构建只给默认卸载确认框加前景标志，仍走默认签名脚本', () => {
  const config = require('../../package.json') as { build: { afterPack?: string; nsis: { script?: string } } }
  expect(config.build.afterPack).toBe('./build/foreground-uninstall-confirmation.cjs')
  expect(config.build.nsis.script).toBeUndefined()
  const { patchTemplate, prepareIsolatedTemplate } = require('../../build/foreground-uninstall-confirmation.cjs') as {
    patchTemplate: (path: string, version: string) => boolean
    prepareIsolatedTemplate: (dir: string, version: string, util: { nsisTemplatesDir: string }) => string
  }
  const templatePath = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/uninstaller.nsh')
  const before = 'MessageBox MB_OKCANCEL "$(areYouSureToUninstall)" IDOK +2'
  const after = 'MessageBox MB_OKCANCEL|MB_TOPMOST|MB_SETFOREGROUND "$(areYouSureToUninstall)" IDOK +2'
  const source = readFileSync(templatePath, 'utf8')
  expect(createHash('sha256').update(source).digest('hex')).toBe('9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c')
  const root = mkdtempSync(join(tmpdir(), 'laixin-nsis-confirm-'))
  const copy = join(root, 'uninstaller.nsh')
  try {
    writeFileSync(copy, source)
    expect(patchTemplate(copy, '26.15.3')).toBe(true)
    const patched = readFileSync(copy, 'utf8')
    expect(patched).toBe(source.replace(before, after))
    expect(patchTemplate(copy, '26.15.3')).toBe(false)
    expect(readFileSync(copy, 'utf8')).toBe(patched)
    const sourceDir = join(root, 'source')
    mkdirSync(sourceDir)
    mkdirSync(join(sourceDir, 'include'))
    cpSync(templatePath, join(sourceDir, 'uninstaller.nsh'))
    const installUtil = join(dirname(templatePath), 'include', 'installUtil.nsh')
    cpSync(installUtil, join(sourceDir, 'include', 'installUtil.nsh'))
    writeFileSync(join(sourceDir, 'installer.nsi'), 'original installer')
    const util = { nsisTemplatesDir: sourceDir }
    const isolatedDir = prepareIsolatedTemplate(sourceDir, '26.15.3', util)
    expect(isolatedDir).not.toBe(sourceDir)
    expect(util.nsisTemplatesDir).toBe(isolatedDir)
    expect(readFileSync(join(isolatedDir, 'uninstaller.nsh'), 'utf8')).toBe(patched)
    expect(readFileSync(join(isolatedDir, 'installer.nsi'), 'utf8')).toBe('original installer')
    expect(readFileSync(join(isolatedDir, 'include', 'installUtil.nsh'), 'utf8')).toContain('!insertmacro useLaixinCompatibleUninstaller')
    expect(readFileSync(join(sourceDir, 'include', 'installUtil.nsh'), 'utf8')).toBe(readFileSync(installUtil, 'utf8'))
    expect(readFileSync(join(sourceDir, 'uninstaller.nsh'), 'utf8')).toBe(source)
    expect(readFileSync(templatePath, 'utf8')).toBe(source)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('仅在隔离的已锁定安装模板中接入旧版兼容，模板漂移时拒绝构建', () => {
  const { patchLegacyTemplate } = require('../../build/foreground-uninstall-confirmation.cjs') as {
    patchLegacyTemplate: (path: string, version: string) => boolean
  }
  const templatePath = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include/installUtil.nsh')
  const source = readFileSync(templatePath, 'utf8')
  const needle = '  StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\old-uninstaller.exe"'
  const root = mkdtempSync(join(tmpdir(), 'laixin-nsis-legacy-'))
  const copy = join(root, 'installUtil.nsh')
  try {
    writeFileSync(copy, source)
    expect(patchLegacyTemplate(copy, '26.15.3')).toBe(true)
    const patched = source.replace(needle, `  !insertmacro useLaixinCompatibleUninstaller\n${needle}`)
    expect(readFileSync(copy, 'utf8')).toBe(patched)
    expect(patchLegacyTemplate(copy, '26.15.3')).toBe(false)
    writeFileSync(copy, `${source}\n; unexpected change`)
    expect(() => patchLegacyTemplate(copy, '26.15.3')).toThrow(/安装模板/)
    expect(() => patchLegacyTemplate(copy, '26.15.4')).toThrow(/electron-builder/)
    expect(readFileSync(templatePath, 'utf8')).toBe(source)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('依赖版本或确认框模板漂移时中止构建，不静默生成未知卸载器', () => {
  const { patchTemplate, prepareIsolatedTemplate } = require('../../build/foreground-uninstall-confirmation.cjs') as {
    patchTemplate: (path: string, version: string) => boolean
    prepareIsolatedTemplate: (dir: string, version: string, util: { nsisTemplatesDir: string }) => string
  }
  const root = mkdtempSync(join(tmpdir(), 'laixin-nsis-confirm-drift-'))
  const copy = join(root, 'uninstaller.nsh')
  try {
    writeFileSync(copy, 'Function un.onInit\nMessageBox MB_OK "other"\nFunctionEnd\n')
    expect(() => patchTemplate(copy, '26.15.3')).toThrow(/确认框模板/)
    expect(() => patchTemplate(copy, '26.15.4')).toThrow(/electron-builder/)
    const sourceDir = join(root, 'source')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'uninstaller.nsh'), 'already modified')
    expect(() => prepareIsolatedTemplate(sourceDir, '26.15.3', { nsisTemplatesDir: sourceDir })).toThrow(/原始模板已改变/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

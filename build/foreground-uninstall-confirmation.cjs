// electron-builder 26.15.3 signs its generated uninstaller only when the default NSIS script is used.
// Its include hook runs after the confirmation dialog, so use an isolated copy of its locked NSIS templates.
const { createHash, randomUUID } = require('node:crypto')
const { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')

const before = 'MessageBox MB_OKCANCEL "$(areYouSureToUninstall)" IDOK +2'
const after = 'MessageBox MB_OKCANCEL|MB_TOPMOST|MB_SETFOREGROUND "$(areYouSureToUninstall)" IDOK +2'
const originalDigest = '9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c'
const patchedDigest = 'bf52b1c63bf1e9f8e4d26c57fe98996f1edbc95539a0e40d119f9d378d40b2e8'
const digest = (content) => createHash('sha256').update(content).digest('hex')
let prepared

function patchTemplate(path, version) {
  if (version !== '26.15.3') throw new Error(`electron-builder 版本变化：${version}；先复核 NSIS 卸载确认框与签名流程`)
  const content = readFileSync(path)
  const currentDigest = digest(content)
  if (currentDigest === patchedDigest) return false
  if (currentDigest !== originalDigest) throw new Error('NSIS 卸载确认框模板与锁定版本不一致，拒绝生成未知卸载器')
  const source = content.toString('utf8')
  if (source.split(before).length !== 2) throw new Error('NSIS 卸载确认框模板缺少唯一默认指令')
  const patched = source.replace(before, after)
  if (digest(patched) !== patchedDigest) throw new Error('NSIS 卸载确认框模板补修结果不符')
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, patched)
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  return true
}

function prepareIsolatedTemplate(sourceDir, version, nsisUtil) {
  if (digest(readFileSync(join(sourceDir, 'uninstaller.nsh'))) !== originalDigest) {
    throw new Error('NSIS 原始模板已改变，拒绝从共享依赖生成卸载器')
  }
  if (prepared) {
    if (prepared.sourceDir !== sourceDir) throw new Error('同一构建进程混用了不同的 NSIS 模板来源')
    nsisUtil.nsisTemplatesDir = prepared.copyDir
    return prepared.copyDir
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'laixin-nsis-'))
  const copyDir = join(temporaryRoot, 'nsis')
  try {
    cpSync(sourceDir, copyDir, { recursive: true })
    patchTemplate(join(copyDir, 'uninstaller.nsh'), version)
    prepared = { sourceDir, copyDir }
    nsisUtil.nsisTemplatesDir = copyDir
    process.once('exit', () => rmSync(temporaryRoot, { recursive: true, force: true }))
    return copyDir
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

module.exports = async function foregroundUninstallConfirmation(context) {
  if (context.electronPlatformName !== 'win32') return
  await require('./prepare-windows-recovery-guard.cjs')(context)
  const packagePath = require.resolve('app-builder-lib/package.json')
  const version = require(packagePath).version
  const sourceDir = join(dirname(packagePath), 'templates', 'nsis')
  const nsisUtil = require('app-builder-lib/out/targets/nsis/nsisUtil')
  if (nsisUtil.nsisTemplatesDir !== sourceDir && (!prepared || nsisUtil.nsisTemplatesDir !== prepared.copyDir)) {
    throw new Error('NSIS 模板运行路径与锁定依赖不一致')
  }
  prepareIsolatedTemplate(sourceDir, version, nsisUtil)
}
module.exports.patchTemplate = patchTemplate
module.exports.prepareIsolatedTemplate = prepareIsolatedTemplate

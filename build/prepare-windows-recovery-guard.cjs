const { mkdir } = require('node:fs/promises')
const { dirname, join } = require('node:path')
const { spawn } = require('node:child_process')
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows')

async function compileWindowsRecoveryGuard(outputPath, spawnImpl = spawn) {
  await mkdir(dirname(outputPath), { recursive: true })
  const makensis = await getMakeNsisPath()
  const sourcePath = join(__dirname, 'windows-recovery-guard.nsi')
  await new Promise((resolve, reject) => {
    const child = spawnImpl(makensis.path, [
      '-V2', '-WX', '-INPUTCHARSET', 'UTF8', `-DOUTPUT_FILE=${outputPath}`, sourcePath
    ], { env: { ...process.env, ...(makensis.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout?.on('data', chunk => stdout.push(chunk))
    child.stderr?.on('data', chunk => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`WINDOWS_RECOVERY_GUARD_BUILD_FAILED:${Buffer.concat([...stdout, ...stderr]).toString('utf8').trim()}`))
    })
  })
}

module.exports = async function prepareWindowsRecoveryGuard(context) {
  if (context.electronPlatformName !== 'win32') return
  await compileWindowsRecoveryGuard(join(context.appOutDir, 'resources', 'windows-recovery-guard.exe'))
}
module.exports.compileWindowsRecoveryGuard = compileWindowsRecoveryGuard

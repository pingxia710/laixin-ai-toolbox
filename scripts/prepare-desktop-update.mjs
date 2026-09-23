// Prepare local signed update assets. This script does not upload or publish anything.
import { createHash, createPublicKey, sign } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildReleaseAssets, sameUpdatePath } from './update-manifest-origins.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const output = resolve(root, process.argv[2] ?? 'release/updates')
const origin = new URL(process.env.TOOLBOX_UPDATE_ORIGIN ?? 'https://laixin.work/')
// 域名迁移期间旧客户端仍从旧路径读取 latest.json。默认额外生成一份只含旧地址清单的
// 兼容文件；它必须由发布人单独放到旧域名的 updates 目录，脚本不会上传或切换线上文件。
const legacyOriginValue = process.env.TOOLBOX_LEGACY_UPDATE_ORIGIN ?? 'https://laixin.net.cn/AI-tools/'
const legacyOrigin = legacyOriginValue ? new URL(legacyOriginValue) : undefined
const legacyOutput = resolve(root, process.env.TOOLBOX_LEGACY_UPDATE_OUTPUT ?? 'release/updates-legacy')
const githubRepository = process.env.TOOLBOX_GITHUB_REPOSITORY ?? 'pingxia710/laixin-ai-toolbox'
// 新清单的国内 CDN 镜像基址必须与新域名同为根路径(如 https://dl.laixin.net.cn/)，不能再传旧的
// /AI-tools/ 前缀；旧前缀只通过 TOOLBOX_LEGACY_UPDATE_MIRROR 写入兼容清单。不配就只挂 GitHub。
const mirrorOrigin = process.env.TOOLBOX_UPDATE_MIRROR ? new URL(process.env.TOOLBOX_UPDATE_MIRROR) : undefined
const legacyMirrorOrigin = process.env.TOOLBOX_LEGACY_UPDATE_MIRROR ? new URL(process.env.TOOLBOX_LEGACY_UPDATE_MIRROR) : undefined
if (mirrorOrigin && mirrorOrigin.protocol !== 'https:') throw new Error('UPDATE_MIRROR_INVALID')
if (legacyMirrorOrigin && legacyMirrorOrigin.protocol !== 'https:') throw new Error('UPDATE_LEGACY_MIRROR_INVALID')
if (!['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && origin.hostname !== '127.0.0.1')) throw new Error('UPDATE_ORIGIN_INVALID')
if (legacyOrigin && (!['https:', 'http:'].includes(legacyOrigin.protocol) || (legacyOrigin.protocol === 'http:' && legacyOrigin.hostname !== '127.0.0.1'))) throw new Error('UPDATE_LEGACY_ORIGIN_INVALID')
if (legacyOrigin && legacyOutput === output) throw new Error('UPDATE_LEGACY_OUTPUT_MUST_DIFFER')
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) throw new Error('UPDATE_GITHUB_REPOSITORY_INVALID')
const hash = async (file) => { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex') }
const signedManifest = (release, privateKey) => {
  const payload = Buffer.from(JSON.stringify(release))
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') })
}
await mkdir(output, { recursive: true })
// Intel 包是**单独一条构建线**(build:mac-intel,Electron 43 才支持 macOS 12),
// 所以它不一定每次都在。目录不在就跳过并说出来,⛔ 让整个发布挂掉 ——
// 但 darwin-arm64 是主平台,它不在就是真出事了,必须报错。
const macCandidates = [
  { platform: 'darwin-arm64', directory: 'mac-arm64', name: `toolbox-${metadata.version}-mac-arm64.zip`, required: true },
  { platform: 'darwin-x64', directory: 'mac', name: `toolbox-${metadata.version}-mac-x64.zip`, required: false }
]
const macTargets = []
for (const target of macCandidates) {
  const application = join(root, 'release', target.directory, `${metadata.productName}.app`)
  if (!existsSync(application)) {
    if (target.required) throw new Error(`UPDATE_BUILD_MISSING: ${application}`)
    process.stdout.write(`跳过 ${target.platform}:没有 ${target.directory} 构建产物。清单里不会有这个平台。\n`)
    continue
  }
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, join(output, target.name)])
  macTargets.push({ ...target, application })
}
const exe = `toolbox-${metadata.version}-win-x64.exe`
await copyFile(join(root, 'release', `${metadata.productName} Setup ${metadata.version}.exe`), join(output, exe))
const assetFiles = {}
for (const [platform, name, asar] of [
  ...macTargets.map((target) => [target.platform, target.name, join(target.application, 'Contents/Resources/app.asar')]),
  ['win32-x64', exe, join(root, 'release/win-unpacked/resources/app.asar')]
]) {
  assetFiles[platform] = { name, size: (await stat(join(output, name))).size,
    sha256: await hash(join(output, name)), asarSha256: await hash(asar) }
}
if (mirrorOrigin && !sameUpdatePath(origin, mirrorOrigin)) {
  throw new Error('UPDATE_MIRROR_ORIGIN_MISMATCH: canonical mirror path must match the canonical update origin')
}
if (legacyOrigin && legacyMirrorOrigin && !sameUpdatePath(legacyOrigin, legacyMirrorOrigin)) {
  throw new Error('UPDATE_LEGACY_MIRROR_ORIGIN_MISMATCH: legacy mirror path must match the legacy update origin')
}
const notes = await readFile(join(root, 'resources/update-notes.md'), 'utf8')
const release = { version: metadata.version, notes,
  assets: buildReleaseAssets(assetFiles, { origin, mirrorOrigin, githubRepository, version: metadata.version }) }
const privateKey = await readFile(join(homedir(), '.config/laixin-ai-toolbox/release-signing/private.pem'))
if (createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== await readFile(join(root, 'resources/update-public-key.pem'), 'utf8')) throw new Error('UPDATE_SIGNING_KEY_MISMATCH')
await writeFile(join(output, 'latest.json'), signedManifest(release, privateKey))
let legacyRelease
if (legacyOrigin && legacyOrigin.href !== origin.href) {
  await mkdir(legacyOutput, { recursive: true })
  legacyRelease = { version: metadata.version, notes,
    assets: buildReleaseAssets(assetFiles, { origin: legacyOrigin, mirrorOrigin: legacyMirrorOrigin, githubRepository, version: metadata.version }) }
  await writeFile(join(legacyOutput, 'latest.json'), signedManifest(legacyRelease, privateKey))
}
console.log(JSON.stringify({ version: release.version, output, legacyOutput: legacyRelease ? legacyOutput : undefined, published: false,
  assets: release.assets, legacyAssets: legacyRelease?.assets }, null, 2))

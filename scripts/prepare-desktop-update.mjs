// Prepare local signed update assets. This script does not upload or publish anything.
import { createHash, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const output = resolve(root, process.argv[2] ?? 'release/updates')
const origin = new URL(process.env.TOOLBOX_UPDATE_ORIGIN ?? 'https://laixin.net.cn/AI-tools/')
const githubRepository = process.env.TOOLBOX_GITHUB_REPOSITORY ?? 'pingxia710/laixin-ai-toolbox'
if (!['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && origin.hostname !== '127.0.0.1')) throw new Error('UPDATE_ORIGIN_INVALID')
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) throw new Error('UPDATE_GITHUB_REPOSITORY_INVALID')
const hash = async (file) => { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex') }
await mkdir(output, { recursive: true })
const mac = join(root, 'release/mac-arm64', `${metadata.productName}.app`)
const zip = `toolbox-${metadata.version}-mac-arm64.zip`, exe = `toolbox-${metadata.version}-win-x64.exe`
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', mac, join(output, zip)])
await copyFile(join(root, 'release', `${metadata.productName} Setup ${metadata.version}.exe`), join(output, exe))
const assets = {}
for (const [platform, name, asar] of [['darwin-arm64', zip, join(mac, 'Contents/Resources/app.asar')], ['win32-x64', exe, join(root, 'release/win-unpacked/resources/app.asar')]]) {
  assets[platform] = { url: new URL(`updates/${name}`, origin).href,
    mirrors: [`https://github.com/${githubRepository}/releases/download/v${metadata.version}/${name}`], size: (await stat(join(output, name))).size,
    sha256: await hash(join(output, name)), asarSha256: await hash(asar) }
}
const release = { version: metadata.version, notes: await readFile(join(root, 'resources/update-notes.md'), 'utf8'), assets }
const privateKey = await readFile(join(homedir(), '.config/laixin-ai-toolbox/release-signing/private.pem'))
if (createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== await readFile(join(root, 'resources/update-public-key.pem'), 'utf8')) throw new Error('UPDATE_SIGNING_KEY_MISMATCH')
const payload = Buffer.from(JSON.stringify(release))
await writeFile(join(output, 'latest.json'), JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }))
console.log(JSON.stringify({ version: release.version, output, published: false, assets }, null, 2))

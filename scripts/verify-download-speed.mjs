// 官网直装必须实际命中 CDN 并够快，不能由 GitHub 更新包/源站 HEAD 200 替代。
import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

export const SAMPLE_BYTES = 8 * 1024 * 1024
const MIN_BYTES_PER_SECOND = 1024 * 1024
// 正式发布必须同时提供 Windows、Mac M 系列和 Mac Intel 三个直装包。
const FILENAMES = ['laixin-ai-toolbox-windows-x64.exe', 'laixin-ai-toolbox-mac-arm64.dmg', 'laixin-ai-toolbox-mac-x64.dmg']

export function downloadTargets(html, origin, version) {
  const links = new Set([...html.matchAll(/(?:href|url)\s*[:=]\s*['"]([^'"]*\/downloads\/V[^'"]+)['"]/g)].map(match => new URL(match[1], origin).href))
  const expected = FILENAMES.map(name => new URL(`downloads/V${version}/${name}`, origin).href)
  if (links.size !== 3 || expected.some(url => !links.has(url))) throw new Error('DOWNLOAD_MATRIX: 官网必须提供当前版本三个精确直装链接')
  return expected
}

function verifyCdnTarget(url, finalUrl) {
  const final = new URL(finalUrl)
  if (final.protocol !== 'https:' || final.hostname !== 'dl.laixin.net.cn' || final.pathname !== new URL(url).pathname) {
    throw new Error('CDN_NOT_READY: 官网未命中本版既有 CDN，源站容灾可用不代表下载加速就绪')
  }
}

export function verifySample(sample) {
  verifyCdnTarget(sample.url, sample.finalUrl)
  if (sample.status !== 206 || sample.contentRange !== `bytes 0-${SAMPLE_BYTES - 1}/${sample.expectedSize}` || sample.bytes !== SAMPLE_BYTES) {
    throw new Error('DOWNLOAD_RANGE: 状态/样本字节/完整文件大小不符')
  }
  if (sample.digest !== sample.expectedDigest) throw new Error('DOWNLOAD_CONTENT: CDN 样本与实际正式安装包不同')
  const speed = sample.bytes / sample.seconds
  if (!Number.isFinite(sample.seconds) || sample.seconds <= 0 || !Number.isFinite(speed) || speed < MIN_BYTES_PER_SECOND) {
    throw new Error('DOWNLOAD_TOO_SLOW: 官网真实下载不足 1 MiB/s 或测速数据无效，不得报加速通过')
  }
  return speed
}

export async function verifyDownloadSpeed({ html, origin, version, releaseDir = 'release' }) {
  const results = []
  for (const url of downloadTargets(html, origin, version)) {
    const filename = new URL(url).pathname.split('/').at(-1)
    const local = join(releaseDir, filename)
    const { size: expectedSize } = await stat(local)
    const file = await open(local, 'r')
    const expected = Buffer.alloc(SAMPLE_BYTES)
    let localBytes
    try { ({ bytesRead: localBytes } = await file.read(expected, 0, SAMPLE_BYTES, 0)) }
    finally { await file.close() }
    if (localBytes !== SAMPLE_BYTES) throw new Error(`DOWNLOAD_CONTENT: 本地正式包不足采样长度 ${filename}`)
    const expectedDigest = createHash('sha256').update(expected).digest('hex')
    const started = performance.now()
    // Node 原生 fetch 未设置代理 dispatcher：此门禁专门验证国内 CDN 直连，不改本机代理。
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}`, 'Accept-Encoding': 'identity' },
      redirect: 'follow', signal: AbortSignal.timeout(30_000)
    })
    if (response.status !== 206 || !response.body) {
      await response.body?.cancel()
      throw new Error(`DOWNLOAD_RANGE: ${filename} HTTP ${response.status}`)
    }
    try { verifyCdnTarget(url, response.url) }
    catch (error) { await response.body.cancel(); throw error }
    const digest = createHash('sha256')
    let bytes = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > SAMPLE_BYTES) throw new Error(`DOWNLOAD_RANGE: ${filename} 忽略采样上限`)
        digest.update(value)
      }
    } finally { await reader.cancel() }
    const sample = {
      url, finalUrl: response.url, status: response.status, contentRange: response.headers.get('content-range'),
      expectedSize, expectedDigest, bytes, seconds: (performance.now() - started) / 1000, digest: digest.digest('hex')
    }
    const speed = verifySample(sample)
    results.push({ ...sample, bytesPerSecond: speed })
    process.stdout.write(`OK    DOWNLOAD_SPEED ${filename} ${(speed / 1024 / 1024).toFixed(2)} MiB/s; CDN=${new URL(response.url).hostname}; sample=${bytes}; total=${expectedSize}\n`)
  }
  return results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const origin = 'https://laixin.work/'
    let html, version
    if (process.argv.includes('--candidate')) {
      // 切换前核验本源码的下一版页面与已暂存的真实 CDN 文件，不把旧线上页面当下一版。
      html = await readFile(new URL('../deploy/ai-tools/public/index.html', import.meta.url), 'utf8')
      version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
      process.stdout.write(`CANDIDATE ${version}: 只验证暂存下载链路，不证明官网已经切换\n`)
    } else {
      const response = await fetch(origin, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`官网 HTTP ${response.status}`)
      html = await response.text()
      const manifest = await fetch(new URL('updates/latest.json', origin), { signal: AbortSignal.timeout(10_000) })
      if (!manifest.ok) throw new Error(`更新清单 HTTP ${manifest.status}`)
      const { payload } = await manifest.json()
      version = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).version
    }
    const index = process.argv.indexOf('--release-dir')
    await verifyDownloadSpeed({ html, origin, version, releaseDir: index >= 0 ? process.argv[index + 1] : 'release' })
  } catch (error) {
    process.stderr.write(`FAIL  官网下载加速未通过: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

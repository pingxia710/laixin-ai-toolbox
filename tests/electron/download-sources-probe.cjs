// Real Electron downloader + local HTTP; installer inspection is a fixture.
const { app, session } = require('electron')
const { createServer } = require('node:http')
const { createHash } = require('node:crypto')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const [compiledArg, evidenceArg] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
if (!compiledArg || !evidenceArg) throw new Error('Expected compiled-root and evidence-directory')
const compiled = resolve(compiledArg)
const evidence = resolve(evidenceArg)
mkdirSync(evidence, { recursive: true })
app.setPath('userData', join(evidence, 'electron-profile'))
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
const { DownloadManager } = require(join(compiled, 'app/main/download/download-manager.js'))
const { ElectronDownloadEngine } = require(join(compiled, 'app/main/download/electron-download-engine.js'))
const { createFileTaskStore, taskPaths } = require(join(compiled, 'app/main/download/task-store.js'))

let server
let manager
const timeout = setTimeout(() => { console.error('DOWNLOAD_SOURCE_PROBE_TIMEOUT'); app.exit(1) }, 40000)
app.whenReady().then(async () => {
  const artifact = Buffer.from('local synthetic installer bytes; never executed')
  const digest = createHash('sha256').update(artifact).digest('hex')
  const hits = { primary: 0, backup: 0 }
  const downloadEvents = []
  for (const source of ['primary', 'backup']) {
    session.fromPartition(`persist:toolbox-download-local-source-probe-${source}`).on('will-download', (_event, item) => {
      downloadEvents.push({ source, event: 'will-download', state: item.getState(), canResume: item.canResume() })
      item.on('updated', (_event, state) => downloadEvents.push({ source, event: 'updated', state, canResume: item.canResume() }))
      item.on('done', (_event, state) => downloadEvents.push({ source, event: 'done', state }))
    })
  }
  server = createServer((req, res) => {
    if (req.url === '/primary') { hits.primary++; res.destroy(); return }
    if (req.url === '/backup') {
      hits.backup++
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': artifact.length, 'Content-Disposition': 'attachment; filename="fixture.dmg"' })
      res.end(artifact); return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  const resource = {
    id: 'local-source-probe', software: 'Hermes', platform: 'macos', architecture: 'arm64', type: 'download',
    officialPageUrl: 'https://example.invalid/', assetUrl: `${base}/primary`, allowedHosts: ['127.0.0.1'],
    version: 'fixture', officialVersionLabel: 'fixture', format: 'dmg', expectedBytes: String(artifact.length),
    recordedSha256: digest, officialSha256: digest, identity: null,
    approval: { approvedAt: '2026-09-07', approvedBy: 'local-test', sourceBuild: 'fixture', scope: 'local-only' },
    sources: [
      { id: 'primary', assetUrl: `${base}/primary`, allowedHosts: ['127.0.0.1'], network: 'direct' },
      { id: 'backup', assetUrl: `${base}/backup`, allowedHosts: ['127.0.0.1'], network: 'direct' }
    ]
  }
  const data = join(evidence, 'downloads')
  manager = new DownloadManager({
    catalog: { catalogVersion: 'local-test', resources: [resource] }, engine: new ElectronDownloadEngine(),
    store: createFileTaskStore(data), taskPaths: (id, item) => taskPaths(data, id, item),
    inspector: { inspect: async () => ({ kind: 'installer', identity: null }) },
    tunnel: () => { throw new Error('Direct sources must not query a tunnel') },
    taskId: () => 'local-source-probe'
  })
  const task = await manager.start(resource.id)
  let result
  for (let n = 0; n < 500; n++) {
    result = await manager.status(task.taskId)
    if (!['downloading', 'verifying', 'interrupted-resumable'].includes(result.state)) break
    await new Promise((done) => setTimeout(done, 30))
  }
  writeFileSync(join(evidence, 'events.json'), JSON.stringify({ hits, state: result.state, reason: result.reason, downloadEvents }, null, 2))
  assert.equal(result.state, 'ready')
  assert.equal(result.localSha256, digest)
  assert.ok(hits.primary >= 1)
  assert.equal(hits.backup, 1)
  const route = await session.fromPartition('persist:toolbox-download-local-source-probe-backup').resolveProxy(base)
  assert.equal(route, 'DIRECT')
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ state: result.state, hits, digestMatches: true, route, actualElectronDownload: true, inspectorIsFixture: true, installerExecuted: false }, null, 2))
  console.log('PASS: real Electron download switched from failed local source to backup, direct mode, exact bytes verified')
  await manager.dispose()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  clearTimeout(timeout)
  app.quit()
}).catch(async (error) => {
  console.error('DOWNLOAD_SOURCE_PROBE_FAILED', error.message)
  await manager?.dispose()
  server?.closeAllConnections()
  server?.close()
  clearTimeout(timeout)
  app.exit(1)
})

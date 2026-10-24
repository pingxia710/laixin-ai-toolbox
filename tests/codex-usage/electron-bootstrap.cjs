/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Test launcher only: production renderer + preload + bridge + monitor, fake external Codex process.
const { app } = require('electron')
const cp = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const root = path.resolve(__dirname, '../..')
const testRoot = process.env.TOOLBOX_USAGE_TEST_ROOT
if (!testRoot) throw new Error('Isolated test root required')
app.setPath('userData', path.join(testRoot, 'toolbox'))
Object.defineProperty(app, 'isPackaged', { get: () => true })
const clock = Date.now.bind(Date)
global.usageTestClockOffset = 0
Date.now = () => clock() + global.usageTestClockOffset
const originalSpawn = cp.spawn
cp.spawn = function (executable, args, options) {
  if (args?.[0] === 'app-server') {
    const mode = fs.readFileSync(path.join(testRoot, 'mode'), 'utf8').trim()
    return originalSpawn(process.env.USAGE_TEST_NODE, [path.join(__dirname, 'fixtures/server.mjs'), mode], {
      ...options, env: { ...options.env, USAGE_FIXTURE_REQUESTS: path.join(testRoot, 'requests.jsonl') }
    })
  }
  return originalSpawn(executable, args, options)
}
require(path.join(root, 'out/main/index.js'))

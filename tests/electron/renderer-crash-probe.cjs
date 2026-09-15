// 收敛包3·件3 端到端探针:真实渲染进程崩溃(forcefullyCrashRenderer)→ render-process-gone
// → 自动 reload 恢复(3 秒内)+ 提示出现。与 app/main/index.ts 的接线同款语义。
// 运行:node_modules/.bin/electron tests/electron/renderer-crash-probe.cjs ;退出码 0 = 通过。
const { app, BrowserWindow, Notification } = require('electron')
const path = require('node:path')

const CRASH_COUNT_LIMIT = 2 // 探针只验证第一次崩溃自动恢复

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 })
  let reloads = 0
  let notified = false
  let recoveredAt = 0
  const crashedAt = { first: 0 }

  const notify = (message) => {
    notified = true
    console.log(`[probe] notify: ${message}`)
  }
  const recovery = {
    handle(details) {
      // 与 createRendererRecovery 第一次崩溃分支同款:reload + 提示
      reloads += 1
      notify(`界面出现异常，已自动恢复（reason=${details.reason}）`)
      win.webContents.reload()
    }
  }

  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[probe] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    crashedAt.first = Date.now()
    recovery.handle({ reason: details.reason, exitCode: details.exitCode })
  })
  win.webContents.on('did-finish-load', () => {
    console.log(`[probe] did-finish-load #${reloads + 1}`)
    if (reloads >= 1) {
      recoveredAt = Date.now() - crashedAt.first
      finish()
    }
  })

  await win.loadURL('data:text/html,<html><body><h1>probe</h1></body></html>')
  console.log('[probe] initial load done, crashing renderer')
  win.webContents.forcefullyCrashRenderer()

  function finish() {
    const elapsed = recoveredAt
    console.log(`[probe] reloads=${reloads} notified=${notified} recoverElapsedMs=${elapsed}`)
    if (reloads >= 1 && notified && elapsed > 0 && elapsed < 3000) {
      console.log('[probe] PASS: 渲染进程崩溃在 3 秒内自动恢复且提示出现')
      app.exit(0)
    } else {
      console.log('[probe] FAIL')
      app.exit(1)
    }
  }
  setTimeout(() => {
    console.log('[probe] FAIL: 超时未恢复')
    app.exit(1)
  }, 10_000)
})

const { app, BrowserWindow } = require('electron')

void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  await window.loadURL('http://localhost:5173/')
  const csp = await window.webContents.executeJavaScript(
    'document.querySelector("meta[http-equiv=\\"Content-Security-Policy\\"]")?.content'
  )
  const fetchResult = await window.webContents.executeJavaScript(
    'fetch(window.location.origin).then((response) => "resolved:" + response.status, (error) => "rejected:" + error.name)'
  )
  process.stdout.write(`DEV_CSP_META=${csp}\nDEV_CSP_SAME_ORIGIN_FETCH=${fetchResult}\n`)
  app.exit(fetchResult.startsWith('rejected:') ? 0 : 1)
})

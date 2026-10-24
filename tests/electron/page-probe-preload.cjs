const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('toolbox', {
  app: {
    info: () => Promise.resolve({ version: 'fixture', platform: 'darwin', architecture: 'arm64', packaged: false })
  },
  account: {
    status: () => Promise.resolve({ snapshot: JSON.stringify({ state: 'signed-out', account: null, overview: null, code: '', message: '' }) })
  }
})

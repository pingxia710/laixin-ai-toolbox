const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const scenario = new URL(window.location.href).pathname
  void ipcRenderer.invoke('toolbox:action', 'test.ping', undefined).then(
    () => ipcRenderer.send('bridge-probe-result', { scenario, accepted: true }),
    (error) =>
      ipcRenderer.send('bridge-probe-result', {
        scenario,
        accepted: false,
        rejectedBySourceGuard: String(error?.message).includes('IPC_SOURCE_NOT_ALLOWED')
      })
  )
})

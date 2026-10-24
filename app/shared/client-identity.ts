import packageJson from '../../package.json'

/** 上报给本机 Codex/用量协议对端的客户端版本。Electron 内取实际运行版本：
 * 打包器用 extraMetadata 在源码编译之后改写成品版本（-netapi.1 等工作包后缀），
 * 编译期内联的 packageJson.version 读不到它，只有 app.getVersion() 能读到；
 * 开发/非 Electron 进程（测试/工具）退回源码 package.json 版本。
 * ⛔ 各接入点不得硬编码或改回编译时版本。 */
export async function toolboxClientVersion(): Promise<string> {
  if (process.versions.electron === undefined) return packageJson.version
  try {
    const { app } = await import('electron')
    const version = app.getVersion()
    if (typeof version === 'string' && version.length > 0) return version
  } catch { /* 退回源码版本。 */ }
  return packageJson.version
}

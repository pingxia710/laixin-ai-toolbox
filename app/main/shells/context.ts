// 主进程单例：配方存取、六壳检测、安装执行器。测试不走这里。
import { app } from 'electron'
import { join } from 'node:path'
import { RecipeStore, recipeFile } from '../recipes/store'
import { ShellInventory } from './inventory'
import { ShellInstaller } from './installer'
import { downloadTunnelSnapshot } from '../download/tunnel-runtime'

declare const __TOOLBOX_UPDATE_PUBLIC_KEY__: string
declare const __TOOLBOX_UPDATE_ORIGIN__: string

let recipes: RecipeStore | undefined
let inventory: ShellInventory | undefined
let installer: ShellInstaller | undefined

export function recipeStore(): RecipeStore {
  recipes ??= new RecipeStore({ file: recipeFile(app.getPath('userData')), publicKey: __TOOLBOX_UPDATE_PUBLIC_KEY__, origin: __TOOLBOX_UPDATE_ORIGIN__ })
  return recipes
}

export function shellInventory(): ShellInventory {
  inventory ??= new ShellInventory({ platform: process.platform, home: app.getPath('home'), env: process.env, recipes: () => recipeStore().current() })
  return inventory
}

export function shellInstaller(): ShellInstaller {
  installer ??= new ShellInstaller({ platform: process.platform, recipes: () => recipeStore().current(), inventory: shellInventory(),
    proxyUrl: () => { const tunnel = downloadTunnelSnapshot(); return tunnel.state === 'connected' && tunnel.localProxyUrl ? tunnel.localProxyUrl : undefined } })
  return installer
}

export function userDataPath(...parts: string[]): string { return join(app.getPath('userData'), ...parts) }

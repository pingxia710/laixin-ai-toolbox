import { execFileSync } from 'node:child_process'
import process from 'node:process'

const accountOrigin = process.env.TOOLBOX_ACCOUNT_ORIGIN ?? 'https://laixin.work/'
const updateOrigin = process.env.TOOLBOX_UPDATE_ORIGIN ?? accountOrigin

execFileSync(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, TOOLBOX_ACCOUNT_ORIGIN: accountOrigin, TOOLBOX_UPDATE_ORIGIN: updateOrigin }
})

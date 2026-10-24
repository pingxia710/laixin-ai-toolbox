import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.mjs'],
    include: ['tests/**/*.test.ts'],
    // 部分用例会启动真实本地守护和 Xray；串行文件执行让子进程清理可重复。
    fileParallelism: false
  }
})

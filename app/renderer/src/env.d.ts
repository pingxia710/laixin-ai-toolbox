declare module '*.css'

declare global {
  interface ToolboxApi {
    readonly _toolboxApiBrand?: never
  }

  interface Window {
    readonly toolbox: ToolboxApi
  }
}

export {}

declare module '*.png'

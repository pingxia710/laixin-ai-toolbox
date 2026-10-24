export const namespace = 'app'

export interface ConflictingAppApi {
  info(): Promise<number>
}

export const api: ConflictingAppApi = {
  info: () => Promise.resolve(1)
}

declare global {
  interface ToolboxApi {
    readonly app: ConflictingAppApi
  }
}

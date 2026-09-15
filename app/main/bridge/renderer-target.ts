export interface RendererTarget {
  readonly kind: 'file' | 'url'
  readonly value: string
}

export function resolveRendererTarget(
  isPackaged: boolean,
  rendererUrl: string | undefined,
  productionFile: string
): RendererTarget {
  if (isPackaged) {
    return { kind: 'file', value: productionFile }
  }
  if (rendererUrl === undefined || rendererUrl.length === 0) {
    throw new Error('开发模式缺少有效的渲染页面地址。')
  }
  const parsed = new URL(rendererUrl)
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
    throw new Error('开发模式渲染页面必须是本地 HTTP 入口。')
  }
  return { kind: 'url', value: rendererUrl }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

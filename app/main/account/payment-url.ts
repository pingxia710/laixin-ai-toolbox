/** Only official Alipay checkout URLs may be handed to the operating system. */
export function isAlipayCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['openapi.alipay.com', 'openapi-sandbox.dl.alipaydev.com'].includes(url.hostname) &&
      url.pathname === '/gateway.do' && !url.hash
  } catch { return false }
}

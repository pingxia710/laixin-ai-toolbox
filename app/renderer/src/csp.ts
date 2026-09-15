const groupEntryOrigin = 'https://laixin.net.cn'

export const productionCsp =
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${groupEntryOrigin}; connect-src ${groupEntryOrigin}`

export const developmentCsp =
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${groupEntryOrigin}; connect-src ws://127.0.0.1:* ws://localhost:* ${groupEntryOrigin}`

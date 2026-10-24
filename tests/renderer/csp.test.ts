import { describe, expect, it } from 'vitest'
import { developmentCsp, productionCsp } from '../../app/renderer/src/csp'

describe('renderer CSP', () => {
  it('生产态只允许官网群码清单，开发态在此基础上保留本地 HMR websocket', () => {
    expect(productionCsp).toContain("connect-src https://laixin.work")
    expect(productionCsp).toContain("img-src 'self' data: https://laixin.work")
    expect(productionCsp).not.toContain('ws://')
    expect(developmentCsp).toContain('ws://127.0.0.1:*')
    expect(developmentCsp).toContain('ws://localhost:*')
    expect(developmentCsp).not.toContain("connect-src 'self'")
    expect(developmentCsp).toContain('https://laixin.work')
  })
})

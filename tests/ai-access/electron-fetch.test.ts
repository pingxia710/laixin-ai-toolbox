import { afterEach, describe, expect, it, vi } from 'vitest'

const netFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))

vi.mock('electron', () => ({ net: { fetch: netFetch } }))

const { electronSystemFetch } = await import('../../app/main/ai-access/electron-fetch')

afterEach(() => {
  netFetch.mockClear()
})

describe('AI provider main-process transport', () => {
  it('uses Electron net.fetch so system proxy/PAC remains part of the provider path', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('DIRECT_NODE_FETCH_MUST_NOT_BE_USED'))
    try {
      const signal = AbortSignal.timeout(1_000)
      const response = await electronSystemFetch('https://api.example.test/v1/models', { method: 'HEAD', signal })
      expect(response.status).toBe(204)
      expect(netFetch).toHaveBeenCalledWith('https://api.example.test/v1/models', { method: 'HEAD', signal })
      expect(globalFetch).not.toHaveBeenCalled()
    } finally {
      globalFetch.mockRestore()
    }
  })
})

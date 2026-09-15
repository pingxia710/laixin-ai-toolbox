import { describe, expect, it, vi } from 'vitest'
import { ActionRegistry } from '../../app/main/bridge/action-registry'
import { installIpcBridge, IPC_CHANNEL } from '../../app/main/bridge/ipc-bridge'
import { schema } from '../../app/main/bridge/schema'

describe('产品 IPC 接收器', () => {
  it('拒绝来源后不进入业务 handler，但接收器读数仍可见', async () => {
    const registry = new ActionRegistry()
    const handler = vi.fn(() => ({ ok: true }))
    registry.registerAction({
      name: 'test.ping',
      paramsSchema: schema.undefined(),
      resultSchema: schema.object({ ok: schema.boolean() }),
      handler
    })
    let receiverCalls = 0
    let receiver: ((event: { senderFrame: unknown }, name: string, params: unknown) => Promise<unknown>) | undefined
    installIpcBridge(
      {
        handle: (channel, callback) => {
          expect(channel).toBe(IPC_CHANNEL)
          receiver = callback as typeof receiver
        }
      },
      {
        registry,
        mainFrame: () => mainFrame,
        entryUrl: () => expected,
        received: () => {
          receiverCalls += 1
        }
      }
    )

    await expect(receiver?.({ senderFrame: childFrame }, 'test.ping', undefined)).rejects.toMatchObject({
      code: 'IPC_SOURCE_NOT_ALLOWED'
    })
    await expect(
      receiver?.({ senderFrame: null }, 'test.ping', undefined)
    ).rejects.toMatchObject({ code: 'IPC_SOURCE_NOT_ALLOWED' })
    await expect(receiver?.({ senderFrame: mainFrame }, 'test.ping', undefined)).resolves.toEqual({ ok: true })
    expect(receiverCalls).toBe(3)
    expect(handler).toHaveBeenCalledOnce()
  })
})

const expected = 'http://127.0.0.1:5173/index.html'
const mainFrame = { url: expected }
const childFrame = { url: expected }

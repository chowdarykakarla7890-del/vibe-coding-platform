import { expect, it, vi } from 'vitest'
import { initBotId } from 'botid/client/core'
vi.mock('botid/client/core', () => ({ initBotId: vi.fn() }))
it('initializes client proof for all registered server-protected endpoints before hydration', async () => {
  await import('@/instrumentation-client')
  expect(initBotId).toHaveBeenCalledExactlyOnceWith({ protect: [
    { path: '/api/chat', method: 'POST' }, { path: '/api/errors', method: 'POST' },
    { path: '/api/activities/generate', method: 'POST' },
    { path: '/api/activities/verify', method: 'POST' },
  ] })
})

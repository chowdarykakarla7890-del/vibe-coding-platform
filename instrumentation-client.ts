import { initBotId } from 'botid/client/core'

// Initialize before hydration so the first protected request has client proof.
// Server verification, authenticated ownership and quotas remain mandatory.
initBotId({ protect: [
  { path: '/api/chat', method: 'POST' },
  { path: '/api/errors', method: 'POST' },
  { path: '/api/activities/generate', method: 'POST' },
  { path: '/api/activities/verify', method: 'POST' },
] })

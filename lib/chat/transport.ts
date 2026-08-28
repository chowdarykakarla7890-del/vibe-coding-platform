import { DefaultChatTransport } from 'ai'
import type { ChatUIMessage } from '@/components/chat/types'
import { cloudOperation } from '@/lib/learning/cloud-request'

export function createProjectChatTransport(projectId: string, signal?: AbortSignal) {
  const account = cloudOperation(signal)
  return new DefaultChatTransport<ChatUIMessage>({
    fetch: (input, init) => account.fetch(input, init),
    prepareSendMessagesRequest: ({ messages, body, trigger }) => {
      const message = messages.findLast((item) => item.role === 'user')
      if (!message) throw new Error('Enter a user message before starting the tutor.')
      return { body: {
        projectId,
        message: { id: message.id, role: 'user', parts: message.parts.filter((part) => part.type === 'text').map((part) => ({ type: 'text', text: part.text })) },
        modelId: body?.modelId,
        reasoningEffort: body?.reasoningEffort,
        retry: trigger === 'regenerate-message',
      } }
    },
  })
}

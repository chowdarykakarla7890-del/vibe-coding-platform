import type { UIMessageStreamWriter, UIMessage } from 'ai'
import type { DataPart } from '../messages/data-parts'
import type { SandboxAccess } from './sandbox-access'
import { getRichError } from './get-rich-error'
import { tool } from 'ai'
import description from './get-sandbox-url.prompt'
import z from 'zod/v3'

interface Params {
  sandboxAccess: SandboxAccess
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>
}

export const getSandboxURL = ({ writer, sandboxAccess }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z
        .string()
        .describe(
          "The unique identifier of the Vercel Sandbox (e.g., 'sbx_abc123xyz'). This ID is returned when creating a Vercel Sandbox and is used to reference the specific sandbox instance."
        ),
      port: z
        .number()
        .int()
        .min(1024)
        .max(65_535)
        .describe(
          'The port number where a service is running inside the Vercel Sandbox (e.g., 3000 for Next.js dev server, 8000 for Python apps, 5000 for Flask). The port must have been exposed when the sandbox was created or when running commands.'
        ),
    }),
    execute: async ({ sandboxId, port }, { toolCallId }) => {
      writer.write({
        id: toolCallId,
        type: 'data-get-sandbox-url',
        data: { sandboxId, status: 'loading' },
      })

      try {
        const url = await sandboxAccess.getUrl(sandboxId, port)

        writer.write({
          id: toolCallId,
          type: 'data-get-sandbox-url',
          data: { sandboxId, url, status: 'done' },
        })

        return { url }
      } catch (error) {
        const richError = getRichError({
          action: 'get sandbox URL',
          args: { sandboxId, port },
          error,
        })
        writer.write({
          id: toolCallId,
          type: 'data-get-sandbox-url',
          data: {
            sandboxId,
            status: 'error',
            error: { message: richError.error.message },
          },
        })
        return richError.message
      }
    },
  })

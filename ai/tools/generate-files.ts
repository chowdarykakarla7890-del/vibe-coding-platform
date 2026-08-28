import type { UIMessageStreamWriter, UIMessage } from 'ai'
import type { DataPart } from '../messages/data-parts'
import type { SandboxAccess } from './sandbox-access'
import { getContents, type File } from './generate-files/get-contents'
import { getRichError } from './get-rich-error'
import { getWriteFiles } from './generate-files/get-write-files'
import { tool } from 'ai'
import description from './generate-files.prompt'
import z from 'zod/v3'
import { isSafeSnapshotPath } from '@/lib/learning/snapshots'

const generatedPathsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(240)
      .refine(isSafeSnapshotPath, 'Use a safe relative source-file path')
  )
  .min(1)
  .max(40)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    'Generated file paths must be unique'
  )

interface Params {
  sandboxAccess: SandboxAccess
  modelId: string
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>
}

export const generateFiles = ({ writer, modelId, sandboxAccess }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z.string(),
      paths: generatedPathsSchema,
    }),
    execute: async ({ sandboxId, paths }, { toolCallId, messages, abortSignal }) => {
      writer.write({
        id: toolCallId,
        type: 'data-generating-files',
        data: { sandboxId, paths, status: 'generating' },
      })

      let saveFiles: (files: File[]) => Promise<void>
      try {
        await sandboxAccess.get(sandboxId)
        saveFiles = await sandboxAccess.prepareWriteFiles(sandboxId, paths)
      } catch (error) {
        const richError = getRichError({
          action: 'get sandbox by id',
          args: { sandboxId },
          error,
        })

        writer.write({
          id: toolCallId,
          type: 'data-generating-files',
          data: { error: richError.error, sandboxId, paths, status: 'error' },
        })

        return richError.message
      }

      const writeFiles = getWriteFiles({ saveFiles, sandboxId, toolCallId, writer })
      const iterator = getContents({ messages, modelId, paths, abortSignal })
      const uploaded: File[] = []

      try {
        for await (const chunk of iterator) {
          abortSignal?.throwIfAborted()
          if (chunk.files.length > 0) {
            const error = await writeFiles(chunk)
            if (error) {
              return error
            } else {
              uploaded.push(...chunk.files)
            }
          } else {
            writer.write({
              id: toolCallId,
              type: 'data-generating-files',
              data: {
                sandboxId,
                status: 'generating',
                paths: chunk.paths,
              },
            })
          }
        }
      } catch (error) {
        const richError = getRichError({
          action: 'generate file contents',
          args: { modelId, paths },
          error,
        })

        writer.write({
          id: toolCallId,
          type: 'data-generating-files',
          data: {
            error: richError.error,
            sandboxId,
            status: 'error',
            paths,
          },
        })

        return richError.message
      }

      writer.write({
        id: toolCallId,
        type: 'data-generating-files',
        data: {
          sandboxId,
          paths: uploaded.map((file) => file.path),
          status: 'done',
        },
      })

      return `Successfully generated and uploaded ${uploaded.length} files: ${uploaded
        .map((file) => file.path)
        .join(', ')}. Read the files when their current contents are needed.`
    },
  })

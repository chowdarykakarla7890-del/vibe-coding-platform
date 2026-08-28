import type { DataPart } from '../../messages/data-parts'
import type { File } from './get-contents'
import type { UIMessageStreamWriter, UIMessage } from 'ai'
import { getRichError } from '../get-rich-error'

interface Params {
  saveFiles: (files: File[]) => Promise<void>
  sandboxId: string
  toolCallId: string
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>
}

export function getWriteFiles({ saveFiles, sandboxId, toolCallId, writer }: Params) {
  return async function writeFiles(params: {
    written: string[]
    files: File[]
    paths: string[]
  }) {
    const paths = params.written.concat(params.files.map((file) => file.path))
    writer.write({
      id: toolCallId,
      type: 'data-generating-files',
      data: { sandboxId, paths, status: 'uploading' },
    })

    try {
      await saveFiles(params.files)
    } catch (error) {
      const richError = getRichError({
        action: 'write files to sandbox',
        args: params,
        error,
      })

      writer.write({
        id: toolCallId,
        type: 'data-generating-files',
        data: {
          error: richError.error,
          sandboxId,
          status: 'error',
          paths: params.paths,
        },
      })

      return richError.message
    }

    writer.write({
      id: toolCallId,
      type: 'data-generating-files',
      data: { sandboxId, paths, status: 'uploaded' },
    })
  }
}

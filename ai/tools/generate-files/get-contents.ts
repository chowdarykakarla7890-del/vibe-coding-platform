import { streamText, Output, type ModelMessage } from 'ai'
import { getModelOptions } from '@/ai/gateway'
import { Deferred } from '@/lib/deferred'
import z from 'zod/v3'
import {
  isSafeSnapshotPath,
  MAX_SOURCE_FILE_BYTES,
  sourceByteLength,
} from '@/lib/learning/snapshots'

export type File = z.infer<typeof fileSchema>

const fileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(240)
    .refine(isSafeSnapshotPath, 'Use a safe relative source-file path')
    .describe(
      "Path to the file in the Vercel Sandbox (relative paths from sandbox root, e.g., 'src/main.js', 'package.json', 'components/Button.tsx')"
    ),
  content: z
    .string()
    .max(MAX_SOURCE_FILE_BYTES)
    .refine(
      (content) => sourceByteLength(content) <= MAX_SOURCE_FILE_BYTES,
      'Generated source file exceeds 256 KB'
    )
    .describe(
      'The content of the file as a utf8 string (complete file contents that will replace any existing file at this path)'
    ),
})

interface Params {
  messages: ModelMessage[]
  modelId: string
  paths: string[]
  abortSignal?: AbortSignal
}

interface FileContentChunk {
  files: z.infer<typeof fileSchema>[]
  paths: string[]
  written: string[]
}

export async function* getContents(
  params: Params
): AsyncGenerator<FileContentChunk> {
  const generated: z.infer<typeof fileSchema>[] = []
  const deferred = new Deferred<void>()
  // Observe early provider errors even while elementStream is still unwinding.
  void deferred.promise.catch(() => undefined)
  const generationId = crypto.randomUUID()
  const startedAt = Date.now()
  const cancellation = new AbortController()
  const abortSignal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(270_000), ...(params.abortSignal ? [params.abortSignal] : [])])
  abortSignal.throwIfAborted()
  const result = streamText({
    ...getModelOptions(params.modelId, { reasoningEffort: 'low' }),
    maxOutputTokens: 64000,
    abortSignal,
    system:
      'You generate complete file contents for a code-tutoring workspace. Follow the teaching plan in the conversation: preserve student-authored work, keep requested updates targeted, include useful tests, and leave intentional TODOs when the current milestone is for the student to implement. Never generate lock files, node_modules, build output, or cache files.',
    messages: [
      ...params.messages,
      {
        role: 'user',
        content: `Generate the content of the following files according to the conversation: ${params.paths.map(
          (path) => `\n - ${path}`
        )}`,
      },
    ],
    output: Output.array({ element: fileSchema }),
    onError: (error) => {
      deferred.reject(error)
      console.error('File generation failed', {
        generationId,
        modelId: params.modelId,
        durationMs: Date.now() - startedAt,
      })
    },
  })

  try {
    for await (const file of result.elementStream) {
      abortSignal.throwIfAborted()
      if (!params.paths.includes(file.path)) {
        throw new Error(`The model returned an unrequested file path: ${file.path}`)
      }
      if (generated.some((item) => item.path === file.path)) continue
      const written = generated.map((item) => item.path)
      yield {
        files: [file],
        paths: [...written, file.path],
        written,
      }
      generated.push(file)
    }

    const raceResult = await Promise.race([result.output, deferred.promise])
    if (!raceResult) {
      throw new Error('Unexpected Error: Deferred was resolved before the result')
    }
    abortSignal.throwIfAborted()

    const written = generated.map((file) => file.path)
    const files = raceResult.filter(
      (file, index, allFiles) =>
        params.paths.includes(file.path) &&
        allFiles.findIndex((item) => item.path === file.path) === index &&
        !generated.some((generatedFile) => generatedFile.path === file.path)
    )
    const paths = written.concat(files.map((file) => file.path))
    if (files.length > 0) {
      yield { files, written, paths }
      generated.push(...files)
    }
    if (params.paths.some((path) => !generated.some((file) => file.path === path))) {
      throw new Error('The model did not finish all requested files. Completed files have been saved; retry the missing files.')
    }
  } finally {
    // Closing the iterator after a failed save/Stop must also stop the nested
    // provider request, rather than leaving paid generation running unseen.
    cancellation.abort()
  }
}

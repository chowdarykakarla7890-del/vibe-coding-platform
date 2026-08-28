import type { Session } from '@vercel/sandbox'
import type { SandboxAccess } from './sandbox-access'
import { tool } from 'ai'
import description from './read-files.prompt'
import z from 'zod/v3'
import { isSafeSnapshotPath } from '@/lib/learning/snapshots'
import { truncateUtf8, utf8ByteLength } from '@/lib/text-limits'

const MAX_READ_FILE_BYTES = 32 * 1024
const MAX_READ_RESULT_BYTES = 64 * 1024

async function readUtf8File(sandbox: Session, path: string) {
  const stream = await sandbox.readFile({ path })
  if (!stream) return null

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    const remaining = MAX_READ_FILE_BYTES - size
    if (remaining <= 0) break
    chunks.push(buffer.subarray(0, remaining))
    size += Math.min(buffer.byteLength, remaining)
    if (buffer.byteLength > remaining) break
  }
  const content = Buffer.concat(chunks).toString('utf8')
  return utf8ByteLength(content) >= MAX_READ_FILE_BYTES
    ? `${truncateUtf8(content, MAX_READ_FILE_BYTES - 32)}\n[File truncated]`
    : content
}

export const readFiles = (sandboxAccess: SandboxAccess) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z.string(),
      paths: z
        .array(
          z
            .string()
            .min(1)
            .max(240)
            .refine(isSafeSnapshotPath, 'Use a safe relative source-file path')
        )
        .min(1)
        .max(16)
        .refine((paths) => new Set(paths).size === paths.length),
    }),
    execute: async ({ sandboxId, paths }) => {
      const sandbox = await sandboxAccess.get(sandboxId)
      const files = await Promise.all(
        paths.map(async (path) => ({
          path,
          content: await readUtf8File(sandbox, path),
        }))
      )

      return truncateUtf8(files
        .map(({ path, content }) =>
          content === null
            ? `Path: ${path}\nFile not found.`
            : `Path: ${path}\nContent:\n${content.slice(0, 40_000)}`
        )
        .join('\n\n'), MAX_READ_RESULT_BYTES)
    },
  })

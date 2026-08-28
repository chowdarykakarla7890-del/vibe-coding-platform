import z from 'zod'

export const lineSchema = z.object({
  command: z.string().max(2000).describe('The command that generated the log'),
  args: z.array(z.string().max(2000)).max(24).describe('Arguments passed to the command'),
  stream: z.enum(['stdout', 'stderr']).describe('Stream type of the log'),
  data: z.string().max(65536).describe('The log content'),
  timestamp: z.number().finite().describe('The timestamp of the log entry'),
}).strict()

export const linesSchema = z.object({
  sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  lines: z.array(lineSchema).max(100),
  previous: z.array(lineSchema).max(100),
}).strict()

export const resultSchema = z.object({
  shouldBeFixed: z
    .boolean()
    .describe(
      'Whether the logs contain actionable errors that require code fixes (not just warnings or info messages)'
    ),
  summary: z
    .string()
    .max(8000)
    .describe(
      'A summary of actionable errors found in the logs, including error types, affected files, and specific failure reasons. Empty if no actionable errors found. It can be Markdown for better readability.'
    ),
  paths: z.array(
    z.string().max(512).describe('List of file paths that contain actionable errors.')
  ).max(20),
})

export type Line = z.infer<typeof lineSchema>
export type Lines = z.infer<typeof linesSchema>
export type DiagnosticSummary = z.infer<typeof resultSchema>

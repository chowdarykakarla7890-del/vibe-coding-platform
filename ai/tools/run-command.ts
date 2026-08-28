import type { UIMessageStreamWriter, UIMessage } from 'ai'
import type { DataPart } from '../messages/data-parts'
import type { SandboxAccess } from './sandbox-access'
import { getRichError } from './get-rich-error'
import { tool } from 'ai'
import description from './run-command.prompt'
import z from 'zod/v3'

interface Params {
  sandboxAccess: SandboxAccess
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>
}

export const runCommand = ({ writer, sandboxAccess }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z
        .string()
        .describe('The ID of the Vercel Sandbox to run the command in'),
      command: z
        .string()
        .min(1)
        .max(120)
        .describe(
          "The base command to run (e.g., 'npm', 'node', 'python', 'ls', 'cat'). Do NOT include arguments here. IMPORTANT: Each command runs independently in a fresh shell session - there is no persistent state between commands. You cannot use 'cd' to change directories for subsequent commands."
        ),
      args: z
        .array(z.string().max(240).refine((arg) => !/[\n\r\0]/.test(arg)))
        .max(24)
        .optional()
        .describe(
          "Array of arguments for the command. Each argument should be a separate string (e.g., ['install', '--verbose'] for npm install --verbose, or ['src/index.js'] to run a file, or ['-la', './src'] to list files). IMPORTANT: Use relative paths (e.g., 'src/file.js') or absolute paths instead of trying to change directories with 'cd' first, since each command runs in a fresh shell session."
        ),
      sudo: z
        .literal(false)
        .optional()
        .describe('Whether to run the command with sudo'),
      wait: z
        .boolean()
        .describe(
          'Whether to wait for the command to finish before returning. If true, the command will block until it completes, and you will receive its output.'
        ),
    }),
    execute: async ({ sandboxId, command, wait, args = [] }, { abortSignal, toolCallId }) => {
      writer.write({ id: toolCallId, type: 'data-run-command', data: { sandboxId, command, args, status: 'executing' } })
      let commandId: string | undefined
      try {
        const result = await sandboxAccess.execute(sandboxId, { command, args, wait }, {
          signal: abortSignal,
          onStarted: (started) => {
            commandId = started.cmdId
            writer.write({ id: toolCallId, type: 'data-run-command', data: { sandboxId, commandId, command, args, status: wait ? 'waiting' : 'running' } })
          },
        })
        if (!wait) return `The command has started in the background in sandbox \`${sandboxId}\` with commandId ${result.commandId}.`
        writer.write({ id: toolCallId, type: 'data-run-command', data: { sandboxId, commandId, command, args, status: 'done', exitCode: result.exitCode! } })
        return `The command finished with exit code ${result.exitCode}. Combined output (up to 64 KB${result.outputTruncated ? ', truncated' : ''}):\n\`\`\`\n${result.output}\n\`\`\``
      } catch (error) {
        const richError = getRichError({ action: 'run owned command', args: {}, error })
        if (!abortSignal?.aborted) writer.write({ id: toolCallId, type: 'data-run-command', data: { sandboxId, commandId, command, args, status: 'error', error: richError.error } })
        return richError.message
      }
    },
  })

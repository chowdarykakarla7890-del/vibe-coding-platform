import type { Command, Session } from '@vercel/sandbox'

// An execution capability supplied by the authenticated route, never the model.
export interface SandboxAccess {
  create: (settings: { ports?: number[]; timeout?: number }) => Promise<{ sandboxId: string }>
  // Session handles cannot auto-resume an expired VM behind the quota checks.
  get: (sandboxId: string) => Promise<Session>
  getUrl: (sandboxId: string, port: number) => Promise<string>
  // Success means source is durable as well as applied to the owned sandbox.
  writeFiles: (sandboxId: string, files: Array<{ path: string; content: string }>) => Promise<void>
  prepareWriteFiles: (sandboxId: string, paths: string[]) => Promise<(files: Array<{ path: string; content: string }>) => Promise<void>>
  execute: (sandboxId: string, input: { command: string; args: string[]; wait: boolean }, options: { signal?: AbortSignal; onStarted?: (command: Command) => void }) => Promise<{ commandId: string; exitCode: number | null; output: string; outputTruncated: boolean }>
}

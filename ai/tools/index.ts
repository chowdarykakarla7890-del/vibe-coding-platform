import type { InferUITools, UIMessage, UIMessageStreamWriter } from 'ai'
import type { DataPart } from '../messages/data-parts'
import { createSandbox } from './create-sandbox'
import { generateFiles } from './generate-files'
import { getSandboxURL } from './get-sandbox-url'
import { runCommand } from './run-command'
import { readFiles } from './read-files'
import type { SandboxAccess } from './sandbox-access'

interface Params {
  sandboxAccess: SandboxAccess
  modelId: string
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>
}

export function tools({ modelId, writer, sandboxAccess }: Params) {
  return {
    createSandbox: createSandbox({ writer, sandboxAccess }),
    generateFiles: generateFiles({ writer, modelId, sandboxAccess }),
    getSandboxURL: getSandboxURL({ writer, sandboxAccess }),
    readFiles: readFiles(sandboxAccess),
    runCommand: runCommand({ writer, sandboxAccess }),
  }
}

export type ToolSet = InferUITools<ReturnType<typeof tools>>

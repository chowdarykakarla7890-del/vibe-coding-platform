import { readWithDeadline } from '@/lib/abortable-read'
import { loadChat } from './db'

export const CHAT_LOAD_TIMEOUT_MS = 10_000

export function loadProjectChat(projectId: string, signal: AbortSignal) {
  return readWithDeadline((readSignal) => loadChat(projectId, readSignal), signal, CHAT_LOAD_TIMEOUT_MS,
    'Opening the saved conversation timed out. Please retry; your history has not been changed.')
}

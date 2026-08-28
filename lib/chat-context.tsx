'use client'

import type { DataPart } from '@/ai/messages/data-parts'
import { mapDataToState } from '@/app/state'
import type { ChatUIMessage } from '@/components/chat/types'
import { stopProjectChat } from '@/lib/learning/db'
import { createProjectChatTransport } from '@/lib/chat/transport'
import { loadProjectChat } from '@/lib/learning/load-chat'
import { Button } from '@/components/ui/button'
import { useLearning } from '@/lib/learning/learning-provider'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { readWithDeadline } from '@/lib/abortable-read'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'
import { Chat, useChat, type UseChatHelpers } from '@ai-sdk/react'
import type { ChatRequestOptions, DataUIPart } from 'ai'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

const LOCAL_PROJECT_ID = 'local-playground'
const INACTIVITY_TIMEOUT_MS = 90_000

interface ProjectChatSession {
  chat: Chat<ChatUIMessage>
  projectId: string
  controller: AbortController
  signal: AbortSignal
}

type RetryOptions = ChatRequestOptions & { messageId?: string }

interface ChatContextValue {
  chat: Chat<ChatUIMessage>
  chatState: UseChatHelpers<ChatUIMessage>
  interrupted: boolean
  operation?: 'stopping' | 'reconnecting'
  recoveryError?: string
  retry: (options?: RetryOptions) => Promise<void>
  stalled: boolean
  stop: () => Promise<void>
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined)

export function ChatProvider({ children }: { children: ReactNode }) {
  const {
    activeProjectId,
    isReady,
    projects,
    updateProject,
  } = useLearning()
  const projectId = activeProjectId ?? LOCAL_PROJECT_ID
  const activeProjectIdRef = useRef(projectId)
  const updateProjectRef = useRef(updateProject)
  const sessionsRef = useRef(new Map<string, ProjectChatSession>())
  const [activeSession, setActiveSession] = useState<ProjectChatSession>()
  const [projectSessions, setProjectSessions] = useState<ProjectChatSession[]>([])
  const [loadError, setLoadError] = useState<string>()
  const [loadVersion, setLoadVersion] = useState(0)

  useLayoutEffect(() => {
    activeProjectIdRef.current = projectId
    updateProjectRef.current = updateProject
  }, [projectId, updateProject])

  const createSession = useCallback(
    (sessionProjectId: string, messages: ChatUIMessage[]) => {
      const controller = new AbortController()
      const account = cloudOperation(controller.signal)
      const chat = new Chat<ChatUIMessage>({
        id: `project-${sessionProjectId}`,
        transport: createProjectChatTransport(sessionProjectId, account.signal),
        messages,
        onData: (data: DataUIPart<DataPart>) => {
          if (account.signal.aborted || sessionsRef.current.get(sessionProjectId)?.chat !== chat) return
          if (
            data.type === 'data-create-sandbox' &&
            data.data.status === 'done' &&
            data.data.sandboxId &&
            sessionProjectId !== LOCAL_PROJECT_ID
          ) {
            void updateProjectRef
              .current(sessionProjectId, { sandboxId: data.data.sandboxId }, account.signal)
              .catch((error) => {
                if (account.signal.aborted) return
                console.warn('Could not persist project sandbox', {
                  projectId: sessionProjectId,
                  errorName: error instanceof Error ? error.name : 'UnknownError',
                })
              })
          }

          if (activeProjectIdRef.current === sessionProjectId) {
            mapDataToState(data)
          }
        },
        onError: (error) => {
          if (account.signal.aborted || sessionsRef.current.get(sessionProjectId)?.chat !== chat) return
          if (activeProjectIdRef.current === sessionProjectId) {
            toast.error('The tutor could not finish this response. You can retry safely.')
          }
          console.error('Project chat failed', {
            projectId: sessionProjectId,
            errorName: error.name,
          })
        },
      })

      return { chat, projectId: sessionProjectId, controller, signal: account.signal }
    },
    []
  )

  useEffect(() => {
    const controller = new AbortController()
    const account = cloudOperation(controller.signal)
    const existing = sessionsRef.current.get(projectId)
    void Promise.resolve().then(async () => {
        // The empty account shell must mount Playground so it can create the
        // first real project. Never query the server with this placeholder ID.
        const messages = existing || projectId === LOCAL_PROJECT_ID ? [] : await loadProjectChat(projectId, account.signal)
        if (account.signal.aborted) return
        const current = sessionsRef.current.get(projectId)
        const session =
          current ?? createSession(projectId, messages as ChatUIMessage[])
        sessionsRef.current.set(projectId, session)
        if (!current) setProjectSessions([...sessionsRef.current.values()])
        setLoadError(undefined)
        setActiveSession(session)
      })
      .catch((error) => {
        if (account.signal.aborted) return
        console.warn('Could not load project chat', {
          projectId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        })
        // A failed read is not an empty conversation. Starting a fresh session
        // here could overwrite the saved history on the next successful reply.
        setLoadError(projectId)
      })

    return () => {
      controller.abort()
    }
  }, [createSession, projectId, loadVersion])

  useEffect(() => {
    if (!isReady) return
    const validProjectIds = new Set(projects.map((project) => project.id))
    let removed = false
    for (const [sessionProjectId, session] of sessionsRef.current) {
      if (
        sessionProjectId !== LOCAL_PROJECT_ID &&
        !validProjectIds.has(sessionProjectId)
      ) {
        sessionsRef.current.delete(sessionProjectId)
        session.controller.abort()
        void session.chat.stop()
        removed = true
      }
    }
    if (removed) setProjectSessions([...sessionsRef.current.values()])
  }, [isReady, projects])

  useEffect(() => {
    const sessions = sessionsRef.current
    return () => {
      for (const session of sessions.values()) {
        session.controller.abort()
        void session.chat.stop()
      }
      sessions.clear()
    }
  }, [])

  const active = loadError !== projectId && activeSession?.projectId === projectId
  return <>
    {projectSessions.map(session => (
      <ProjectChatController key={session.projectId} session={session} visible={active && session === activeSession}>
        {active && session === activeSession ? children : null}
      </ProjectChatController>
    ))}
    {loadError === projectId ? <main className="grid h-full min-h-40 place-items-center p-6">
      <section className="max-w-md text-center" role="alert">
        <h1 className="text-lg font-semibold">Saved conversation could not be opened</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your history has not been replaced or cleared. Retry loading it without creating a new conversation.</p>
        <Button className="mt-4" onClick={() => { setLoadError(undefined); setLoadVersion((version) => version + 1) }}>Retry conversation</Button>
      </section>
    </main> : !active ? <main className="grid h-full min-h-40 place-items-center text-sm text-muted-foreground" role="status">Opening project conversation…</main> : null}
  </>
}

// One subscription/controller per opened project. Only its workspace children
// unmount on navigation; stream monitoring and recovery state stay alive.
function ProjectChatController({
  children,
  session,
  visible,
}: {
  children: ReactNode
  session: ProjectChatSession
  visible: boolean
}) {
  const chatState = useChat<ChatUIMessage>({
    chat: session.chat,
    experimental_throttle: 50,
  })
  const {
    messages,
    regenerate,
    setMessages,
    status,
    stop: stopChat,
  } = chatState
  const [interrupted, setInterrupted] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [historyRefreshError, setHistoryRefreshError] = useState(false)
  const [operation, setOperation] = useState<'stopping' | 'reconnecting'>()
  const [recoveryError, setRecoveryError] = useState<string>()
  const operationRef = useRef(false)
  const requestRef = useRef<Promise<void> | undefined>(undefined)
  const recoveryRequired = useRef(false)
  const visibleRef = useRef(visible)
  useLayoutEffect(() => { visibleRef.current = visible }, [visible])
  const previousStatus = useRef(status)
  const lifecycle = useRef<{ runId: string; startedAt: number } | undefined>(
    undefined
  )
  const isActive = status === 'submitted' || status === 'streaming'
  const persistedStatus = !isActive ? messages.at(-1)?.metadata?.persistenceStatus : undefined
  const remotePending = persistedStatus === 'pending'

  useEffect(() => {
    if (!remotePending || historyRefreshError || recoveryError || operation || session.signal.aborted) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, session.signal])
    const timer = setTimeout(() => {
      void loadProjectChat(session.projectId, signal).then((saved) => {
        if (!signal.aborted && !operationRef.current && !requestRef.current) setMessages(saved as ChatUIMessage[])
      }).catch(() => {
        if (!signal.aborted) { setHistoryRefreshError(true); if (visibleRef.current) toast.error('Could not refresh the saved response. Retry to reconnect.') }
      })
    }, 3_000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [historyRefreshError, messages, operation, recoveryError, remotePending, session, setMessages])

  useEffect(() => {
    if (
      previousStatus.current !== status &&
      (status === 'submitted' || status === 'streaming')
    ) {
      if (!operationRef.current) { setInterrupted(false); setStalled(false) }
      if (!lifecycle.current) {
        lifecycle.current = {
          runId: crypto.randomUUID(),
          startedAt: Date.now(),
        }
        console.info('Chat lifecycle', {
          event: 'started',
          projectId: session.projectId,
          runId: lifecycle.current.runId,
          durationMs: 0,
        })
      }
    } else if (lifecycle.current && !isActive) {
      console.info('Chat lifecycle', {
        event: status === 'error' ? 'failed' : 'completed',
        projectId: session.projectId,
        runId: lifecycle.current.runId,
        durationMs: Date.now() - lifecycle.current.startedAt,
      })
      lifecycle.current = undefined
    }
    previousStatus.current = status
  }, [isActive, session.projectId, status])

  const reconcile = useCallback(async () => {
    // A successful Stop receipt is not proof of interruption: completion may
    // have won the race. Only authoritative history can settle that outcome.
    const saved = await loadProjectChat(session.projectId, session.signal) as ChatUIMessage[]
    session.signal.throwIfAborted()
    setMessages(saved)
    setHistoryRefreshError(false)
    setRecoveryError(undefined)
    recoveryRequired.current = false
    if (saved.at(-1)?.metadata?.persistenceStatus === 'complete') {
      setInterrupted(false)
      setStalled(false)
    }
  }, [session, setMessages])

  const stopResponse = useCallback(async (reason: 'interrupted' | 'stalled') => {
    if (session.signal.aborted || operationRef.current) return
    if (!requestRef.current && session.chat.status !== 'submitted' && session.chat.status !== 'streaming' && session.chat.messages.at(-1)?.metadata?.persistenceStatus !== 'pending') return
    operationRef.current = true
    setOperation('stopping')
    setRecoveryError(undefined)
    setInterrupted(reason === 'interrupted')
    setStalled(reason === 'stalled')
    if (lifecycle.current) {
      console.info('Chat lifecycle', { event: reason === 'stalled' ? 'stalled' : 'aborted', projectId: session.projectId,
        runId: lifecycle.current.runId, durationMs: Date.now() - lifecycle.current.startedAt })
      lifecycle.current = undefined
    }
    try {
      await stopChat()
      // Wait for the SDK to finish consuming the cancelled stream before a
      // history reload or Retry can replace its messages/active response.
      const pending = requestRef.current
      if (pending) await readWithDeadline(() => pending, session.signal, 10_000, 'The stream has not closed yet.')
      session.signal.throwIfAborted()
      const assistant = session.chat.messages.at(-1)
      if (assistant?.role === 'assistant') {
        recoveryRequired.current = true
        await awaitMutationReceipt(signal => stopProjectChat(session.projectId, assistant.id, signal), session.signal, 20_000,
          'The server has not confirmed the stop.')
        await reconcile()
      }
    } catch {
      if (session.signal.aborted) return
      recoveryRequired.current = true
      setRecoveryError('Could not confirm the saved response. Retry to reconnect before starting another request.')
    } finally {
      operationRef.current = false
      if (!session.signal.aborted) setOperation(undefined)
    }
  }, [reconcile, session, stopChat])
  const stop = useCallback(() => stopResponse('interrupted'), [stopResponse])

  useEffect(() => {
    // sendMessage may still be converting input when Stop is clicked. Abort
    // again when the SDK actually enters submitted/streaming in that case.
    if (operation === 'stopping' && isActive) void stopChat()
  }, [isActive, operation, stopChat])

  useEffect(() => {
    if (!isActive || operation || session.signal.aborted) return
    const timeoutId = window.setTimeout(() => { void stopResponse('stalled') }, INACTIVITY_TIMEOUT_MS)
    const cancel = () => window.clearTimeout(timeoutId)
    session.signal.addEventListener('abort', cancel, { once: true })
    return () => { cancel(); session.signal.removeEventListener('abort', cancel) }
  }, [isActive, messages, operation, session, stopResponse])

  const runRequest = useCallback(async (start: () => Promise<void>) => {
    if (session.signal.aborted || operationRef.current || requestRef.current || recoveryRequired.current ||
      session.chat.status === 'submitted' || session.chat.status === 'streaming' || session.chat.messages.at(-1)?.metadata?.persistenceStatus === 'pending') return
    setInterrupted(false)
    setStalled(false)
    setRecoveryError(undefined)
    const pending = start()
    requestRef.current = pending
    try { await pending } catch {
      if (!session.signal.aborted) setRecoveryError('The tutor request could not be started. Retry the response.')
    } finally {
      if (requestRef.current === pending) requestRef.current = undefined
    }
  }, [session])
  const sendMessage = useCallback<UseChatHelpers<ChatUIMessage>['sendMessage']>(
    (message, options) => runRequest(() => session.chat.sendMessage(message, options)), [runRequest, session])

  const retry = useCallback(
    async (options?: RetryOptions) => {
      if (session.signal.aborted || operationRef.current) return
      if (historyRefreshError || remotePending || recoveryRequired.current) {
        operationRef.current = true
        setOperation('reconnecting')
        try {
          const pending = requestRef.current
          if (pending) await readWithDeadline(() => pending, session.signal, 10_000, 'The stream has not closed yet.')
          await reconcile()
        } catch {
          if (!session.signal.aborted) { recoveryRequired.current = true; setRecoveryError('Could not reconnect to the saved response. Please retry.') }
        } finally {
          operationRef.current = false
          if (!session.signal.aborted) setOperation(undefined)
        }
        return
      }
      await runRequest(() => regenerate(options))
    },
    [historyRefreshError, reconcile, regenerate, remotePending, runRequest, session]
  )

  const value = useMemo(
    () => ({
      chat: session.chat,
      chatState: { ...chatState, sendMessage, regenerate: retry, stop, status: operation ? 'submitted' as const : recoveryError || historyRefreshError ? 'error' as const : remotePending ? 'streaming' as const : persistedStatus === 'failed' ? 'error' as const : status },
      interrupted: interrupted || persistedStatus === 'interrupted',
      operation,
      recoveryError,
      retry,
      stalled,
      stop,
    }),
    [chatState, historyRefreshError, interrupted, operation, persistedStatus, recoveryError, remotePending, retry, sendMessage, session.chat, stalled, status, stop]
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useSharedChatContext() {
  const context = useContext(ChatContext)
  if (!context) {
    throw new Error('useSharedChatContext must be used within a ChatProvider')
  }
  return context
}

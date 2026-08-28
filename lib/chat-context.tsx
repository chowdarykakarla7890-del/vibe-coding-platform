'use client'

import type { DataPart } from '@/ai/messages/data-parts'
import { mapDataToState } from '@/app/state'
import type { ChatUIMessage } from '@/components/chat/types'
import { stopProjectChat } from '@/lib/learning/db'
import { createProjectChatTransport } from '@/lib/chat/transport'
import { loadProjectChat } from '@/lib/learning/load-chat'
import { Button } from '@/components/ui/button'
import { useLearning } from '@/lib/learning/learning-provider'
import { Chat, useChat, type UseChatHelpers } from '@ai-sdk/react'
import type { ChatRequestOptions, DataUIPart } from 'ai'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
}

type RetryOptions = ChatRequestOptions & { messageId?: string }

interface ChatContextValue {
  chat: Chat<ChatUIMessage>
  chatState: UseChatHelpers<ChatUIMessage>
  interrupted: boolean
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
  const [loadError, setLoadError] = useState<string>()
  const [loadVersion, setLoadVersion] = useState(0)

  useEffect(() => {
    activeProjectIdRef.current = projectId
    updateProjectRef.current = updateProject
  }, [projectId, updateProject])

  const createSession = useCallback(
    (sessionProjectId: string, messages: ChatUIMessage[]) => {
      const chat = new Chat<ChatUIMessage>({
        id: `project-${sessionProjectId}`,
        transport: createProjectChatTransport(sessionProjectId),
        messages,
        onData: (data: DataUIPart<DataPart>) => {
          if (sessionsRef.current.get(sessionProjectId)?.chat !== chat) return
          if (
            data.type === 'data-create-sandbox' &&
            data.data.status === 'done' &&
            data.data.sandboxId &&
            sessionProjectId !== LOCAL_PROJECT_ID
          ) {
            void updateProjectRef
              .current(sessionProjectId, { sandboxId: data.data.sandboxId })
              .catch((error) => {
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
          if (activeProjectIdRef.current === sessionProjectId) {
            toast.error('The tutor could not finish this response. You can retry safely.')
          }
          console.error('Project chat failed', {
            projectId: sessionProjectId,
            errorName: error.name,
          })
        },
      })

      return { chat, projectId: sessionProjectId }
    },
    []
  )

  useEffect(() => {
    const controller = new AbortController()
    const existing = sessionsRef.current.get(projectId)
    void Promise.resolve().then(async () => {
        // The empty account shell must mount Playground so it can create the
        // first real project. Never query the server with this placeholder ID.
        const messages = existing || projectId === LOCAL_PROJECT_ID ? [] : await loadProjectChat(projectId, controller.signal)
        if (controller.signal.aborted) return
        const current = sessionsRef.current.get(projectId)
        const session =
          current ?? createSession(projectId, messages as ChatUIMessage[])
        sessionsRef.current.set(projectId, session)
        setLoadError(undefined)
        setActiveSession(session)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
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
    for (const [sessionProjectId, session] of sessionsRef.current) {
      if (
        sessionProjectId !== LOCAL_PROJECT_ID &&
        !validProjectIds.has(sessionProjectId)
      ) {
        void session.chat.stop()
        sessionsRef.current.delete(sessionProjectId)
      }
    }
  }, [isReady, projects])

  useEffect(() => {
    const sessions = sessionsRef.current
    return () => {
      for (const session of sessions.values()) {
        void session.chat.stop()
      }
      sessions.clear()
    }
  }, [])

  if (loadError === projectId) {
    return <main className="grid h-full min-h-40 place-items-center p-6">
      <section className="max-w-md text-center" role="alert">
        <h1 className="text-lg font-semibold">Saved conversation could not be opened</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your history has not been replaced or cleared. Retry loading it without creating a new conversation.</p>
        <Button className="mt-4" onClick={() => { setLoadError(undefined); setLoadVersion((version) => version + 1) }}>Retry conversation</Button>
      </section>
    </main>
  }

  return activeSession?.projectId === projectId ? (
    <ActiveProjectChat key={activeSession.projectId} session={activeSession}>
      {children}
    </ActiveProjectChat>
  ) : <main className="grid h-full min-h-40 place-items-center text-sm text-muted-foreground" role="status">Opening project conversation…</main>
}

function ActiveProjectChat({
  children,
  session,
}: {
  children: ReactNode
  session: ProjectChatSession
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
  const previousStatus = useRef(status)
  const lifecycle = useRef<{ runId: string; startedAt: number } | undefined>(
    undefined
  )
  const isActive = status === 'submitted' || status === 'streaming'
  const persistedStatus = !isActive ? messages.at(-1)?.metadata?.persistenceStatus : undefined
  const remotePending = persistedStatus === 'pending'

  useEffect(() => {
    if (!remotePending || historyRefreshError) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void loadProjectChat(session.projectId, controller.signal).then((saved) => {
        if (!controller.signal.aborted) setMessages(saved as ChatUIMessage[])
      }).catch(() => {
        if (!controller.signal.aborted) { setHistoryRefreshError(true); toast.error('Could not refresh the saved response. Retry to reconnect.') }
      })
    }, 3_000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [historyRefreshError, messages, remotePending, session.projectId, setMessages])

  useEffect(() => {
    if (
      previousStatus.current !== status &&
      (status === 'submitted' || status === 'streaming')
    ) {
      setInterrupted(false)
      setStalled(false)
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

  useEffect(() => {
    if (!isActive) return
    const timeoutId = window.setTimeout(() => {
      setStalled(true)
      if (lifecycle.current) {
        console.warn('Chat lifecycle', {
          event: 'stalled',
          projectId: session.projectId,
          runId: lifecycle.current.runId,
          durationMs: Date.now() - lifecycle.current.startedAt,
        })
        lifecycle.current = undefined
      }
      void stopChat()
      toast.error('The tutor stopped after 90 seconds without progress. You can retry safely.')
    }, INACTIVITY_TIMEOUT_MS)
    return () => window.clearTimeout(timeoutId)
  }, [isActive, messages, session.projectId, stopChat])

  const stop = useCallback(async () => {
    setInterrupted(true)
    setStalled(false)
    if (lifecycle.current) {
      console.info('Chat lifecycle', {
        event: 'aborted',
        projectId: session.projectId,
        runId: lifecycle.current.runId,
        durationMs: Date.now() - lifecycle.current.startedAt,
      })
      lifecycle.current = undefined
    }
    await stopChat()
    const assistant = session.chat.messages.at(-1)
    if (assistant?.role === 'assistant') {
      await stopProjectChat(session.projectId, assistant.id).catch(() => toast.error('Could not confirm the stop. Reload to check the saved response.'))
      setMessages((current) => current.map((message) => message.id === assistant.id
        ? { ...message, metadata: { model: message.metadata?.model ?? 'Tutor', persistenceStatus: 'interrupted' } } : message)
      )
    }
  }, [session, setMessages, stopChat])

  const retry = useCallback(
    async (options?: RetryOptions) => {
      if (historyRefreshError || remotePending) {
        setHistoryRefreshError(false)
        return
      }
      setInterrupted(false)
      setStalled(false)
      await regenerate(options)
    },
    [historyRefreshError, regenerate, remotePending]
  )

  const value = useMemo(
    () => ({
      chat: session.chat,
      chatState: { ...chatState, status: historyRefreshError ? 'error' as const : remotePending ? 'streaming' as const : persistedStatus === 'failed' ? 'error' as const : status },
      interrupted: interrupted || persistedStatus === 'interrupted',
      retry,
      stalled,
      stop,
    }),
    [chatState, historyRefreshError, interrupted, persistedStatus, remotePending, retry, session.chat, stalled, status, stop]
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

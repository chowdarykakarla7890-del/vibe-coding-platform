'use client'

import { MODEL_NAMES, TEST_PROMPTS } from '@/ai/constants'
import {
  GraduationCapIcon,
  SendIcon,
  SparklesIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Input } from '@/components/ui/input'
import { Message } from '@/components/chat/message'
import {
  ChatProgress,
  hasCurrentAssistantOutput,
} from '@/components/chat/chat-progress'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { ModelSelector } from '@/components/settings/model-selector'
import { Panel, PanelHeader } from '@/components/panels/panels'
import { CodeTutorActions } from '@/components/tutor/code-tutor-actions'
import { useLocalStorageValue } from '@/lib/use-local-storage-value'
import { useCallback, useEffect, useMemo } from 'react'
import { useSharedChatContext } from '@/lib/chat-context'
import { useSettings } from '@/components/settings/use-settings'
import { useSandboxStore } from './state'
import { useLearning } from '@/lib/learning/learning-provider'
import { ErrorMonitorNotice } from '@/components/error-monitor/error-monitor'

interface Props {
  className: string
  modelId?: string
}

export function Chat({ className }: Props) {
  const [input, setInput] = useLocalStorageValue('prompt-input')
  const { chatState, interrupted, retry, stalled, stop } = useSharedChatContext()
  const { modelId, reasoningEffort } = useSettings()
  const { activeProject } = useLearning()
  const { messages, sendMessage, status } = chatState
  const { activeFile, paths, sandboxId, setChatStatus } = useSandboxStore()
  const isActive = status === 'streaming' || status === 'submitted'
  const hasAssistantOutput = hasCurrentAssistantOutput(messages)
  const hideEmptyAssistantShell =
    isActive && messages.at(-1)?.role === 'assistant' && !hasAssistantOutput
  const modelName = MODEL_NAMES[modelId] ?? modelId

  const requestBody = useMemo(
    () => ({
      modelId,
      reasoningEffort,
      projectId: activeProject?.id,
      activityId: activeProject?.activityId,
    }),
    [activeProject?.activityId, activeProject?.id, modelId, reasoningEffort]
  )

  const validateAndSubmitMessage = useCallback(
    (text: string) => {
      if (text.trim() && activeProject && !isActive) {
        sendMessage(
          { text },
          {
            body: requestBody,
          }
        )
        setInput('')
      }
    },
    [activeProject, isActive, requestBody, sendMessage, setInput]
  )

  const retryResponse = useCallback(() => {
    void retry({ body: requestBody })
  }, [requestBody, retry])

  useEffect(() => {
    setChatStatus(status)
  }, [status, setChatStatus])

  useEffect(() => {
    const handleTutorPrompt = (event: Event) => {
      const prompt = (event as CustomEvent<string>).detail
      if (prompt && status === 'ready') validateAndSubmitMessage(prompt)
    }
    window.addEventListener('code-tutor:prompt', handleTutorPrompt)
    return () => window.removeEventListener('code-tutor:prompt', handleTutorPrompt)
  }, [status, validateAndSubmitMessage])

  return (
    <Panel className={className}>
      <PanelHeader>
        <div className="flex items-center font-mono font-semibold uppercase">
          <GraduationCapIcon className="mr-2 w-4 text-zinc-400" />
          Task
        </div>
        <div className="ml-auto font-mono text-xs text-muted-foreground">
          [{stalled ? 'stalled' : interrupted ? 'interrupted' : status}]
        </div>
      </PanelHeader>

      {messages.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex min-h-full flex-col justify-center">
            <div className="mb-5 grid size-10 place-items-center rounded-lg border border-border bg-secondary text-zinc-300">
              <SparklesIcon className="size-5" />
            </div>
            <h1 className="text-xl font-medium tracking-tight">What do you want to build?</h1>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              Describe the outcome. The tutor will create a sandbox, guide the implementation,
              and help you verify the result.
            </p>
            <Suggestions className="mt-5 max-w-[300px] pb-2">
              {TEST_PROMPTS.map((prompt, idx) => (
                <Suggestion
                  className="w-[260px] whitespace-normal rounded-lg px-3 py-3 text-xs leading-5"
                  key={idx}
                  onSuggestionClick={validateAndSubmitMessage}
                  suggestion={prompt}
                >
                  <span className="mr-2 text-zinc-400">→</span>{prompt}
                </Suggestion>
              ))}
            </Suggestions>
            <div className="mt-5 rounded-lg border border-border bg-secondary/40 p-3 font-mono text-[11px] leading-4 text-muted-foreground">
              Plan → edit → run → review
            </div>
          </div>
        </div>
      ) : (
        <Conversation className="relative w-full" isStreaming={isActive}>
          <ConversationContent className="space-y-4">
            {messages.map((message, index) =>
              hideEmptyAssistantShell && index === messages.length - 1 ? null : (
                <Message
                  isStreaming={index === messages.length - 1 && isActive}
                  key={message.id}
                  message={message}
                />
              )
            )}
            <ChatProgress
              hasAssistantOutput={hasAssistantOutput}
              interrupted={interrupted}
              modelName={modelName}
              onRetry={retryResponse}
              onStop={() => void stop()}
              stalled={stalled}
              status={status}
            />
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <ErrorMonitorNotice />
      <CodeTutorActions
        activeFile={activeFile}
        disabled={status !== 'ready' || !sandboxId || paths.length === 0}
        onPrompt={validateAndSubmitMessage}
        paths={paths}
      />

      <form
        className="border-t border-border bg-card p-2"
        onSubmit={async (event) => {
          event.preventDefault()
          validateAndSubmitMessage(input)
        }}
      >
        <div className="rounded-lg border border-border bg-secondary/50 p-1.5 focus-within:border-zinc-500 focus-within:ring-1 focus-within:ring-zinc-500">
          <Input
            className="h-10 w-full rounded-lg border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0"
            disabled={isActive || !activeProject}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question or describe what you want to learn…"
            value={input}
          />
          <div className="flex items-center gap-1.5 pt-1">
            <ModelSelector />
            <span className="ml-2 hidden text-[10px] text-muted-foreground xl:inline">
              Your tutor will ask before replacing your work
            </span>
            <Button
              aria-label="Send message"
              className="ml-auto size-8 rounded-md bg-foreground text-background hover:bg-zinc-200"
              type="submit"
              disabled={status !== 'ready' || !activeProject || !input.trim()}
            >
              <SendIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      </form>
    </Panel>
  )
}

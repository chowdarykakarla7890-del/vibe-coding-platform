import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCloudAccount } from '@/lib/learning/cloud-request'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunCommand } from '../components/chat/message-part/run-command'
import {
  ChatProgress,
  hasCurrentAssistantOutput,
} from '../components/chat/chat-progress'
import {
  CommandOutputError,
  streamCommandLogs,
} from '../components/commands-logs/api'
import { Preview } from '../components/preview/preview'

describe('chat tool output', () => {
  beforeEach(() => setCloudAccount(crypto.randomUUID()))
  afterEach(() => { setCloudAccount(undefined); vi.unstubAllGlobals() })

  it('renders an interrupted command as terminal instead of loading forever', () => {
    const html = renderToStaticMarkup(
      createElement(RunCommand, {
        isStreaming: false,
        message: {
          sandboxId: 'sbx_test',
          commandId: 'cmd_test',
          command: 'pnpm',
          args: ['test'],
          status: 'waiting',
        },
      })
    )

    expect(html).toContain('Interrupted')
    expect(html).toContain('This command did not finish')
    expect(html).not.toContain('animate-spin')
  })

  it('stops reading when the command record is no longer available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'COMMAND_EXPIRED',
              message: 'This command output is no longer available. Run the command again.',
              requestId: 'request-test',
            },
          }),
          { status: 410, headers: { 'content-type': 'application/json' } }
        )
      )
    )

    const iterator = streamCommandLogs('sbx_test', 'cmd_test')
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'COMMAND_EXPIRED',
      status: 410,
    } satisfies Partial<CommandOutputError>)
  })

  it('resumes command output from a cursor and exposes terminal status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        [
          JSON.stringify({
            type: 'log',
            cursor: 'v3.4.0',
            data: '\u001b[32mpassed\u001b[0m',
            stream: 'stdout',
            timestamp: 123,
          }),
          JSON.stringify({ type: 'status', status: 'done', exitCode: 0 }),
          '',
        ].join('\n'),
        { headers: { 'content-type': 'application/x-ndjson' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const records = []
    for await (const record of streamCommandLogs('sbx_test', 'cmd_test', 'v3.3.0')) {
      records.push(record)
    }

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sandboxes/sbx_test/cmds/cmd_test/logs?cursor=v3.3.0',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    )
    expect(records).toEqual([
      {
        type: 'log',
        cursor: 'v3.4.0',
        data: 'passed',
        stream: 'stdout',
        timestamp: 123,
      },
      { type: 'status', status: 'done', exitCode: 0 },
    ])
  })

  it('shows immediate planning feedback and a terminal retry state', () => {
    const submitted = renderToStaticMarkup(
      createElement(ChatProgress, {
        hasAssistantOutput: false,
        interrupted: false,
        modelName: 'Claude Opus 4.6',
        onRetry: () => undefined,
        onStop: () => undefined,
        stalled: false,
        status: 'submitted',
      })
    )
    expect(submitted).toContain('Tutor is planning')
    expect(submitted).toContain('Assistant (Claude Opus 4.6)')
    expect(submitted).toContain('data-state="planning"')
    expect(submitted).toContain('duration-500')
    expect(submitted).toContain('motion-reduce:transition-none')
    expect(submitted).toContain('[animation-duration:1.35s]')
    expect(submitted).toContain('role="status"')
    expect(submitted).toContain('aria-label="Stop tutor response"')
    expect(submitted).toContain('Stop')

    const streaming = renderToStaticMarkup(
      createElement(ChatProgress, {
        hasAssistantOutput: true,
        interrupted: false,
        modelName: 'Claude Opus 4.6',
        onRetry: () => undefined,
        onStop: () => undefined,
        stalled: false,
        status: 'streaming',
      })
    )
    expect(streaming).toContain('Tutor is working')
    expect(streaming).toContain('data-state="working"')
    expect(streaming).toContain('aria-hidden="true"')

    const stalled = renderToStaticMarkup(
      createElement(ChatProgress, {
        hasAssistantOutput: false,
        interrupted: false,
        modelName: 'Claude Opus 4.6',
        onRetry: () => undefined,
        onStop: () => undefined,
        stalled: true,
        status: 'ready',
      })
    )
    expect(stalled).toContain('90 seconds without progress')
    expect(stalled).toContain('Retry')
    expect(stalled).not.toContain('animate-spin')
  })

  it('ignores metadata-only and step-only assistant updates', () => {
    expect(
      hasCurrentAssistantOutput([
        {
          id: 'assistant-empty',
          role: 'assistant',
          metadata: { model: 'Claude Opus 4.6' },
          parts: [],
        },
      ])
    ).toBe(false)

    expect(
      hasCurrentAssistantOutput([
        {
          id: 'assistant-step',
          role: 'assistant',
          metadata: { model: 'Claude Opus 4.6' },
          parts: [{ type: 'step-start' }],
        },
      ])
    ).toBe(false)

    expect(
      hasCurrentAssistantOutput([
        {
          id: 'assistant-text',
          role: 'assistant',
          metadata: { model: 'Claude Opus 4.6' },
          parts: [{ type: 'text', text: 'Hello', state: 'done' }],
        },
      ])
    ).toBe(true)
  })

  it('restricts previews to Vercel Sandbox origins', () => {
    const valid = renderToStaticMarkup(
      createElement(Preview, {
        url: 'https://3000-sbx-test.vercel.run',
      })
    )
    const invalid = renderToStaticMarkup(
      createElement(Preview, { url: 'https://example.com/phishing' })
    )
    const rootDomain = renderToStaticMarkup(
      createElement(Preview, { url: 'https://vercel.run/' })
    )

    expect(valid).toContain('title="Sandbox preview"')
    expect(valid).toContain('sandbox="allow-downloads allow-forms')
    expect(valid).toContain('rel="noopener noreferrer"')
    expect(invalid).not.toContain('<iframe')
    expect(rootDomain).not.toContain('<iframe')
  })
})

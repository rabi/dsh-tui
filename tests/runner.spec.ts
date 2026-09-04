/** Runner: agent lifecycle, event application, in-terminal approval, shutdown. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig, { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-default-model'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
// Empty type imports carry the event-map merges the runner dispatches through.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import { apply } from '../src/index.ts'
import type { TuiStartupValues } from '../src/startup.ts'

/** Test-side observation of the mocked pi-tui surface. */
const captured = vi.hoisted(() => ({
  inputListeners: [] as Array<(data: string) => { consume?: boolean } | undefined>,
  editors: [] as Array<{ onSubmit: ((text: string) => void) | null }>,
  markdowns: [] as Array<{ text: string }>,
  screens: [] as Array<{ children: unknown[] }>,
}))

vi.mock('@earendil-works/pi-tui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-tui')>()
  return {
    ...actual,
    ProcessTerminal: class {
      start(): void {}
      stop(): void {}
    },
    TuiMainScreen: class {
      children: unknown[] = []
      constructor() {
        captured.screens.push(this)
      }
      start(): void {}
      stop(): void {}
      requestRender(): void {}
      addChild(child: unknown): void {
        this.children.push(child)
      }
      setFocus(): void {}
      addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void {
        captured.inputListeners.push(listener)
        return () => {
          const i = captured.inputListeners.indexOf(listener)
          if (i >= 0) captured.inputListeners.splice(i, 1)
        }
      }
    },
    Editor: class {
      onSubmit: ((text: string) => void) | null = null
      constructor() {
        captured.editors.push(this)
      }
      addToHistory(): void {}
    },
    Markdown: class {
      text: string
      constructor(text: string) {
        this.text = text
        captured.markdowns.push(this)
      }
      setText(text: string): void {
        this.text = text
      }
      render(): string[] {
        return [this.text]
      }
    },
  }
})

afterEach(() => {
  captured.inputListeners.length = 0
  captured.editors.length = 0
  captured.markdowns.length = 0
  captured.screens.length = 0
})

function userMsg(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** One command definition as the fake runtime stores it. */
interface FakeCommandDefinition {
  name: string
  description: string
  handler: (invocation: { rawInput: string }) => unknown
}

interface BenchOptions {
  startup?: TuiStartupValues
  before?(session: Session): void
  afterPrompt?(session: Session, message: UserMessage): Promise<void> | void
  resumeHistory?(session: Session): void
  /** Reject agent creation with this value. */
  failCreateWith?: unknown
  /** Reject handle disposal with this value. */
  failDisposeWith?: unknown
  /** Corrupt one history read so the replay guard fires. */
  gapAtSeq?: number
  /** Make model-info resolution fail so the status line drops the window. */
  failLlmInfo?: boolean
  /** Do not provide the llm service at all. */
  noLlm?: boolean
  /** Do not provide the command runtime at all. */
  noCommands?: boolean
  /** Make every command execution reject before settlement. */
  failCommands?: boolean
  /** Report an empty model catalog from listModels. */
  emptyModels?: boolean
  /** Report no providers at all from listProviders. */
  noProviders?: boolean
  /** Reject settings.replace with this value so saving the model default fails. */
  failSettingsWith?: unknown
  /** Skill catalog for the /name invocation check; 'observation' makes list() return a non-array observation. */
  skills?: Array<{ name: string; userInvocable: boolean }> | 'observation'
  /** Make skills.list reject. */
  failSkills?: boolean
}

interface BenchRun {
  code: Promise<number>
  mounted: Promise<void>
  err(): string
  order: string[]
}

interface Bench {
  ctx: Context
  agent: Agent
  createdSessionIds: string[]
  followups(): UserMessage[]
  cancels(): Array<{ kind: string }>
  registeredCommands: Array<{ name: string; handler: (invocation: { rawInput: string }) => unknown }>
  transcriptText(): string
  /** Swap the stored agent-default-model settings section, like an edited settings file. */
  setDefaultModel(section: { provider: string; model: string; reasoningEffort?: string }): void
  /** Count of settings.replace calls (model-default saves). */
  replaceCalls(): number
  run(): BenchRun
  submit(text: string): void
  press(data: string): void
  answerApproval(key: string): void
}

async function bench(benchOptions: BenchOptions): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  if (benchOptions.startup !== undefined) ctx.provide('tuiStartup', benchOptions.startup)
  if (!benchOptions.noLlm) {
    ctx.provide('llm', {
      resolveModelInfo: async (): Promise<unknown> => {
        if (benchOptions.failLlmInfo) throw new Error('offline adapter')
        return { context: { contextWindow: 164_000 } }
      },
      resolveCallConfig: async (config: { provider: string; model: string }): Promise<unknown> => {
        if (config.model === 'gone-model') throw new Error('model gone from the catalog')
        return config.model === 'effort-model' ? { ...config, reasoningEffort: 'high' } : config
      },
      listModels: async (provider: string): Promise<unknown[]> => {
        if (benchOptions.emptyModels) return []
        if (provider === 'alt-provider') return [{ provider, id: 'alt-model', name: 'Alt Model' }]
        return [{ provider, id: 'test-model', name: 'Test Model' }, { provider, id: 'other-model', name: 'Other Model' }]
      },
      listProviders: (): unknown[] =>
        benchOptions.noProviders
          ? []
          : [{ id: 'test-provider', name: 'Test Provider' }, { id: 'alt-provider', name: 'Alt Provider' }],
    } as never)
  }
  // Stateful stand-in for the settings service: installSection captures each
  // namespace's base entry and replace swaps its user layer, mirroring the
  // watcher-driven source swap an edited settings file causes.
  interface SettingsHooks { setSource: (read: () => unknown) => void; onChange?: () => void }
  const settingsSections = new Map<string, { base: unknown; user: unknown; onChange?: () => void }>()
  let replaceCallCount = 0
  ctx.provide('settings', {
    installSection: (_owner: unknown, ns: string, _schema: unknown, entry: unknown, hooks: SettingsHooks): void => {
      const section = { base: entry, user: {} as unknown, onChange: hooks.onChange }
      settingsSections.set(ns, section)
      hooks.setSource(() => ({ ...(section.base as object), ...(section.user as object) }))
      hooks.onChange?.()
    },
    replace: async (ns: string, section: object): Promise<void> => {
      if (benchOptions.failSettingsWith !== undefined) throw benchOptions.failSettingsWith
      const target = settingsSections.get(ns)
      if (target === undefined) throw new Error(`unknown settings namespace ${ns}`)
      replaceCallCount += 1
      target.user = section
      target.onChange?.()
    },
  } as never)
  if (benchOptions.skills !== undefined || benchOptions.failSkills) {
    ctx.provide('skills', {
      list: async (): Promise<unknown> => {
        if (benchOptions.failSkills) throw new Error('catalog offline')
        if (benchOptions.skills === 'observation') return { complete: false }
        return (benchOptions.skills ?? []).map(entry => ({
          name: entry.name,
          invocation: { modelInvocable: true, userInvocable: entry.userInvocable },
        }))
      },
    } as never)
  }

  // Minimal stand-in for the dsh-base command runtime: it parses the line,
  // dispatches to a registered handler, settles the command/done session event
  // exactly like the real executor, and rethrows unsettled failures.
  const registeredCommands: FakeCommandDefinition[] = []
  let commandSeq = 0
  if (!benchOptions.noCommands) {
    ctx.provide('commands', {
      register: (definition: FakeCommandDefinition): (() => void) => {
        registeredCommands.push(definition)
        return (): void => {
          const i = registeredCommands.indexOf(definition)
          if (i >= 0) registeredCommands.splice(i, 1)
        }
      },
      list: (): unknown[] => [],
      find: (): undefined => undefined,
      execute: async (agentArg: { session: Session }, line: string, _images: readonly unknown[], signal: AbortSignal): Promise<unknown> => {
        if (benchOptions.failCommands) throw new Error('command runtime offline')
        const parsed = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(line)
        if (parsed === null || parsed[1] === undefined) return undefined
        const definition = registeredCommands.find(d => d.name === parsed[1])
        if (definition === undefined) return undefined
        const id = CommandId(`cmd-${String(++commandSeq)}`)
        try {
          const outcome = await definition.handler({ commandId: id, agent: agentArg, rawInput: parsed[2] ?? '', attachments: [], signal })
          const result = typeof outcome === 'string'
            ? { kind: 'success' as const }
            : outcome as { kind: 'success' | 'error'; text?: string }
          agentArg.session.append('command/done', {
            commandId: id,
            kind: result.kind,
            ...(result.text === undefined ? {} : { text: result.text }),
          })
          return { commandId: id, result }
        } catch (error) {
          const hasText = error instanceof Error || typeof error === 'string'
          agentArg.session.append('command/done', hasText
            ? { commandId: id, kind: 'error', text: error instanceof Error ? error.message : String(error) }
            : { commandId: id, kind: 'error' })
          throw error
        }
      },
    } as never)
  }

  const followups: UserMessage[] = []
  const cancels: Array<{ kind: string }> = []
  const createdSessionIds: string[] = []
  let agent: Agent | undefined

  const makeHandle = (ownerCtx: Context, session: Session, createOpts: CreateAgentOptions): AgentHandle => {
    const agentCtx = ownerCtx.extend({ agent: {} as Agent })
    const handleAgent = {} as Agent
    Object.assign(handleAgent, {
      id: session.id,
      options: createOpts.agentOptions ?? {},
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: agentCtx,
      cancel: (cause: { kind: string }) => { cancels.push(cause) },
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        followups.push(message)
        handleAgent.inbox.append('next-turn', message)
        void Promise.resolve().then(() => benchOptions.afterPrompt?.(session, message))
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => Promise.resolve(),
    })
    agent = handleAgent
    if (benchOptions.gapAtSeq !== undefined) {
      const real = session.eventAt.bind(session)
      ;(session as unknown as { eventAt: (seq: SessionSeq) => unknown }).eventAt =
        (seq: SessionSeq) => (Number(seq) === benchOptions.gapAtSeq ? undefined : real(seq))
    }
    return {
      agent: handleAgent,
      dispose: async (): Promise<void> => {
        if (benchOptions.failDisposeWith !== undefined) throw benchOptions.failDisposeWith
      },
    }
  }

  ctx.agents.setFactory({
    async createAgent(ownerCtx, createOptions) {
      if (benchOptions.failCreateWith !== undefined) throw benchOptions.failCreateWith
      createdSessionIds.push(createOptions.sessionId)
      const session = ctx.sessions.create(createOptions.sessionId,
        createOptions.meta === undefined ? {} : { meta: createOptions.meta })
      const handle = makeHandle(ownerCtx, session, createOptions)
      await createOptions.setup?.(handle.agent.ctx)
      benchOptions.before?.(handle.agent.session)
      ctx.agents.register(handle.agent)
      return handle
    },
    async resume(ownerCtx, resumeOptions) {
      const session = ctx.sessions.create(resumeOptions.resumeSessionId)
      benchOptions.resumeHistory?.(session)
      const handle = makeHandle(ownerCtx, session, {
        sessionId: resumeOptions.resumeSessionId,
        ...resumeOptions.agentOptions === undefined ? {} : { agentOptions: resumeOptions.agentOptions },
        ...resumeOptions.setup === undefined ? {} : { setup: resumeOptions.setup },
      })
      ctx.agents.register(handle.agent)
      return handle
    },
  })

  return {
    ctx,
    get agent() {
      if (agent === undefined) throw new Error('no agent created yet')
      return agent
    },
    createdSessionIds,
    followups: () => followups,
    cancels: () => cancels,
    registeredCommands,
    transcriptText: (): string => {
      const transcript = captured.screens[0]?.children[0] as { render(width: number): string[] } | undefined
      return transcript === undefined ? '' : transcript.render(200).join('\n')
    },
    setDefaultModel: (section: { provider: string; model: string; reasoningEffort?: string }): void => {
      const target = settingsSections.get(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE)
      if (target === undefined) throw new Error('agent-default-model section not installed')
      target.user = section
      target.onChange?.()
    },
    replaceCalls: (): number => replaceCallCount,
    run: () => {
      captured.inputListeners.length = 0
      captured.editors.length = 0
      captured.markdowns.length = 0
      captured.screens.length = 0
      const order: string[] = []
      let err = ''
      const originalStderr = process.stderr.write.bind(process.stderr)
      process.stderr.write = (chunk: string) => { err += chunk; return true }
      ctx.on('session/flush', () => { order.push('flush') })
      const code = new Promise<number>((resolve) => {
        ctx.provide('appExit', (c: number) => { order.push('exit'); resolve(c) })
      })
      void code.then(() => { process.stderr.write = originalStderr })
      apply(ctx)
      const mounted = waitFor(() => captured.editors.length > 0, 'the TUI to mount')
      return { code, mounted, err: () => err, order }
    },
    submit(text: string): void {
      const editor = captured.editors[0]
      if (editor?.onSubmit == null) throw new Error('editor not mounted')
      editor.onSubmit(text)
    },
    press(data: string): void {
      const listener = captured.inputListeners[0]
      if (listener === undefined) throw new Error('no runner input listener')
      listener(data)
    },
    answerApproval(key: string): void {
      const listener = captured.inputListeners[captured.inputListeners.length - 1]
      if (listener === undefined) throw new Error('no approval listener active')
      listener(key)
    },
  }
}

describe('tui runner', () => {
  it('streams a prompt round trip into the transcript and exits 0 on /exit', async () => {
    const test = await bench({
      startup: {},
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', {
          turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
        })
        session.append('assistant/chunk', {
          turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' },
        })
        session.append('assistant/chunk', {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi ' },
        })
        session.append('assistant/chunk', {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'there' },
        })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          usage: { inputTokens: 1000, outputTokens: 2345 },
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'thinking…' },
              { type: 'text', text: 'hi there' },
              { type: 'tool-call', id: ToolCallId('tc1'), name: 'bash', arguments: '{}' },
            ],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })
    const running = test.run()
    await running.mounted
    test.submit('hello')
    await waitFor(() => test.followups().length === 1, 'the followup')
    await waitFor(() => captured.markdowns.some(m => m.text === 'hi there'), 'the streamed answer')
    const status = captured.screens[0]?.children[3] as { render(width: number): string[] } | undefined
    if (status === undefined) throw new Error('status line not mounted')
    expect(status.render(200)[0]).toContain('3.3k/164k')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    expect(running.order).toEqual(['flush', 'exit'])
    expect(running.err()).toBe('')
    const sent = test.followups()[0]
    expect(sent?.content.filter(b => b.type === 'text').map(b => b.text).join('')).toBe('hello')
    await test.ctx.fiber.dispose()
  })

  it('replays a resumed session including tools, errors, and edge shapes', async () => {
    const longText = 'x'.repeat(250)
    const test = await bench({
      startup: { resumeSessionId: 'session-resume' },
      resumeHistory(session) {
        // Committed assistant message without a live draft.
        session.append('turn/start', { turn: 0 })
        session.append('step/start', { turn: 0, step: 1 })
        session.append('user/message', userMsg('old question'), { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn: 0,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'old answer' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 0, step: 1 })
        session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
        // A plugin-sourced user message and an empty one are not prompts.
        session.append('user/message', {
          ...userMsg('injected'),
          source: { kind: 'plugin', plugin: 'test-plugin' },
        }, { surfaceOp: 'append' })
        session.append('user/message', createUserMessage({ content: [], source: { kind: 'user' } }),
          { surfaceOp: 'append' })
        // Tools: ok result, error-flagged result, error field, empty output, long output.
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{"command":"ls"}',
        })
        // File mutations render as diffs; a malformed edit falls back to the generic line.
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c5'), name: 'edit',
          arguments: JSON.stringify({ file_path: 'src/a.ts', old_string: 'old one\nold two', new_string: 'new one' }),
        })
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c6'), name: 'write',
          arguments: JSON.stringify({ file_path: 'src/b.ts', content: 'fresh file' }),
        })
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c7'), name: 'edit', arguments: '{not json',
        })
        // Validation misses fall back to the generic line too.
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c8'), name: 'edit', arguments: '"just a string"',
        })
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c9'), name: 'write', arguments: '{"foo":1}',
        })
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c10'), name: 'edit',
          arguments: '{"file_path":"x.ts","old_string":"a"}',
        })
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c11'), name: 'write',
          arguments: '{"file_path":"y.ts","content":42}',
        })
        // A non-edit/write tool with a file_path still falls back generically.
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('c12'), name: 'patch', arguments: '{"file_path":"z.ts"}',
        })
        session.append('tool/result', {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('c1'),
            content: [{ type: 'text', text: 'file listing' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
        session.append('tool/result', {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('c2'),
            content: [{ type: 'text', text: 'boom output' }],
            isError: true,
          }),
        }, { surfaceOp: 'append' })
        session.append('tool/result', {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('c3'),
            content: [],
            isError: false,
          }),
          error: { name: 'ToolError', code: 'PROVIDER_REFUSED' },
        }, { surfaceOp: 'append' })
        session.append('tool/result', {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('c4'),
            content: [{ type: 'text', text: longText }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'TEST_ERROR', message: 'boom' } },
        })
        // An empty assistant message renders nothing.
        session.append('turn/start', { turn: 2 })
        session.append('step/start', { turn: 2, step: 1 })
        session.append('assistant/message', {
          turn: 2,
          step: 1,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 200 },
          message: createAssistantMessage({
            content: [],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 2, step: 1 })
        session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      },
    })
    const running = test.run()
    await running.mounted
    await waitFor(() => captured.markdowns.some(m => m.text === 'old answer'), 'the replayed answer')
    const transcript = test.transcriptText()
    expect(transcript).toContain('⚙ edit src/a.ts')
    expect(transcript).toContain('- old one')
    expect(transcript).toContain('+ new one')
    expect(transcript).toContain('⚙ write src/b.ts')
    expect(transcript).toContain('+ fresh file')
    expect(transcript).toContain('⚙ edit({not json)')
    expect(transcript).toContain('⚙ edit("just a string")')
    expect(transcript).toContain('⚙ write({"foo":1})')
    const status = captured.screens[0]?.children[3] as { render(width: number): string[] } | undefined
    if (status === undefined) throw new Error('status line not mounted')
    expect(status.render(200)[0]).toContain('200/164k')
    test.submit('/quit')
    expect(await running.code).toBe(0)
    expect(running.order).toEqual(['flush', 'exit'])
    await test.ctx.fiber.dispose()
  })

  it('answers approval prompts in-terminal: y, queued n, abort, and foreign agents pass through', async () => {
    const test = await bench({ startup: {} })
    const running = test.run()
    await running.mounted
    const { ctx, agent } = test
    const defaultAnswer = (): Promise<'unavailable'> => Promise.resolve('unavailable')
    const first = ctx.waterfall(scopeTarget(agent, agent), 'approval/request',
      { agent, toolName: 'bash', reason: 'runs ls' }, defaultAnswer)
    test.answerApproval('y')
    await expect(first).resolves.toBe('allowed-once')

    const second = ctx.waterfall(scopeTarget(agent, agent), 'approval/request',
      { agent, toolName: 'bash' }, defaultAnswer)
    const third = ctx.waterfall(scopeTarget(agent, agent), 'approval/request',
      { agent, toolName: 'read_file' }, defaultAnswer)
    await waitFor(() => captured.inputListeners.length === 2, 'the queued prompt to open')
    test.answerApproval('n')
    await expect(second).resolves.toBe('rejected')
    test.answerApproval('y')
    await expect(third).resolves.toBe('allowed-once')

    const controller = new AbortController()
    const aborted = ctx.waterfall(scopeTarget(agent, agent), 'approval/request',
      { agent, toolName: 'bash', signal: controller.signal }, defaultAnswer)
    controller.abort()
    await expect(aborted).resolves.toBe('cancelled')

    const foreign = {} as Agent
    const passed = ctx.waterfall(scopeTarget(foreign, foreign), 'approval/request',
      { agent: foreign, toolName: 'bash' }, defaultAnswer)
    await expect(passed).resolves.toBe('unavailable')

    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('cancels on Ctrl+C while running and exits on Ctrl+C or Ctrl+D while idle', async () => {
    const test = await bench({ startup: {} })
    const running = test.run()
    await running.mounted
    const { agent } = test
    // Events from other sessions are ignored by the runner listener.
    test.ctx.sessions.create().append('turn/start', { turn: 0 })
    ;(agent as unknown as { status: string }).status = 'running'
    test.press('\x03')
    expect(test.cancels()).toEqual([{ kind: 'user' }])
    ;(agent as unknown as { status: string }).status = 'idle'
    test.press('\x03')
    test.press('\x04')
    expect(await running.code).toBe(0)
    expect(running.order).toEqual(['flush', 'exit'])
    await test.ctx.fiber.dispose()
  })

  it('honors --session for the fresh session id', async () => {
    const test = await bench({ startup: { sessionId: 'fixed-id' } })
    const running = test.run()
    await running.mounted
    expect(test.createdSessionIds).toEqual(['fixed-id'])
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('handles /help and /clear locally without prompting the agent', async () => {
    const test = await bench({ startup: {} })
    const running = test.run()
    await running.mounted
    const screen = captured.screens[0]
    const transcript = screen?.children[0] as { render(width: number): string[] } | undefined
    if (transcript === undefined) throw new Error('transcript not mounted')
    test.submit('/help')
    expect(transcript.render(80).join('\n')).toContain('commands:')
    test.submit('/clear')
    expect(transcript.render(80)).toEqual([])
    expect(test.followups()).toHaveLength(0)
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('drops the context window from the status line when model info is unavailable', async () => {
    for (const options of [{ failLlmInfo: true }, { noLlm: true }] as const) {
      const test = await bench({ startup: {}, ...options })
      const running = test.run()
      await running.mounted
      const status = captured.screens[0]?.children[3] as { render(width: number): string[] } | undefined
      if (status === undefined) throw new Error('status line not mounted')
      const line = status.render(200)[0] ?? ''
      expect(line).toContain('0 ctx')
      expect(line).not.toContain('164k')
      test.submit('/exit')
      expect(await running.code).toBe(0)
      await test.ctx.fiber.dispose()
    }
  })

  it('replays command outcomes and a model selection from history', async () => {
    const test = await bench({
      startup: { resumeSessionId: 'session-cmd' },
      resumeHistory(session) {
        session.append('command/run', {
          commandId: CommandId('cmd-1'), name: 'model', args: 'test-provider/resumed-model', source: { kind: 'user' },
        })
        session.append('command/done', {
          commandId: CommandId('cmd-1'), kind: 'success', text: 'model: test-provider/resumed-model',
        })
        session.append('model/selection', { provider: 'test-provider', model: 'resumed-model' })
      },
    })
    const running = test.run()
    await running.mounted
    await waitFor(() => test.transcriptText().includes('model: test-provider/resumed-model'), 'the replayed command note')
    const status = captured.screens[0]?.children[3] as { render(width: number): string[] } | undefined
    if (status === undefined) throw new Error('status line not mounted')
    expect(status.render(200)[0]).toContain('resumed-model')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('routes /model through the command runtime: show, list, switch, and usage errors', async () => {
    const test = await bench({ startup: {} })
    const running = test.run()
    await running.mounted
    test.submit('/model')
    await waitFor(() => test.transcriptText().includes('model: test-provider/test-model — /model list · /model <id>'), 'the current model note')
    test.submit('/model list')
    await waitFor(() => test.transcriptText().includes('test-provider: * test-model, other-model'), 'the model list')
    // A multi-line result renders one note per provider.
    await waitFor(() => test.transcriptText().includes('alt-provider: alt-model'), 'the second provider note')
    test.submit('/model test-provider/new-model')
    await waitFor(() => test.transcriptText().includes('model: test-provider/new-model'), 'the switch note')
    const status = captured.screens[0]?.children[3] as { render(width: number): string[] } | undefined
    if (status === undefined) throw new Error('status line not mounted')
    expect(status.render(200)[0]).toContain('new-model')
    // A bare model id keeps the current provider; the adapter may add an effort.
    test.submit('/model effort-model')
    await waitFor(() => test.transcriptText().includes('model: test-provider/effort-model (high)'), 'the effort switch note')
    test.submit('/model test-provider/')
    await waitFor(() => test.transcriptText().includes('error: usage: /model [list | provider/model]'), 'the usage error')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('reloads the default model selection from settings without saving it back', async () => {
    const test = await bench({ startup: {} })
    const running = test.run()
    await running.mounted
    test.submit('/reload')
    await waitFor(() => test.transcriptText().includes('unchanged: test-provider/test-model'), 'the unchanged note')
    test.setDefaultModel({ provider: 'test-provider', model: 'other-model' })
    test.submit('/reload')
    await waitFor(() => test.transcriptText().includes('reloaded: test-provider/other-model'), 'the reload note')
    expect(test.replaceCalls()).toBe(0)
    const status = captured.screens[0]?.children[3] as { render(width: number): string[] } | undefined
    if (status === undefined) throw new Error('status line not mounted')
    expect(status.render(200)[0]).toContain('other-model')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('errors /reload when no llm service is composed', async () => {
    const test = await bench({ startup: {}, noLlm: true })
    const running = test.run()
    await running.mounted
    test.submit('/reload')
    await waitFor(() => test.transcriptText().includes('error: no llm service is composed'), 'the reload error')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('reloads a reasoning effort stored in settings and keeps the session on failure', async () => {
    const test = await bench({ startup: {} })
    const running = test.run()
    await running.mounted
    test.setDefaultModel({ provider: 'test-provider', model: 'effort-model', reasoningEffort: 'high' })
    test.submit('/reload')
    await waitFor(() => test.transcriptText().includes('reloaded: test-provider/effort-model (high)'), 'the effort reload note')
    test.setDefaultModel({ provider: 'test-provider', model: 'gone-model' })
    test.submit('/reload')
    await waitFor(() => test.transcriptText().includes('error: model gone from the catalog'), 'the reload error')
    test.submit('/model')
    await waitFor(() => test.transcriptText().includes('model: test-provider/effort-model (high)'), 'the post-failure model note')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('notes unknown commands whether or not the command runtime is composed', async () => {
    for (const options of [{}, { noCommands: true }] as const) {
      const test = await bench({ startup: {}, ...options })
      const running = test.run()
      await running.mounted
      test.submit('/nope')
      await waitFor(() => test.transcriptText().includes('unknown command: /nope'), 'the unknown note')
      test.submit('/exit')
      expect(await running.code).toBe(0)
      await test.ctx.fiber.dispose()
    }
  })

  it('sends an unknown slash line out as a followup when it names a user-invocable skill', async () => {
    const test = await bench({
      startup: {},
      skills: [{ name: 'caveman', userInvocable: true }, { name: 'hidden', userInvocable: false }],
    })
    const running = test.run()
    await running.mounted
    test.submit('/caveman')
    await waitFor(() => test.followups().length === 1, 'the skill gesture followup')
    const sent = test.followups()[0]
    expect(sent?.content.filter(b => b.type === 'text').map(b => b.text).join('')).toBe('/caveman')
    // A non-user-invocable skill, a grammar-mismatched name, and a missing skill all stay errors.
    for (const line of ['/hidden', '/Caveman', '/noskill']) {
      test.submit(line)
      await waitFor(() => test.transcriptText().includes(`unknown command: ${line}`), `the unknown note for ${line}`)
    }
    expect(test.followups()).toHaveLength(1)
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('keeps the unknown-command note when skill discovery fails or reports an observation', async () => {
    for (const options of [{ failSkills: true }, { skills: 'observation' as const }] as const) {
      const test = await bench({ startup: {}, ...options })
      const running = test.run()
      await running.mounted
      test.submit('/caveman')
      await waitFor(() => test.transcriptText().includes('unknown command: /caveman'), 'the unknown note')
      expect(test.followups()).toHaveLength(0)
      test.submit('/exit')
      expect(await running.code).toBe(0)
      await test.ctx.fiber.dispose()
    }
  })

  it('resolves a skill gesture without a command runtime composed', async () => {
    const test = await bench({ startup: {}, noCommands: true, skills: [{ name: 'caveman', userInvocable: true }] })
    const running = test.run()
    await running.mounted
    test.submit('/caveman')
    await waitFor(() => test.followups().length === 1, 'the skill gesture followup')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('survives a rejecting command runtime without double-noting the failure', async () => {
    const test = await bench({ startup: {}, failCommands: true })
    const running = test.run()
    await running.mounted
    test.submit('/model')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.transcriptText()).not.toContain('error:')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('renders textless command outcomes with fallback notes', async () => {
    const test = await bench({ startup: {} })
    const running = test.run()
    await running.mounted
    test.registeredCommands.push({
      name: 'bare',
      handler: async (invocation) => {
        if (invocation.rawInput === 'err') throw new Error('bare boom')
        if (invocation.rawInput === 'silent') throw Symbol('silent')
        if (invocation.rawInput === 'blank') return { kind: 'success', text: 'first\n\nsecond' }
        return 'plain'
      },
    })
    test.submit('/bare')
    await waitFor(() => test.transcriptText().includes('done'), 'the textless success note')
    test.submit('/bare err')
    await waitFor(() => test.transcriptText().includes('error: bare boom'), 'the error note')
    test.submit('/bare silent')
    await waitFor(() => test.transcriptText().includes('error: command failed'), 'the textless error note')
    // Blank lines inside a result render no note of their own.
    test.submit('/bare blank')
    await waitFor(() => {
      const lines = test.transcriptText().replace(/\u001b\[[0-9;]*m/g, '').split('\n')
      return lines.includes(' first') && lines.includes(' second') && !lines.includes(' ')
    }, 'the split blank-line notes')
    test.submit('/exit')
    expect(await running.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('reports a missing llm service and an empty catalog from /model', async () => {
    for (const [options, expected] of [
      [{ noLlm: true }, 'error: no llm service is composed'],
      [{ emptyModels: true }, 'test-provider: (no models)'],
      [{ noProviders: true }, 'no providers registered'],
    ] as const) {
      const test = await bench({ startup: {}, ...options })
      const running = test.run()
      await running.mounted
      test.submit('/model list')
      await waitFor(() => test.transcriptText().includes(expected), 'the catalog note')
      test.submit('/exit')
      expect(await running.code).toBe(0)
      await test.ctx.fiber.dispose()
    }
  })

  it('keeps switching when persisting the default model fails', async () => {
    for (const failure of [new Error('disk full'), 'disk full']) {
      const test = await bench({ startup: {}, failSettingsWith: failure })
      const running = test.run()
      await running.mounted
      test.submit('/model test-provider/new-model')
      await waitFor(() => test.transcriptText().includes('model: test-provider/new-model'), 'the switch note')
      await waitFor(() => running.err().includes('model default not saved: disk full'), 'the save warning')
      test.submit('/exit')
      expect(await running.code).toBe(0)
      await test.ctx.fiber.dispose()
    }
  })

  it('throws at mount when the launcher did not provide appExit', () => {
    const ctx = new Context()
    expect(() => { apply(ctx) }).toThrow(/appExit/)
  })

  it('stays silent when the startup service is absent', async () => {
    const test = await bench({})
    const order: string[] = []
    test.ctx.provide('appExit', (code: number) => { order.push(`exit:${code}`) })
    apply(test.ctx)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(order).toEqual([])
    expect(captured.editors).toHaveLength(0)
    await test.ctx.fiber.dispose()
  })

  it('exits 1 with the creation failure for Error and non-Error rejections', async () => {
    for (const failure of [new Error('create failed'), 'create failed']) {
      const test = await bench({ startup: {}, failCreateWith: failure })
      const exited = new Promise<number>((resolve) => {
        test.ctx.provide('appExit', resolve)
      })
      const { result, err } = await captureStderr(async () => {
        apply(test.ctx)
        return exited
      })
      expect(result).toBe(1)
      expect(err).toContain('create failed')
      await test.ctx.fiber.dispose()
    }
  })

  it('exits 1 when loader settlement rejects with a non-Error', async () => {
    const test = await bench({ startup: {} })
    test.ctx.provide('loader', {
      await: async (): Promise<never> => {
        throw 'loader exploded'
      },
    } as never)
    const exited = new Promise<number>((resolve) => {
      test.ctx.provide('appExit', resolve)
    })
    const { result, err } = await captureStderr(async () => {
      apply(test.ctx)
      return exited
    })
    expect(result).toBe(1)
    expect(err).toContain('loader exploded')
    await test.ctx.fiber.dispose()
  })

  it('exits 1 when the replayed log has a gap below its captured length', async () => {
    const test = await bench({
      startup: { resumeSessionId: 'session-gap' },
      resumeHistory(session) {
        session.append('turn/start', { turn: 0 })
        session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
      },
      gapAtSeq: 0,
    })
    const exited = new Promise<number>((resolve) => {
      test.ctx.provide('appExit', resolve)
    })
    const { result, err } = await captureStderr(async () => {
      apply(test.ctx)
      return exited
    })
    expect(result).toBe(1)
    expect(err).toContain('cannot read seq 0')
    await test.ctx.fiber.dispose()
  })

  it('reports dispose failures during shutdown but still exits 0', async () => {
    for (const failure of [new Error('dispose failed'), 'dispose failed']) {
      const test = await bench({ startup: {}, failDisposeWith: failure })
      const running = test.run()
      await running.mounted
      test.submit('/exit')
      expect(await running.code).toBe(0)
      expect(running.err()).toContain('shutdown: dispose failed')
      await test.ctx.fiber.dispose()
    }
  })
})

/** Run one synchronous mount while capturing process.stderr. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  let err = ''
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string) => { err += chunk; return true }
  try {
    return { result: await fn(), err }
  } finally {
    process.stderr.write = original
  }
}

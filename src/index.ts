/**
 * @rabi/dsh-tui — interactive terminal surface. The bundle patch rides
 * over dsh-base; this runner creates (or resumes) one Agent through the core
 * registry, mounts the pi-style TUI over its session log, answers approval
 * requests in-terminal, and exits through the launcher's bounded exit request.
 *
 * @module @rabi/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Empty type imports carry the loader Context merge for the settlement await,
// the cmdline Context merge for the appExit host value, the approval
// event-map merge for the in-terminal answerer, and the commands Context merge
// for the slash-command router.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import { createTui, type AssistantDraft } from './tui.ts'
import type { TuiStartupValues } from './startup.ts'

// The session-controller package owns this event; re-declare the member so this
// surface can append and read it without pulling the API layer's type graph in.
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** The model route selected for subsequent requests (the `/model` command). */
    'model/selection': ModelSelection
  }
}

export const name = 'tui-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'tuiStartup']

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  void run(ctx, exit).catch((error: unknown) => {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

async function run(ctx: Context, exit: (code: number) => void): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const startup = ctx.get('tuiStartup') as TuiStartupValues | undefined
  if (agents === undefined || defaultModel === undefined || sessions === undefined || startup === undefined) return

  const selection = defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  // One live selection shared by prompt assembly and the /model command; the
  // session log's latest model/selection event is the durable record.
  let currentSelection = selection
  const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
  const setup = (agentCtx: Context): void => {
    installModelSelection(agentCtx, selectionRef)
  }

  let handle: AgentHandle
  try {
    if (startup.resumeSessionId !== undefined) {
      handle = await agents.resume({
        resumeSessionId: brandString<SessionId>(startup.resumeSessionId),
        agentOptions,
        setup,
      })
    } else {
      const sessionId = startup.sessionId !== undefined
        ? brandString<SessionId>(startup.sessionId)
        : brandString<SessionId>(`session-${randomUUID()}`)
      handle = await agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
    }
  } catch (error) {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
    return
  }
  const agent = handle.agent

  // The model's context window, when the adapter reports one; the status line
  // falls back to used tokens alone when resolution fails (offline adapter).
  let contextWindow: number | undefined
  const llm = ctx.get('llm')
  const skills = ctx.get('skills')
  const refreshWindow = async (next: ModelSelection): Promise<void> => {
    if (llm === undefined) {
      contextWindow = undefined
      return
    }
    try {
      contextWindow = (await llm.resolveModelInfo(next.provider, next.model)).context?.contextWindow
    } catch {
      // Swallows adapter/model-info failures only; usage tracking still works.
      contextWindow = undefined
    }
  }
  await refreshWindow(selection)
  let contextUsed = 0

  // Slash commands route through the dsh-base command runtime; a settled
  // command renders through its command/done session event, so this surface
  // adds no note of its own for settled commands.
  const commands = ctx.get('commands')
  const describeModel = (next: ModelSelection): string =>
    `${next.provider}/${next.model}${next.reasoningEffort === undefined ? '' : ` (${next.reasoningEffort})`}`
  const handleModelCommand = async (rawInput: string): Promise<CommandResult> => {
    const arg = rawInput.trim()
    if (arg === '') return { kind: 'success', text: `model: ${describeModel(currentSelection)} — /model list · /model <id>` }
    if (llm === undefined) return { kind: 'error', text: 'no llm service is composed' }
    if (arg === 'list') {
      const providers = llm.listProviders()
      if (providers.length === 0) return { kind: 'success', text: 'no providers registered' }
      // One line per provider: notes are single-line, and the current model's
      // marker needs its provider to disambiguate same-named ids.
      const sections = await Promise.all(providers.map(async (provider) => {
        const models = await llm.listModels(provider.id)
        const entries = models.length === 0
          ? '(no models)'
          : models.map(m => m.id === currentSelection.model && provider.id === currentSelection.provider ? `* ${m.id}` : m.id).join(', ')
        return `${provider.id}: ${entries}`
      }))
      return { kind: 'success', text: sections.join('\n') }
    }
    const slash = arg.indexOf('/')
    const provider = slash > 0 ? arg.slice(0, slash) : currentSelection.provider
    const model = slash > 0 ? arg.slice(slash + 1) : arg
    if (model === '') return { kind: 'error', text: 'usage: /model [list | provider/model]' }
    const resolved = await llm.resolveCallConfig({ provider, model })
    const next: ModelSelection = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
    currentSelection = next
    selectionRef.current = next
    agent.session.append('model/selection', next)
    void defaultModel.saveSelection(next).catch((error: unknown) => {
      process.stderr.write(`dsh: model default not saved: ${error instanceof Error ? error.message : String(error)}\n`)
    })
    return { kind: 'success', text: `model: ${describeModel(next)}` }
  }
  // Settings are the source of truth here, so a reload applies the stored
  // default without writing it back; /model keeps saving because the session
  // chose it.
  const handleReloadCommand = async (): Promise<CommandResult> => {
    if (llm === undefined) return { kind: 'error', text: 'no llm service is composed' }
    const next = defaultModel.currentSelection()
    const current = currentSelection
    if (current.provider === next.provider && current.model === next.model
      && (current.reasoningEffort ?? undefined) === (next.reasoningEffort ?? undefined)) {
      return { kind: 'success', text: `unchanged: ${describeModel(current)}` }
    }
    const resolved = await llm.resolveCallConfig({
      provider: next.provider,
      model: next.model,
      ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
    })
    const applied: ModelSelection = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
    currentSelection = applied
    selectionRef.current = applied
    agent.session.append('model/selection', applied)
    return { kind: 'success', text: `reloaded: ${describeModel(applied)}` }
  }
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'model',
      description: 'Show or switch the session model',
      input: { hint: '[list | provider/model]' },
      handler: invocation => handleModelCommand(invocation.rawInput),
    }), 'tui-model-command')
    ctx.effect(() => commands.register({
      name: 'reload',
      description: 'Re-read the default model selection from settings and apply it to this session',
      handler: () => handleReloadCommand(),
    }), 'tui-reload-command')
  }

  let shuttingDown = false
  // Every dispatched command's controller; shutdown aborts them all (aborting
  // a settled one is a no-op), so the list only grows.
  const commandAborts: AbortController[] = []
  let exited: () => void
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      for (const controller of commandAborts) controller.abort()
      agent.cancel({ kind: 'user' })
      disposeEvents()
      disposeApproval()
      tui.stop()
      await sessions.flush(agent.session)
      await handle.dispose()
    } catch (error) {
      process.stderr.write(`dsh: shutdown: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      exited()
    }
  }

  // A `/name` line that names no command may still be a skill invocation
  // gesture: the pre-step listener loads any user-invocable skill named by a
  // user message, so the line goes out as an ordinary followup instead of an
  // error. Names follow the gesture grammar; discovery failures keep the
  // unknown-command note rather than blocking the input.
  const SKILL_GESTURE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/u
  const isSkillInvocation = async (line: string, signal: AbortSignal): Promise<boolean> => {
    if (skills === undefined) return false
    const name = SKILL_GESTURE.exec(line)?.[1]
    if (name === undefined) return false
    let candidates: readonly SkillSummary[]
    try {
      const listed = await skills.list({ signal })
      candidates = Array.isArray(listed) ? listed : []
    } catch {
      return false
    }
    return candidates.some(candidate => candidate.name === name && candidate.invocation.userInvocable)
  }

  const runCommand = async (line: string): Promise<void> => {
    const controller = new AbortController()
    commandAborts.push(controller)
    if (commands !== undefined) {
      try {
        const execution = await commands.execute(agent, line, [], controller.signal)
        if (execution !== undefined) return
      } catch {
        // A settled failure already rendered through its command/done event; a
        // pre-settlement abort carries nothing to show.
        return
      }
    }
    if (await isSkillInvocation(line, controller.signal)) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: line }], source: { kind: 'user' } }))
      return
    }
    tui.addNote(`unknown command: ${line.split(/\s+/u)[0]}`)
  }

  const tui = createTui({
    model: selection.model,
    sessionId: agent.id,
    gitCwd: process.cwd(),
    isRunning: () => agent.status === 'running',
    context: () => contextWindow === undefined
      ? { used: contextUsed }
      : { used: contextUsed, window: contextWindow },
    onSubmit: (text: string): void => {
      if (text === '/exit' || text === '/quit') {
        void shutdown()
        return
      }
      if (text === '/clear') {
        tui.clearTranscript()
        return
      }
      if (text === '/help') {
        tui.addNote('commands: /help · /clear · /compact · /model · /reload · /feedback · /goal · /exit · /<skill>')
        tui.addNote('keys: ⏎ send · shift+⏎ newline · ^o tools · esc/^c cancel · alt+↑ dequeue · ^c/^d quit')
        return
      }
      if (text.startsWith('/')) {
        void runCommand(text)
        return
      }
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    },
    onCancel: (): void => { agent.cancel({ kind: 'user' }) },
    onExit: (): void => {
      void shutdown()
    },
    queue: () => agent.inbox.nextTurn.map(m => joinText(m.content)),
    // One synchronous splice removes exactly what it reports; the TUI puts
    // those texts back into the editor (the alt+Up dequeue).
    onDequeue: (): string[] => agent.inbox.splice('next-turn', 0, agent.inbox.nextTurn.length, []).map(m => joinText(m.content)),
  })

  // One event application shared by history replay and the live log.
  let draft: AssistantDraft | undefined
  /**
   * File-mutating calls awaiting their result. Their diff renders where the
   * result lands (persisted diff metadata first, argument parsing as
   * fallback); an aborted turn still names them on `turn/end`.
   */
  const pendingCalls = new Map<string, { name: 'edit' | 'write'; arguments: string }>()
  const applyModelChange = (next: ModelSelection): void => {
    tui.setModel(next.model)
    void refreshWindow(next)
  }
  const applyEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user') return
        const text = joinText(event.data.content)
        if (text !== '') tui.addUser(text)
        return
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') (draft ??= tui.beginAssistant()).textDelta(chunk.text)
        else if (chunk.type === 'reasoning-delta') (draft ??= tui.beginAssistant()).reasoningDelta(chunk.text)
        return
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage !== undefined) contextUsed = usage.totalTokens ?? usage.inputTokens + usage.outputTokens
        const { text, reasoning } = splitAssistant(event.data.message.content)
        if (draft !== undefined) {
          draft.finish(text, reasoning)
          draft = undefined
        } else if (text !== '' || reasoning !== '') {
          tui.addAssistant(text, reasoning)
        }
        return
      }
      case 'tool/call': {
        const { callId, name, arguments: argumentsJson } = event.data
        if (name === 'edit' || name === 'write') pendingCalls.set(callId, { name, arguments: argumentsJson })
        else tui.addToolCall(name, argumentsJson)
        return
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const isError = event.data.error !== undefined || block.isError === true
        const pending = pendingCalls.get(block.toolCallId)
        const diffs = diffsOfMeta(event.data.meta)
        let rendered = false
        if (diffs !== undefined) {
          for (const diff of diffs) tui.addDiff(diff.path, diff.removed, diff.added)
          rendered = true
        } else if (!isError && pending !== undefined) {
          const fallback = diffOfToolCall(pending.name, pending.arguments)
          if (fallback !== undefined) {
            tui.addDiff(fallback.title, fallback.removed, fallback.added)
            rendered = true
          }
        }
        if (pending !== undefined && !rendered) tui.addToolCall(pending.name, pending.arguments)
        pendingCalls.delete(block.toolCallId)
        // Full text: the TUI flattens/truncates the collapsed line and keeps
        // the newlines for the Ctrl+O expanded view.
        tui.addToolResult(isError, joinText(block.content))
        return
      }
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          tui.addError(`${event.data.reason.error.code}: ${event.data.reason.error.message}`)
          // Calls whose results never landed still get their one-line note.
          for (const pending of pendingCalls.values()) tui.addToolCall(pending.name, pending.arguments)
        }
        pendingCalls.clear()
        return
      case 'command/done': {
        const { kind, text } = event.data
        // Notes are single-line, so a multi-line result renders one note per line.
        const body = kind === 'success' ? (text ?? 'done') : `error: ${text ?? 'command failed'}`
        for (const line of body.split('\n')) if (line !== '') tui.addNote(line)
        return
      }
      case 'model/selection':
        currentSelection = event.data
        selectionRef.current = event.data
        applyModelChange(event.data)
        return
      default:
        return
    }
  }

  // Replay the committed log so a resumed session opens with its history.
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`tui replay cannot read seq ${String(seq)} below captured length ${String(agent.session.seq)}`)
    }
    applyEvent(event)
  }

  const disposeEvents = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    applyEvent(event)
  })

  const disposeApproval = ctx.on('approval/request', async (req, next) => {
    if (req.agent !== agent) return next()
    const question = req.reason !== undefined ? `${req.toolName}: ${req.reason}` : req.toolName
    return tui.askApproval(question, req.signal)
  })

  tui.start()
  await new Promise<void>((resolve) => {
    exited = resolve
  })
  exit(0)
}

/** Join the text blocks of one message. */
function joinText(content: readonly ContentBlock[]): string {
  return content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Split one assistant message into its text and reasoning parts. */
function splitAssistant(content: readonly ContentBlock[]): { text: string; reasoning: string } {
  let text = ''
  let reasoning = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'reasoning') reasoning += block.text
  }
  return { text, reasoning }
}

/**
 * The persisted diff hunks a tool result carries, when they do. `meta` is
 * tool-private and crosses the durable-log boundary, so every field is
 * validated here; any miss falls back to argument parsing.
 */
function diffsOfMeta(meta: unknown): { path: string; removed: string | null; added: string }[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const out: { path: string; removed: string | null; added: string }[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return undefined
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string') return undefined
    if (oldText !== null && typeof oldText !== 'string') return undefined
    if (typeof newText !== 'string') return undefined
    out.push({ path, removed: oldText, added: newText })
  }
  return out
}

/** One-line dim preview of a tool result's text content. */
/**
 * The file change one tool call's arguments describe, when they do. The
 * arguments are model-produced JSON, so every field is validated at this
 * wire boundary; any miss falls back to the generic one-line tool render.
 */
function diffOfToolCall(name: 'edit' | 'write', argumentsJson: string): { title: string; removed: string | null; added: string } | undefined {
  let args: unknown
  try {
    args = JSON.parse(argumentsJson)
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const path = record.file_path
  if (typeof path !== 'string') return undefined
  if (name === 'edit') {
    const removed = record.old_string
    const added = record.new_string
    if (typeof removed !== 'string' || typeof added !== 'string') return undefined
    return { title: `edit ${path}`, removed, added }
  }
  const added = record.content
  if (typeof added !== 'string') return undefined
  return { title: `write ${path}`, removed: null, added }
}

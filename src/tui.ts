/**
 * Terminal presentation for the TUI surface: a pi-style main-screen layout in
 * which committed transcript lines flow into terminal scrollback while the
 * live tail — streaming assistant text, the input editor, and a status line —
 * is differential-rendered at the bottom of the viewport. Pure presentation:
 * this module owns no agent, session, or Cordis state.
 *
 * @module @rabi/dsh-tui/tui
 */

import {
  CombinedAutocompleteProvider,
  Editor,
  Markdown,
  ProcessTerminal,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type SlashCommand,
} from '@earendil-works/pi-tui'
import { createGitStatus } from './git.ts'

/** One-line ANSI style helpers for the fixed dark-on-light terminal palette. */
const S = {
  bold: (t: string): string => `\x1b[1m${t}\x1b[22m`,
  dim: (t: string): string => `\x1b[2m${t}\x1b[22m`,
  italic: (t: string): string => `\x1b[3m${t}\x1b[23m`,
  cyan: (t: string): string => `\x1b[36m${t}\x1b[39m`,
  green: (t: string): string => `\x1b[32m${t}\x1b[39m`,
  red: (t: string): string => `\x1b[31m${t}\x1b[39m`,
  yellow: (t: string): string => `\x1b[33m${t}\x1b[39m`,
  strike: (t: string): string => `\x1b[9m${t}\x1b[29m`,
  underline: (t: string): string => `\x1b[4m${t}\x1b[24m`,
} as const

const MD_THEME = {
  heading: S.bold,
  link: S.cyan,
  linkUrl: S.dim,
  code: S.yellow,
  codeBlock: S.dim,
  codeBlockBorder: S.dim,
  quote: S.italic,
  quoteBorder: S.dim,
  hr: S.dim,
  listBullet: S.cyan,
  bold: S.bold,
  italic: S.italic,
  strikethrough: S.strike,
  underline: S.underline,
} as const

const EDITOR_THEME = {
  borderColor: S.dim,
  selectList: {
    selectedPrefix: S.cyan,
    selectedText: S.bold,
    description: S.dim,
    scrollInfo: S.dim,
    noMatch: S.red,
  },
} as const

/** Left/right content padding shared by every transcript item. */
const PADX = 1
/** Max source lines shown in one diff item before the overflow note. */
const DIFF_MAX_LINES = 40
/** Cap on stored tool-result text so a huge output cannot bloat the frame cache. */
const TOOL_TEXT_MAX = 100_000

/** One source line of a diff, colored by side. */
interface DiffLine {
  text: string
  minus: boolean
}

/** File content into its lines, dropping one trailing empty line from a final newline. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function pad(lines: string[]): string[] {
  return lines.map(line => ' '.repeat(PADX) + line)
}

/** A transcript item with per-width render caching. */
interface Item {
  render(width: number): string[]
  invalidate(): void
}

function cachedItem(renderFn: (width: number) => string[]): Item {
  let width = -1
  let lines: string[] = []
  return {
    render(w: number): string[] {
      if (w !== width) {
        width = w
        lines = renderFn(w)
      }
      return lines
    },
    invalidate(): void {
      width = -1
    },
  }
}

/** A dim transcript note whose text updates in place (activity brackets). */
export interface NoteDraft {
  /** Replace the note's text; `failed` renders it red instead of dim. */
  set(text: string, failed?: boolean): void
}

/** A live assistant message being streamed into the transcript. */
export interface AssistantDraft {
  /** Append one streamed text delta. */
  textDelta(text: string): void
  /** Append one streamed reasoning delta. */
  reasoningDelta(text: string): void
  /** Commit the draft with the assembled message content. */
  finish(text: string, reasoning: string): void
}

/**
 * The committed-plus-live transcript column. Items render independently with
 * per-width caches, so streaming re-wraps only the item receiving deltas.
 */
export class Transcript implements Component {
  private items: Item[] = []
  /** Called after every mutation so the owning TUI can request a frame. */
  private readonly onChange: () => void
  private lastWidth = -1
  private lastLines: string[] = []
  /** Whether tool calls/results render their full text (Ctrl+O). */
  private toolsExpanded = false

  constructor(onChange?: () => void) {
    this.onChange = onChange ?? (() => {})
  }

  /** Mark the concatenated frame stale and request one. */
  private change(): void {
    this.lastWidth = -1
    this.onChange()
  }

  /** Flip the tool-output expansion mode; every item re-renders. */
  toggleToolsExpanded(): void {
    this.toolsExpanded = !this.toolsExpanded
    for (const item of this.items) item.invalidate()
    this.change()
  }

  /** Render one committed user prompt. */
  addUser(text: string): void {
    this.push(cachedItem(width => pad(wrapTextWithAnsi(`${S.cyan('❯')} ${text}`, width - PADX * 2))))
  }

  /** Render one committed assistant message (reasoning first, then text). */
  addAssistant(text: string, reasoning: string): void {
    if (text === '' && reasoning === '') return
    const md = new Markdown(text, PADX, 0, MD_THEME)
    const item = cachedItem(width => [
      ...pad(wrapTextWithAnsi(S.dim(S.italic(reasoning)), width - PADX * 2)).filter(l => l.trim() !== ''),
      ...md.render(width),
    ])
    this.items.push(item)
    this.change()
  }

  /** Start one live assistant message; deltas mutate the returned draft. */
  beginAssistant(): AssistantDraft {
    const md = new Markdown('', PADX, 0, MD_THEME)
    let text = ''
    let reasoning = ''
    const change = (): void => { this.change() }
    const item = cachedItem((width) => {
      if (text === '' && reasoning === '') return []
      return [
        ...pad(wrapTextWithAnsi(S.dim(S.italic(reasoning)), width - PADX * 2)).filter(l => l.trim() !== ''),
        ...md.render(width),
      ]
    })
    this.items.push(item)
    change()
    return {
      textDelta(delta: string): void {
        text += delta
        md.setText(text)
        item.invalidate()
        change()
      },
      reasoningDelta(delta: string): void {
        reasoning += delta
        item.invalidate()
        change()
      },
      finish(finalText: string, finalReasoning: string): void {
        text = finalText
        reasoning = finalReasoning
        md.setText(text)
        item.invalidate()
        change()
      },
    }
  }

  /** Render one file change as a capped +/- diff under a dim header. */
  addDiff(title: string, removed: string | null, added: string): void {
    const lines: DiffLine[] = [
      ...(removed === null ? [] : splitLines(removed).map(text => ({ text, minus: true }))),
      ...splitLines(added).map(text => ({ text, minus: false })),
    ]
    const hidden = Math.max(0, lines.length - DIFF_MAX_LINES)
    this.push(cachedItem((width) => {
      const inner = Math.max(width - PADX * 2 - 2, 1)
      const out: string[] = [S.dim(`⚙ ${title}`)]
      for (const line of lines.slice(0, DIFF_MAX_LINES)) {
        const style = line.minus ? S.red : S.green
        const wrapped = wrapTextWithAnsi(line.text, inner)
        out.push(...wrapped.map((text, i) => style(`${i === 0 ? (line.minus ? '- ' : '+ ') : '  '}${text}`)))
      }
      if (hidden > 0) out.push(S.dim(`… +${String(hidden)} more lines`))
      return pad(out)
    }))
  }

  /** Render one committed tool call; expanded shows the full argument JSON. */
  addToolCall(name: string, args: string): void {
    const hasArgs = args !== '{}' && args !== ''
    this.push(cachedItem((width) => {
      const inner = width - PADX * 2
      if (!this.toolsExpanded || !hasArgs) {
        const label = hasArgs ? `${name}(${truncateToWidth(args, 120)})` : name
        return pad(wrapTextWithAnsi(S.dim(`⚙ ${label}`), inner))
      }
      return pad([S.dim(`⚙ ${name}`), ...wrapTextWithAnsi(S.dim(args), inner)])
    }))
  }

  /** Render one completed tool result; expanded shows the full output text. */
  addToolResult(isError: boolean, text: string): void {
    const mark = isError ? S.red('✗') : S.green('✓')
    const capped = text.length > TOOL_TEXT_MAX
      ? `${text.slice(0, TOOL_TEXT_MAX)}\n… [truncated ${String(text.length - TOOL_TEXT_MAX)} chars]`
      : text
    this.push(cachedItem((width) => {
      const inner = width - PADX * 2
      if (!this.toolsExpanded) {
        const flat = capped.replace(/\s+/gu, ' ').trim()
        const preview = flat === '' ? '(no output)' : truncateToWidth(flat, inner - 2, '…', false)
        return pad(wrapTextWithAnsi(`${mark} ${S.dim(preview)}`, inner))
      }
      const body = capped === '' ? '(no output)' : capped
      return pad([mark, ...wrapTextWithAnsi(S.dim(body), inner)])
    }))
  }

  /** Render one dim informational note (header, separators). */
  addNote(text: string): void {
    this.push(cachedItem(width => pad([S.dim(truncateToWidth(text, width - PADX * 2, '…', false))])))
  }

  /** Start one dim note whose text updates in place; returns the updater. */
  beginNote(initial: string): NoteDraft {
    let text = initial
    let failed = false
    const change = (): void => { this.change() }
    const item = cachedItem(width => pad([
      truncateToWidth(failed ? S.red(text) : S.dim(text), width - PADX * 2, '…', false),
    ]))
    this.items.push(item)
    change()
    return {
      set(next: string, isFailed = false): void {
        text = next
        failed = isFailed
        item.invalidate()
        change()
      },
    }
  }

  /** Render one red error line. */
  addError(text: string): void {
    this.push(cachedItem(width => pad(wrapTextWithAnsi(S.red(text), width - PADX * 2))))
  }

  /** Remove every committed item (the `/clear` command). */
  clear(): void {
    this.items = []
    this.change()
  }

  private push(item: Item): void {
    this.items.push(item)
    this.change()
  }

  /** Per-item width caches make a full invalidation unnecessary. */
  invalidate(): void {}

  render(width: number): string[] {
    if (width === this.lastWidth) return this.lastLines
    const lines: string[] = []
    for (const item of this.items) {
      lines.push(...item.render(width))
    }
    this.lastWidth = width
    this.lastLines = lines
    return lines
  }
}

/** A single dim status line whose text is recomputed each frame. */
class StatusLine implements Component {
  constructor(private readonly text: () => string) {}
  /** The line recomputes from its source each frame. */
  invalidate(): void {}
  render(width: number): string[] {
    return [S.dim(truncateToWidth(this.text(), width, '…', false))]
  }
}

/** One dim line per queued follow-up message, rendered above the editor. */
class QueueLine implements Component {
  constructor(private readonly texts: () => string[]) {}
  /** The lines recompute from the live queue each frame. */
  invalidate(): void {}
  render(width: number): string[] {
    const out: string[] = []
    for (const text of this.texts()) {
      const flat = text.replace(/\s+/gu, ' ').trim()
      if (flat === '') continue
      out.push(S.dim(`⏳ ${truncateToWidth(flat, width - PADX * 2 - 2, '…', false)}`))
    }
    return pad(out)
  }
}

/** The three answers an in-terminal approval prompt can produce. */
export type ApprovalAnswer = 'allowed-once' | 'rejected' | 'cancelled'

interface ApprovalGateDeps {
  /** Register a raw input listener; returns its disposer. */
  addListener(listener: (data: string) => { consume?: boolean } | undefined): () => void
  /** Request one TUI frame. */
  requestRender(): void
  /** Set the approval prompt line ('' clears it). */
  setLine(text: string): void
}

/**
 * Serializes in-terminal approval prompts: concurrent requests queue FIFO,
 * each waits for `y`/`n`, and an abort signal settles it as cancelled. The
 * first prompt opens synchronously so the caller's render pass shows it.
 */
export function createApprovalGate(deps: ApprovalGateDeps) {
  let tail: Promise<void> = Promise.resolve()
  let activeFinish: ((answer: ApprovalAnswer) => void) | undefined
  return {
    ask(question: string, signal?: AbortSignal): Promise<ApprovalAnswer> {
      const start = (): Promise<ApprovalAnswer> => new Promise<ApprovalAnswer>((resolve) => {
        let removeListener: () => void = () => {}
        let done = false
        let lineShown = false
        const finish = (answer: ApprovalAnswer): void => {
          if (done) return
          done = true
          signal?.removeEventListener('abort', onAbort)
          removeListener()
          activeFinish = undefined
          if (lineShown) {
            deps.setLine('')
            deps.requestRender()
          }
          resolve(answer)
        }
        const onAbort = (): void => { finish('cancelled') }
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) {
          finish('cancelled')
          return
        }
        activeFinish = finish
        lineShown = true
        deps.setLine(S.yellow(`⚠ Allow ${question}? [y/n]`))
        deps.requestRender()
        removeListener = deps.addListener((data) => {
          if (data === 'y' || data === 'Y') finish('allowed-once')
          else if (data === 'n' || data === 'N') finish('rejected')
        })
      })
      if (activeFinish === undefined) {
        const result = start()
        tail = result.then(() => {})
        return result
      }
      const queued = tail.then(start)
      tail = queued.then(() => {})
      return queued
    },
  }
}

/** Runner-facing options for one mounted TUI. */
export interface TuiOptions {
  /** Model route shown in the header and status line. */
  model: string
  /** Session id shown in the header. */
  sessionId: string
  /** Whether the agent currently has active work. */
  isRunning: () => boolean
  /** Current context consumption for the status line. */
  context: () => ContextUsage
  /** One submitted editor text (trimmed, non-empty). */
  onSubmit: (text: string) => void
  /** Cancel request: Ctrl+C or Escape while work is active. */
  onCancel: () => void
  /** Quit request (Ctrl+C idle, Ctrl+D, /exit). */
  onExit: () => void
  /** Texts of pending follow-up messages, oldest first; empty when none. */
  queue?: () => string[]
  /** Atomically remove every pending follow-up; returns their texts, oldest first. */
  onDequeue?: () => string[]
  /** Directory inside a git repository for the status line's branch segment; omit to hide it. */
  gitCwd?: string
  /** Slash commands offered by the editor's autocomplete; re-read on every suggestion request. Omit to disable it. */
  commands?: () => readonly SlashCommand[]
}

/** The mounted TUI surface and its transcript API. */
export interface TuiHandle {
  /** Take over the terminal (raw mode) and paint the header. */
  start(): void
  /** Restore the terminal. */
  stop(): void
  addUser(text: string): void
  addAssistant(text: string, reasoning: string): void
  beginAssistant(): AssistantDraft
  /** Render one file change as a capped +/- diff; `removed` null means create/overwrite. */
  addDiff(title: string, removed: string | null, added: string): void
  addToolCall(name: string, args: string): void
  addToolResult(isError: boolean, preview: string): void
  addNote(text: string): void
  /** Start one dim note whose text updates in place; returns the updater. */
  beginNote(text: string): NoteDraft
  addError(text: string): void
  /** Remove every committed transcript item (the `/clear` command). */
  clearTranscript(): void
  /** Update the model route shown in the status line (the header keeps the launch model). */
  setModel(model: string): void
  /** Ask the user for one approval decision; resolves cancelled when the signal aborts. */
  askApproval(question: string, signal?: AbortSignal): Promise<ApprovalAnswer>
}

/** Mount one interactive TUI over the process terminal. */
/** Braille spinner frames advanced while a turn runs. */
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
/** Spinner cadence in milliseconds. */
const SPIN_MS = 100

/** Context consumption shown in the status line. */
export interface ContextUsage {
  /** Tokens occupying the conversation context after the last model call. */
  used: number
  /** The model's context window, when the adapter reports one. */
  window?: number
}

/** Compact token count for the status line (1234 -> 1.2k). */
function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/**
 * An autocomplete provider that always sees the current command list: each
 * request delegates to one combined provider built from the latest commands,
 * so registry changes need no re-wiring. File-path completion shares the
 * provider, rooted at `basePath` (pi's CombinedAutocompleteProvider).
 */
export function createCommandAutocompleteProvider(
  commands: () => readonly SlashCommand[],
  basePath: string,
): AutocompleteProvider {
  const provider = (): CombinedAutocompleteProvider => new CombinedAutocompleteProvider([...commands()], basePath)
  return {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }) {
      return provider().getSuggestions(lines, cursorLine, cursorCol, options)
    },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
      return provider().applyCompletion(lines, cursorLine, cursorCol, item, prefix)
    },
  }
}

export function createTui(options: TuiOptions): TuiHandle {
  const tui = new TuiMainScreen(new ProcessTerminal(), true)
  const transcript = new Transcript((): void => { tui.requestRender() })
  const git = options.gitCwd === undefined ? undefined : createGitStatus(options.gitCwd, (): void => { tui.requestRender() })
  let approvalText = ''
  const approvalLine = new StatusLine(() => approvalText)
  let spin = 0
  let spinning = false
  const queueTexts = (): string[] => options.queue?.() ?? []
  const status = new StatusLine(() => {
    const running = options.isRunning()
    const prefix = running ? `${SPINNER.charAt(spin)} ` : ''
    const usage = options.context()
    const ctxText = usage.window === undefined
      ? formatTokens(usage.used)
      : `${formatTokens(usage.used)}/${formatTokens(usage.window)}`
    const branch = git?.branch()
    // Hints follow the state: while a turn runs, cancelling (and pulling
    // queued follow-ups back) is what matters; idle, the input shortcuts.
    const hints = running
      ? ['esc/^c cancel', ...(queueTexts().length > 0 ? ['alt+↑ dequeue'] : []), '^o tools']
      : ['⏎ send', 'tab complete', '^o tools', '^c/^d quit']
    return `${prefix}${options.model}${branch === undefined ? '' : ` ⎇ ${branch}`} · ${running ? 'running' : 'idle'} · ${ctxText} ctx · ${hints.join(' · ')}`
  })
  let timer: ReturnType<typeof setInterval> | undefined
  /** Advance the frame and repaint while a turn runs; settle the line when it ends. */
  const tick = (): void => {
    const running = options.isRunning()
    if (running) spin = (spin + 1) % SPINNER.length
    if (running !== spinning) {
      spinning = running
      tui.requestRender()
    } else if (running) {
      tui.requestRender()
    }
  }
  const editor = new Editor(tui, EDITOR_THEME)
  // Slash-command (and file-path) autocomplete; the getter keeps the roster
  // live across registry changes without re-wiring the editor.
  if (options.commands !== undefined) {
    editor.setAutocompleteProvider(createCommandAutocompleteProvider(options.commands, process.cwd()))
  }
  editor.onSubmit = (text: string): void => {
    if (text === '') return
    editor.addToHistory(text)
    options.onSubmit(text)
  }
  const queueLine = new QueueLine(queueTexts)
  tui.addChild(transcript)
  tui.addChild(approvalLine)
  tui.addChild(queueLine)
  tui.addChild(editor)
  tui.addChild(status)
  tui.setFocus(editor)

  const gate = createApprovalGate({
    addListener: listener => tui.addInputListener(listener),
    requestRender: (): void => { tui.requestRender() },
    setLine: (text: string) => {
      approvalText = text
    },
  })

  /** Cancel the active turn; queued follow-ups come back into the editor. */
  const cancelWithRestore = (): void => {
    const queued = queueTexts()
    options.onCancel()
    if (queued.length > 0) {
      // Cancel clears the inbox, so the captured texts are the only copy left.
      const existing = editor.getText()
      editor.setText(queued.join('\n\n') + (existing === '' ? '' : `\n\n${existing}`))
      tui.requestRender()
    }
  }
  tui.addInputListener((data: string) => {
    if (data === '\x03') {
      if (options.isRunning()) cancelWithRestore()
      else options.onExit()
      return { consume: true }
    }
    // Escape interrupts like Ctrl+C while work runs; idle it passes through to
    // the editor (autocomplete cancel), matching pi's app.interrupt binding.
    // The terminal layer disambiguates a bare ESC from split escape sequences.
    if (data === '\x1b') {
      if (!options.isRunning()) return
      cancelWithRestore()
      return { consume: true }
    }
    // Alt+Up pulls every queued follow-up back into the editor (pi's dequeue);
    // the turn keeps running.
    if (matchesKey(data, 'alt+up')) {
      const removed = options.onDequeue?.()
      if (removed !== undefined && removed.length > 0) {
        const existing = editor.getText()
        editor.setText(removed.join('\n\n') + (existing === '' ? '' : `\n\n${existing}`))
        tui.requestRender()
        return { consume: true }
      }
      return
    }
    // Ctrl+O toggles full tool output (pi's app.tools.expand).
    if (data === '\x0f') {
      transcript.toggleToolsExpanded()
      return { consume: true }
    }
    if (data === '\x04') {
      options.onExit()
      return { consume: true }
    }
  })

  return {
    start(): void {
      transcript.addNote(`${S.bold('dsh')} · ${options.model} · session ${options.sessionId}`)
      tui.start()
      if (timer === undefined) {
        timer = setInterval(tick, SPIN_MS)
        // The terminal's stdin handle keeps the process alive; the spinner must not.
        timer.unref()
      }
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      git?.dispose()
      tui.stop()
    },
    addUser: (text: string): void => { transcript.addUser(text) },
    addAssistant: (text: string, reasoning: string): void => { transcript.addAssistant(text, reasoning) },
    beginAssistant: () => transcript.beginAssistant(),
    addDiff: (title: string, removed: string | null, added: string): void => { transcript.addDiff(title, removed, added) },
    addToolCall: (name: string, args: string): void => { transcript.addToolCall(name, args) },
    addToolResult: (isError: boolean, preview: string): void => { transcript.addToolResult(isError, preview) },
    addNote: (text: string): void => { transcript.addNote(text) },
    beginNote: (text: string): NoteDraft => transcript.beginNote(text),
    addError: (text: string): void => { transcript.addError(text) },
    clearTranscript: (): void => { transcript.clear() },
    setModel: (model: string): void => {
      options.model = model
      tui.requestRender()
    },
    askApproval: (question: string, signal?: AbortSignal) => gate.ask(question, signal),
  }
}

/** createTui composition over mocked terminal classes with the real text engine. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutocompleteProvider, Component, SlashCommand } from '@earendil-works/pi-tui'
import { createCommandAutocompleteProvider, createTui } from '../src/tui.ts'

const captured = vi.hoisted(() => ({
  screens: [] as Array<{
    started: boolean
    stopped: boolean
    children: Component[]
    listeners: Array<(data: string) => { consume?: boolean } | undefined>
  }>,
  editors: [] as Array<{ onSubmit: ((text: string) => void) | null; history: string[]; text: string; providers: unknown[] }>,
}))

vi.mock('@earendil-works/pi-tui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-tui')>()
  return {
    ...actual,
    ProcessTerminal: class {
      start(): void {}
      stop(): void {}
      drainInput(_maxMs?: number, _idleMs?: number): Promise<void> { return Promise.resolve() }
    },
    TuiMainScreen: class {
      started = false
      stopped = false
      children: Component[] = []
      listeners: Array<(data: string) => { consume?: boolean } | undefined> = []
      terminal: { drainInput(maxMs?: number, idleMs?: number): Promise<void>; stop(): void; write(data: string): void } = {
        drainInput: () => Promise.resolve(),
        stop: () => {},
        write: () => {},
      }
      constructor() {
        captured.screens.push(this)
      }
      start(): void {
        this.started = true
      }
      stop(): void {
        this.stopped = true
      }
      requestRender(): void {}
      addChild(component: Component): void {
        this.children.push(component)
      }
      setFocus(): void {}
      addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void {
        this.listeners.push(listener)
        return () => {
          const i = this.listeners.indexOf(listener)
          if (i >= 0) this.listeners.splice(i, 1)
        }
      }
    },
    Editor: class {
      onSubmit: ((text: string) => void) | null = null
      history: string[] = []
      text = ''
      providers: unknown[] = []
      constructor() {
        captured.editors.push(this)
      }
      setAutocompleteProvider(provider: unknown): void {
        this.providers.push(provider)
      }
      addToHistory(text: string): void {
        this.history.push(text)
      }
      getText(): string {
        return this.text
      }
      setText(text: string): void {
        this.text = text
      }
    },
  }
})

afterEach(() => {
  captured.screens.length = 0
  captured.editors.length = 0
})

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function mount(options?: Partial<Parameters<typeof createTui>[0]>) {
  const submitted: string[] = []
  const followUps: string[] = []
  const cancels: string[] = []
  const exits: string[] = []
  let running = false
  let queue: string[] = []
  const dequeues: string[][] = []
  const handle = createTui({
    model: 'test-model',
    sessionId: 'session-test',
    isRunning: () => running,
    context: () => ({ used: 0, window: 164_000 }),
    onSubmit: (text: string) => { submitted.push(text) },
    onFollowUp: (text: string) => { followUps.push(text) },
    onCancel: () => { cancels.push('cancel'); queue = [] },
    onExit: () => { exits.push('exit') },
    queue: () => queue,
    onDequeue: (): string[] => {
      const removed = queue
      queue = []
      if (removed.length > 0) dequeues.push(removed)
      return removed
    },
    ...options,
  })
  const screen = captured.screens[captured.screens.length - 1]
  if (screen === undefined) throw new Error('no screen mounted')
  const editor = captured.editors[captured.editors.length - 1]
  if (editor === undefined) throw new Error('no editor mounted')
  const transcript = screen.children[0]
  const approvalLine = screen.children[1]
  const queueLine = screen.children[2]
  const status = screen.children[4]
  if (transcript === undefined || approvalLine === undefined || queueLine === undefined || status === undefined) {
    throw new Error('missing TUI children')
  }
  return {
    handle, screen, editor, transcript, approvalLine, queueLine, status,
    submitted, followUps, cancels, exits, dequeues,
    setRunning: (v: boolean): void => { running = v },
    setQueue: (v: string[]): void => { queue = v },
  }
}

describe('createTui', () => {
  it('paints the header note and a status line that tracks the running state', async () => {
    const test = mount()
    test.handle.start()
    expect(test.screen.started).toBe(true)
    const header = stripAnsi(test.transcript.render(80).join('\n'))
    expect(header).toContain('dsh')
    expect(header).toContain('test-model')
    expect(header).toContain('session-test')
    expect(stripAnsi(test.status.render(80)[0] ?? '')).toContain('idle')
    test.setRunning(true)
    expect(stripAnsi(test.status.render(80)[0] ?? '')).toContain('running')
    await test.handle.stop()
    expect(test.screen.stopped).toBe(true)
  })

  it('drains pending input (1000 ms) before stopping the terminal', async () => {
    const test = mount()
    const drainSpy = vi.spyOn(test.screen.terminal, 'drainInput')
    await test.handle.stop()
    expect(drainSpy).toHaveBeenCalledWith(1000)
    expect(test.screen.stopped).toBe(true)
  })

  it('spins the status line while a turn runs and settles when it ends', async () => {
    vi.useFakeTimers()
    try {
      const test = mount()
      const line = (): string => stripAnsi(test.status.render(80)[0] ?? '')
      test.handle.start()
      expect(line()).not.toContain('⠋')
      test.setRunning(true)
      vi.advanceTimersByTime(100)
      expect(line()).toContain('⠙')
      vi.advanceTimersByTime(100)
      expect(line()).toContain('⠹')
      test.setRunning(false)
      vi.advanceTimersByTime(100)
      expect(line()).toContain('idle')
      expect(line()).not.toContain('⠹')
      vi.advanceTimersByTime(100)
      // Repeated start/stop are no-ops once the timer is owned or cleared.
      test.handle.start()
      await test.handle.stop()
      await test.handle.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows state-dependent key hints in the status line', () => {
    const test = mount()
    const line = (): string => stripAnsi(test.status.render(200)[0] ?? '')
    // Idle: the input shortcuts.
    expect(line()).toContain('⏎ send')
    expect(line()).toContain('tab complete')
    expect(line()).toContain('^x copy')
    expect(line()).toContain('^g edit')
    expect(line()).toContain('^c/^d quit')
    expect(line()).not.toContain('esc/^c cancel')
    expect(line()).not.toContain('⏎ steer')
    expect(line()).not.toContain('^⏎ follow-up')
    test.setRunning(true)
    // Running: steering and cancelling lead; no queue yet, so no dequeue hint.
    expect(line()).toContain('⏎ steer')
    expect(line()).toContain('^⏎ follow-up')
    expect(line()).toContain('esc/^c cancel')
    expect(line()).not.toContain('alt+↑ dequeue')
    expect(line()).not.toContain('⏎ send')
    expect(line()).not.toContain('^g edit')
    test.setQueue(['queued one'])
    expect(line()).toContain('alt+↑ dequeue')
    test.setRunning(false)
    expect(line()).toContain('⏎ send')
  })

  it('cycles reasoning on Shift+Tab, consuming it', () => {
    const cycles: string[] = []
    const test = mount({ onCycleReasoning: () => { cycles.push('cycle') } })
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    expect(key('\x1b[Z')).toEqual({ consume: true })
    expect(cycles).toEqual(['cycle'])
  })

  it('lets Shift+Tab pass through when the runner did not wire it', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    expect(key('\x1b[Z')).toBeUndefined()
  })

  it('hides and shows thinking blocks on Ctrl+T, consuming it', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.handle.addAssistant('answer', 'a long thought')
    const shown = stripAnsi(test.transcript.render(80).join('\n'))
    expect(shown).toContain('a long thought')
    expect(key('\x14')).toEqual({ consume: true })
    const hidden = stripAnsi(test.transcript.render(80).join('\n'))
    expect(hidden).toContain('Thinking...')
    expect(hidden).not.toContain('a long thought')
    expect(key('\x14')).toEqual({ consume: true })
    const reshown = stripAnsi(test.transcript.render(80).join('\n'))
    expect(reshown).toContain('a long thought')
    expect(reshown).not.toContain('Thinking...')
  })

  it('shows the active reasoning level and think hints in the status line', () => {
    const test = mount({ reasoning: () => ({ level: 'High', available: true }) })
    const line = (): string => stripAnsi(test.status.render(200)[0] ?? '')
    expect(line()).toContain('test-model (High)')
    expect(line()).toContain('^t think')
    expect(line()).toContain('shift+tab level')
  })

  it('hides the reasoning level when off but keeps the hints while levels exist', () => {
    const test = mount({ reasoning: () => ({ level: undefined, available: true }) })
    const line = (): string => stripAnsi(test.status.render(200)[0] ?? '')
    expect(line()).not.toContain('(High)')
    expect(line()).toContain('test-model')
    expect(line()).toContain('^t think')
    expect(line()).toContain('shift+tab level')
  })

  it('keeps the think toggle hint but drops the level hint when the model exposes no levels', () => {
    const test = mount({ reasoning: () => ({ level: undefined, available: false }) })
    const line = (): string => stripAnsi(test.status.render(200)[0] ?? '')
    expect(line()).toContain('^t think')
    expect(line()).not.toContain('shift+tab')
    expect(line()).toContain('test-model')
  })

  it('submits non-empty editor text to the runner and records history', () => {
    const test = mount()
    const submit = test.editor.onSubmit
    if (submit === null) throw new Error('no submit handler')
    submit('')
    expect(test.submitted).toEqual([])
    submit('hello')
    expect(test.submitted).toEqual(['hello'])
    expect(test.editor.history).toEqual(['hello'])
  })

  it('queues a follow-up turn on Ctrl+Enter, clearing the editor and recording history', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.editor.setText('do this after')
    // Plain Enter is not the follow-up key; only the distinct Ctrl+Enter sequence is.
    expect(key('\r')).toBeUndefined()
    expect(test.followUps).toEqual([])
    expect(key('\x1b[13;5u')).toEqual({ consume: true })
    expect(test.followUps).toEqual(['do this after'])
    expect(test.submitted).toEqual([])
    expect(test.editor.text).toBe('')
    expect(test.editor.history).toEqual(['do this after'])
  })

  it('ignores Ctrl+Enter when the editor is empty', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.editor.setText('   ')
    expect(key('\x1b[13;5u')).toEqual({ consume: true })
    expect(test.followUps).toEqual([])
    expect(test.editor.text).toBe('   ')
  })

  it('routes Ctrl+C by running state and Ctrl+D to exit, consuming both', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.setRunning(true)
    expect(key('\x03')).toEqual({ consume: true })
    expect(test.cancels).toEqual(['cancel'])
    test.setRunning(false)
    expect(key('\x03')).toEqual({ consume: true })
    expect(test.exits).toEqual(['exit'])
    expect(key('\x04')).toEqual({ consume: true })
    expect(test.exits).toEqual(['exit', 'exit'])
    expect(key('x')).toBeUndefined()
  })

  it('toggles full tool output on Ctrl+O and consumes the key', () => {
    const test = mount()
    test.handle.addToolCall('bash', '{"command":"ls"}')
    test.handle.addToolResult(false, 'out')
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    const collapsed = stripAnsi(test.transcript.render(80).join('\n'))
    expect(key('\x0f')).toEqual({ consume: true })
    const expanded = stripAnsi(test.transcript.render(80).join('\n'))
    expect(expanded).not.toBe(collapsed)
    expect(key('\x0f')).toEqual({ consume: true })
    expect(stripAnsi(test.transcript.render(80).join('\n'))).toBe(collapsed)
  })

  it('copies the last assistant message to the clipboard on Ctrl+X (OSC 52)', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    const writeSpy = vi.spyOn(test.screen.terminal, 'write')

    // No assistant message yet: consumed but nothing written.
    expect(key('\x18')).toEqual({ consume: true })
    expect(writeSpy).not.toHaveBeenCalled()

    // A committed message is copied as base64 in an OSC 52 clipboard sequence.
    test.handle.addAssistant('hello world', '')
    expect(key('\x18')).toEqual({ consume: true })
    const expected = `\x1b]52;c${Buffer.from('hello world', 'utf8').toString('base64')}\x07`
    expect(writeSpy).toHaveBeenLastCalledWith(expected)

    // A streamed message that finishes becomes the new "last" message.
    const draft = test.handle.beginAssistant()
    draft.textDelta('str')
    draft.finish('streamed answer', '')
    expect(key('\x18')).toEqual({ consume: true })
    const streamed = `\x1b]52;c${Buffer.from('streamed answer', 'utf8').toString('base64')}\x07`
    expect(writeSpy).toHaveBeenLastCalledWith(streamed)
  })

  it('opens the external editor on Ctrl+G, suspending then resuming the TUI', async () => {
    const seq: string[] = []
    const test = mount({
      editText: async (initial: string): Promise<string | undefined> => {
        seq.push(`edit:${initial}`)
        return 'edited text'
      },
    })
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    vi.spyOn(test.screen, 'stop').mockImplementation(() => { seq.push('stop') })
    vi.spyOn(test.screen, 'start').mockImplementation(() => { seq.push('start') })
    test.editor.setText('draft')
    expect(key('\x07')).toEqual({ consume: true })
    await new Promise(r => setTimeout(r, 0))
    // Suspend first, run the editor on the current text, resume last.
    expect(seq).toEqual(['stop', 'edit:draft', 'start'])
    expect(test.editor.getText()).toBe('edited text')
  })

  it('keeps the original text when the external editor is cancelled', async () => {
    const test = mount({
      editText: async (): Promise<string | undefined> => undefined,
    })
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    const startSpy = vi.spyOn(test.screen, 'start')
    test.editor.setText('keep me')
    expect(key('\x07')).toEqual({ consume: true })
    await new Promise(r => setTimeout(r, 0))
    expect(test.editor.getText()).toBe('keep me')
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  it('resumes the TUI even when the external editor fails to launch', async () => {
    const test = mount({
      editText: async (): Promise<string | undefined> => { throw new Error('spawn failed') },
    })
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    const startSpy = vi.spyOn(test.screen, 'start')
    test.editor.setText('original')
    expect(key('\x07')).toEqual({ consume: true })
    await new Promise(r => setTimeout(r, 0))
    expect(test.editor.getText()).toBe('original')
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  it('routes Escape to cancel while running and passes it through idle', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.setRunning(true)
    expect(key('\x1b')).toEqual({ consume: true })
    expect(test.cancels).toEqual(['cancel'])
    expect(test.exits).toEqual([])
    test.setRunning(false)
    // Idle Escape is not consumed so the editor can use it (autocomplete cancel).
    expect(key('\x1b')).toBeUndefined()
    expect(test.cancels).toEqual(['cancel'])
    expect(test.exits).toEqual([])
  })

  it('renders queued follow-ups above the editor and hides them when empty', () => {
    const test = mount()
    expect(test.queueLine.render(80)).toEqual([])
    test.setQueue(['first follow-up', 'second  follow-up'])
    const lines = stripAnsi(test.queueLine.render(80).join('\n')).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('⏳ first follow-up')
    expect(lines[1]).toContain('⏳ second follow-up')
    test.setQueue([])
    expect(test.queueLine.render(80)).toEqual([])
  })

  it('restores queued follow-ups into the editor on cancel', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.setRunning(true)
    test.setQueue(['queued one', 'queued two'])
    test.editor.setText('draft')
    expect(key('\x1b')).toEqual({ consume: true })
    expect(test.cancels).toEqual(['cancel'])
    // Cancel cleared the inbox; the editor holds the queue plus the old draft.
    expect(test.queueLine.render(80)).toEqual([])
    expect(test.editor.text).toBe('queued one\n\nqueued two\n\ndraft')
  })

  it('dequeues with Alt+Up while running and passes through when the queue is empty', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.setRunning(true)
    expect(key('\x1bp')).toBeUndefined()
    expect(test.dequeues).toEqual([])
    test.setQueue(['pulled back'])
    expect(key('\x1bp')).toEqual({ consume: true })
    expect(test.dequeues).toEqual([['pulled back']])
    expect(test.editor.text).toBe('pulled back')
    expect(test.queueLine.render(80)).toEqual([])
  })

  it('prepends dequeued follow-ups above existing editor text', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.setRunning(true)
    test.setQueue(['pulled back'])
    test.editor.setText('draft')
    expect(key('\x1bp')).toEqual({ consume: true })
    expect(test.editor.text).toBe('pulled back\n\ndraft')
  })

  it('restores queued follow-ups into an empty editor without a blank gap', () => {
    const test = mount()
    const key = test.screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    test.setRunning(true)
    test.setQueue(['queued one'])
    expect(key('\x1b')).toEqual({ consume: true })
    expect(test.editor.text).toBe('queued one')
  })

  it('skips whitespace-only queued follow-ups in the queue line', () => {
    const test = mount()
    test.setQueue(['   ', 'real one'])
    const lines = test.queueLine.render(80)
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0] ?? '')).toContain('⏳ real one')
  })

  it('mounts without a queue service and lets Alt+Up pass through', async () => {
    const handle = createTui({
      model: 'test-model',
      sessionId: 'session-test',
      isRunning: () => true,
      context: () => ({ used: 0, window: 164_000 }),
      onSubmit: (): void => {},
      onCancel: (): void => {},
      onExit: (): void => {},
    })
    const screen = captured.screens[captured.screens.length - 1]
    if (screen === undefined) throw new Error('no screen mounted')
    const key = screen.listeners[0]
    if (key === undefined) throw new Error('no key listener')
    expect(key('\x1bp')).toBeUndefined()
    const queueLine = screen.children[2]
    if (queueLine === undefined) throw new Error('missing queue line')
    expect(queueLine.render(80)).toEqual([])
    await handle.stop()
  })

  it('renders every transcript item kind, caches same-width frames, and re-wraps on resize', () => {
    const test = mount()
    test.handle.addUser('do the thing')
    test.handle.addAssistant('', '')
    test.handle.addAssistant('[link](http://example.com) and ~~gone~~', 'thinking hard')
    const draft = test.handle.beginAssistant()
    const beforeDraft = stripAnsi(test.transcript.render(80).join('\n'))
    expect(stripAnsi(test.transcript.render(80).join('\n'))).toBe(beforeDraft)
    draft.reasoningDelta('more thought')
    draft.textDelta('streaming')
    draft.finish('final answer', 'all thought')
    test.handle.addToolCall('bash', '{"command":"ls"}')
    test.handle.addToolCall('read_file', '{}')
    test.handle.addToolResult(false, 'ok output')
    test.handle.addToolResult(true, 'bad output')
    test.handle.addNote('a plain note')
    test.handle.addError('something failed')
    const wide = stripAnsi(test.transcript.render(80).join('\n'))
    expect(wide).toContain('❯ do the thing')
    expect(wide).toContain('link')
    expect(wide).toContain('gone')
    expect(wide).toContain('thinking hard')
    expect(wide).toContain('final answer')
    expect(wide).toContain('⚙ bash({"command":"ls"})')
    expect(wide).toContain('⚙ read_file')
    expect(wide).toContain('✓ ok output')
    expect(wide).toContain('✗ bad output')
    expect(wide).toContain('a plain note')
    expect(wide).toContain('something failed')
    // Same-width frame comes from the cache; a resize re-wraps.
    const cached = test.transcript.render(80)
    expect(test.transcript.render(80)).toBe(cached)
    const narrow = test.transcript.render(20)
    expect(narrow).not.toBe(cached)
    test.transcript.invalidate()
    test.approvalLine.invalidate()
    test.queueLine.invalidate()
    test.status.invalidate()
  })

  it('exposes beginNote on the handle, updating the transcript in place', () => {
    const test = mount()
    const note = test.handle.beginNote('⋯ compacting conversation…')
    expect(stripAnsi(test.transcript.render(80).join('\n'))).toContain('⋯ compacting conversation…')
    note.set('✓ compacted conversation')
    expect(stripAnsi(test.transcript.render(80).join('\n'))).toContain('✓ compacted conversation')
    expect(stripAnsi(test.transcript.render(80).join('\n'))).not.toContain('compacting')
  })

  it('clears every committed item for /clear', () => {
    const test = mount()
    test.handle.addUser('do the thing')
    test.handle.addNote('a plain note')
    expect(test.transcript.render(80)).not.toEqual([])
    test.handle.clearTranscript()
    expect(test.transcript.render(80)).toEqual([])
  })

  it('formats context usage in the status line with and without a window', () => {
    const test = mount()
    const line = (): string => stripAnsi(test.status.render(200)[0] ?? '')
    expect(line()).toContain('0/164k ctx')
    const used = mount({ context: () => ({ used: 500, window: 164_000 }) })
    expect(stripAnsi(used.status.render(200)[0] ?? '')).toContain('500/164k ctx')
    const whole = mount({ context: () => ({ used: 12_000, window: 164_000 }) })
    expect(stripAnsi(whole.status.render(200)[0] ?? '')).toContain('12k/164k ctx')
    const fraction = mount({ context: () => ({ used: 12_345, window: 164_000 }) })
    expect(stripAnsi(fraction.status.render(200)[0] ?? '')).toContain('12.3k/164k ctx')
    const noWindow = mount({ context: () => ({ used: 12_345 }) })
    expect(stripAnsi(noWindow.status.render(200)[0] ?? '')).toContain('12.3k ctx')
  })

  it('shows the session token total only once tokens have been spent', () => {
    const line = (test: ReturnType<typeof mount>): string => stripAnsi(test.status.render(200)[0] ?? '')
    // No total reported, or zero: no Σ segment.
    expect(line(mount())).not.toContain('Σ')
    expect(line(mount({ context: () => ({ used: 500, window: 164_000, total: 0 }) }))).not.toContain('Σ')
    // Non-zero total renders after the ctx segment.
    const withTotal = mount({ context: () => ({ used: 12_345, window: 164_000, total: 45_200 }) })
    const text = line(withTotal)
    expect(text).toContain('12.3k/164k ctx · Σ 45.2k')
  })

  it('shows session tok/s and cache % only once there is data to compute them', () => {
    const line = (test: ReturnType<typeof mount>): string => stripAnsi(test.status.render(200)[0] ?? '')
    // No throughput or cache data: neither segment appears.
    expect(line(mount())).not.toContain('t/s')
    expect(line(mount())).not.toContain('% cache')
    // Both present: rendered after the Σ segment.
    const withStats = mount({ context: () => ({ used: 12_345, window: 164_000, total: 45_200, tokensPerSec: 128.4, cachePercent: 66.4 }) })
    expect(line(withStats)).toContain('Σ 45.2k · 128 t/s · 66% cache')
    // Low throughput keeps one decimal; whole at/above ten rounds.
    expect(line(mount({ context: () => ({ used: 10, total: 10, tokensPerSec: 5.2 }) }))).toContain('5.2 t/s')
    expect(line(mount({ context: () => ({ used: 10, total: 10, tokensPerSec: 9.9 }) }))).toContain('9.9 t/s')
    // Cache % alone (no throughput) still renders.
    expect(line(mount({ context: () => ({ used: 10, total: 10, cachePercent: 100 }) }))).toContain('100% cache')
  })

  it('asks approval through the mounted gate and settles once on double answer', async () => {
    const test = mount()
    const promise = test.handle.askApproval('run bash')
    const line = stripAnsi(test.approvalLine.render(80)[0] ?? '')
    expect(line).toContain('Allow run bash? [y/n]')
    const answerer = test.screen.listeners[test.screen.listeners.length - 1]
    if (answerer === undefined) throw new Error('no approval listener')
    answerer('y')
    answerer('y')
    await expect(promise).resolves.toBe('allowed-once')
    expect(stripAnsi(test.approvalLine.render(80)[0] ?? '')).toBe('')
  })

  describe('git branch segment', () => {
    let repo: string | undefined

    afterEach(async () => {
      if (repo !== undefined) await rm(repo, { recursive: true, force: true })
      repo = undefined
    })

    async function makeRepo(head: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-branch-'))
      repo = dir
      await mkdir(join(dir, '.git'))
      await writeFile(join(dir, '.git', 'HEAD'), head)
      return dir
    }

    it('shows the branch and hides the segment without gitCwd', async () => {
      const plain = mount()
      expect(stripAnsi(plain.status.render(200)[0] ?? '')).not.toContain('⎇')
      const dir = await makeRepo('ref: refs/heads/feature/x\n')
      const test = mount({ gitCwd: dir })
      expect(stripAnsi(test.status.render(200)[0] ?? '')).toContain('test-model ⎇ feature/x ·')
      await test.handle.stop()
    })

    it('shows a short SHA for a detached HEAD', async () => {
      const sha = 'a'.repeat(40)
      const dir = await makeRepo(`${sha}\n`)
      const test = mount({ gitCwd: dir })
      expect(stripAnsi(test.status.render(200)[0] ?? '')).toContain(`⎇ ${sha.slice(0, 7)}`)
      await test.handle.stop()
    })
  })

  it('wires editor autocomplete only when a command roster is provided', async () => {
    const plain = mount()
    expect(plain.editor.providers).toEqual([])
    const wired = mount({ commands: () => [{ name: 'help', description: 'Show help' }] })
    expect(wired.editor.providers).toHaveLength(1)
    const provider = wired.editor.providers[0] as AutocompleteProvider
    const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal })
    expect(suggestions?.items.map(item => item.value)).toEqual(['help'])
    await plain.handle.stop()
    await wired.handle.stop()
  })
})

describe('createCommandAutocompleteProvider', () => {
  let baseDir: string | undefined

  afterEach(async () => {
    if (baseDir !== undefined) await rm(baseDir, { recursive: true, force: true })
    baseDir = undefined
  })

  const signal = (): AbortSignal => new AbortController().signal

  it('fuzzy-filters slash commands and re-reads the roster on every request', async () => {
    let roster: readonly SlashCommand[] = [
      { name: 'help', description: 'Show help' },
      { name: 'clear', description: 'Clear the transcript' },
    ]
    const provider = createCommandAutocompleteProvider(() => roster, process.cwd())
    const all = await provider.getSuggestions(['/'], 0, 1, { signal: signal() })
    expect(all?.items.map(item => item.value)).toEqual(['help', 'clear'])
    expect(all?.prefix).toBe('/')
    const fuzzy = await provider.getSuggestions(['/hp'], 0, 3, { signal: signal() })
    expect(fuzzy?.items.map(item => item.value)).toEqual(['help'])
    roster = [{ name: 'compact', description: 'Compact the context' }]
    const refreshed = await provider.getSuggestions(['/'], 0, 1, { signal: signal() })
    expect(refreshed?.items.map(item => item.value)).toEqual(['compact'])
  })

  it('completes a slash command name with a trailing space', () => {
    const provider = createCommandAutocompleteProvider(() => [{ name: 'help', description: 'Show help' }], process.cwd())
    const result = provider.applyCompletion(['/he'], 0, 3, { value: 'help', label: 'help' }, '/he')
    expect(result.lines).toEqual(['/help '])
    expect(result.cursorCol).toBe(6)
  })

  it('offers file paths under the base directory and nothing for plain prose', async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'dsh-tui-ac-'))
    await mkdir(join(baseDir, 'src'))
    await writeFile(join(baseDir, 'src', 'tui.ts'), '')
    await writeFile(join(baseDir, 'src', 'index.ts'), '')
    const provider = createCommandAutocompleteProvider(() => [], baseDir)
    const files = await provider.getSuggestions(['src/'], 0, 4, { signal: signal() })
    expect(files?.items.map(item => item.value).sort()).toEqual(['src/index.ts', 'src/tui.ts'])
    const prose = await provider.getSuggestions(['hello world'], 0, 11, { signal: signal() })
    expect(prose).toBeNull()
  })
})

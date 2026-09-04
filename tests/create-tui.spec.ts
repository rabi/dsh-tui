/** createTui composition over mocked terminal classes with the real text engine. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import { createTui } from '../src/tui.ts'

const captured = vi.hoisted(() => ({
  screens: [] as Array<{
    started: boolean
    stopped: boolean
    children: Component[]
    listeners: Array<(data: string) => { consume?: boolean } | undefined>
  }>,
  editors: [] as Array<{ onSubmit: ((text: string) => void) | null; history: string[] }>,
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
      started = false
      stopped = false
      children: Component[] = []
      listeners: Array<(data: string) => { consume?: boolean } | undefined> = []
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
      constructor() {
        captured.editors.push(this)
      }
      addToHistory(text: string): void {
        this.history.push(text)
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
  const cancels: string[] = []
  const exits: string[] = []
  let running = false
  const handle = createTui({
    model: 'test-model',
    sessionId: 'session-test',
    isRunning: () => running,
    context: () => ({ used: 0, window: 164_000 }),
    onSubmit: (text: string) => { submitted.push(text) },
    onCancel: () => { cancels.push('cancel') },
    onExit: () => { exits.push('exit') },
    ...options,
  })
  const screen = captured.screens[captured.screens.length - 1]
  if (screen === undefined) throw new Error('no screen mounted')
  const editor = captured.editors[captured.editors.length - 1]
  if (editor === undefined) throw new Error('no editor mounted')
  const transcript = screen.children[0]
  const approvalLine = screen.children[1]
  const status = screen.children[3]
  if (transcript === undefined || approvalLine === undefined || status === undefined) {
    throw new Error('missing TUI children')
  }
  return {
    handle, screen, editor, transcript, approvalLine, status,
    submitted, cancels, exits, setRunning: (v: boolean): void => { running = v },
  }
}

describe('createTui', () => {
  it('paints the header note and a status line that tracks the running state', () => {
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
    test.handle.stop()
    expect(test.screen.stopped).toBe(true)
  })

  it('spins the status line while a turn runs and settles when it ends', () => {
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
      test.handle.stop()
      test.handle.stop()
    } finally {
      vi.useRealTimers()
    }
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
    test.status.invalidate()
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
})

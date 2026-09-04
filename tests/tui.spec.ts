/**
 * The TUI presentation module without a terminal: transcript item rendering,
 * streaming drafts, per-width caches, and the serialized approval gate.
 */

import { describe, expect, it } from 'vitest'
import { createApprovalGate, Transcript } from '../src/tui.ts'

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')

/** One rendered line, failing the test when absent. */
const at = (lines: string[], index: number): string => {
  const line = lines[index]
  if (line === undefined) throw new Error(`missing rendered line ${String(index)}`)
  return line
}

describe('Transcript', () => {
  it('renders a user prompt with the cyan marker', () => {
    const t = new Transcript()
    t.addUser('hello world')
    const line = at(t.render(80), 0)
    expect(line.startsWith(' ')).toBe(true)
    expect(line).toContain('\x1b[36m❯\x1b[39m')
    expect(stripAnsi(line)).toBe(' ❯ hello world')
  })

  it('wraps long user prompts at the viewport width', () => {
    const t = new Transcript()
    t.addUser('a '.repeat(200).trim())
    const lines = t.render(40)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(40)
  })

  it('renders reasoning above the assistant text', () => {
    const t = new Transcript()
    t.addAssistant('the answer', 'thinking hard')
    const lines = t.render(80)
    const reasoningIndex = lines.findIndex(l => stripAnsi(l).includes('thinking hard'))
    const textIndex = lines.findIndex(l => stripAnsi(l).includes('the answer'))
    expect(reasoningIndex).toBeGreaterThanOrEqual(0)
    expect(textIndex).toBeGreaterThan(reasoningIndex)
    expect(lines[reasoningIndex]).toContain('\x1b[2m')
  })

  it('streams deltas into a draft and commits the final text', () => {
    const t = new Transcript()
    const draft = t.beginAssistant()
    draft.textDelta('Hel')
    draft.textDelta('lo')
    expect(t.render(80).some(l => stripAnsi(l).includes('Hello'))).toBe(true)
    draft.finish('The final text.', 'why not')
    const lines = t.render(80)
    expect(lines.some(l => stripAnsi(l).includes('The final text.'))).toBe(true)
    expect(lines.some(l => stripAnsi(l).includes('Hello'))).toBe(false)
    expect(lines.some(l => stripAnsi(l).includes('why not'))).toBe(true)
  })

  it('renders tool calls with truncated arguments and bare names for empty args', () => {
    const t = new Transcript()
    t.addToolCall('bash', '{"command":"ls -la"}')
    t.addToolCall('read_file', '{}')
    const lines = t.render(80)
    expect(stripAnsi(at(lines, 0))).toContain('⚙ bash(')
    expect(stripAnsi(at(lines, 0))).toContain('ls -la')
    expect(stripAnsi(at(lines, 1))).toBe(' ⚙ read_file')
  })

  it('marks tool results by success or failure', () => {
    const t = new Transcript()
    t.addToolResult(false, 'all good')
    t.addToolResult(true, 'boom')
    const lines = t.render(80)
    expect(at(lines, 0)).toContain('\x1b[32m✓\x1b[39m')
    expect(at(lines, 1)).toContain('\x1b[31m✗\x1b[39m')
  })

  it('renders an edit diff with red removals and green additions under a dim header', () => {
    const t = new Transcript()
    t.addDiff('edit src/a.ts', 'old one\nold two', 'new one\n\nnew three\n')
    const lines = t.render(80)
    expect(stripAnsi(at(lines, 0))).toBe(' ⚙ edit src/a.ts')
    expect(stripAnsi(at(lines, 1))).toBe(' - old one')
    expect(at(lines, 1)).toContain('\x1b[31m')
    expect(stripAnsi(at(lines, 2))).toBe(' - old two')
    expect(stripAnsi(at(lines, 3))).toBe(' + new one')
    expect(at(lines, 3)).toContain('\x1b[32m')
    expect(stripAnsi(at(lines, 4))).toBe(' + ')
    expect(stripAnsi(at(lines, 5))).toBe(' + new three')
  })

  it('renders a write diff as additions only when there is no prior content', () => {
    const t = new Transcript()
    t.addDiff('write src/b.ts', null, 'line one')
    const lines = t.render(80)
    expect(stripAnsi(at(lines, 0))).toBe(' ⚙ write src/b.ts')
    expect(stripAnsi(at(lines, 1))).toBe(' + line one')
    expect(lines).toHaveLength(2)
  })

  it('caps a diff at the line budget and notes the hidden remainder', () => {
    const t = new Transcript()
    const many = Array.from({ length: 50 }, (_, i) => `line ${String(i)}`).join('\n')
    t.addDiff('edit big.ts', many, 'done')
    const lines = t.render(80)
    expect(stripAnsi(at(lines, 41))).toBe(' … +11 more lines')
    expect(lines).toHaveLength(42)
    expect(lines.some(l => stripAnsi(l).includes('line 49'))).toBe(false)
  })

  it('wraps long diff lines and indents continuations under the marker', () => {
    const t = new Transcript()
    t.addDiff('edit wide.ts', 'x'.repeat(90), 'y'.repeat(90))
    const lines = t.render(40)
    const minus = lines.filter(l => l.includes('\x1b[31m'))
    expect(minus.length).toBeGreaterThan(1)
    expect(stripAnsi(minus[0] ?? '')).toMatch(/^ - /)
    for (const continuation of minus.slice(1)) {
      expect(stripAnsi(continuation)).toMatch(/^   /)
    }
  })
  it('caches renders per width and re-renders after invalidation', () => {
    const t = new Transcript()
    t.addUser('stable')
    const first = t.render(60)
    expect(t.render(60)).toBe(first)
    expect(t.render(70)).not.toBe(first)
    const draft = t.beginAssistant()
    draft.textDelta('new')
    expect(t.render(60)).not.toBe(first)
  })
})

interface GateHarness {
  gate: ReturnType<typeof createApprovalGate>
  listeners: Set<(data: string) => { consume?: boolean } | undefined>
  lines: string[]
}

function makeGate(): GateHarness {
  const listeners: GateHarness['listeners'] = new Set()
  const lines: string[] = []
  const gate = createApprovalGate({
    addListener: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    requestRender: () => {},
    setLine: text => void lines.push(text),
  })
  return { gate, listeners, lines }
}

function press(harness: GateHarness, data: string): void {
  for (const listener of [...harness.listeners]) listener(data)
}

const nextTick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createApprovalGate', () => {
  it('resolves allowed-once on y and clears the prompt line', async () => {
    const h = makeGate()
    const pending = h.gate.ask('run bash')
    expect(h.lines.at(-1)).toContain('Allow run bash? [y/n]')
    press(h, 'y')
    await expect(pending).resolves.toBe('allowed-once')
    expect(h.listeners.size).toBe(0)
    expect(h.lines.at(-1)).toBe('')
  })

  it('resolves rejected on n', async () => {
    const h = makeGate()
    const pending = h.gate.ask('run bash')
    press(h, 'n')
    await expect(pending).resolves.toBe('rejected')
  })

  it('ignores unrelated keys while waiting', async () => {
    const h = makeGate()
    const pending = h.gate.ask('run bash')
    press(h, 'x')
    expect(h.listeners.size).toBe(1)
    press(h, 'Y')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('resolves cancelled when the request signal aborts', async () => {
    const h = makeGate()
    const controller = new AbortController()
    const pending = h.gate.ask('run bash', controller.signal)
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(h.listeners.size).toBe(0)
  })

  it('resolves cancelled immediately for an already-aborted signal', async () => {
    const h = makeGate()
    const controller = new AbortController()
    controller.abort()
    await expect(h.gate.ask('run bash', controller.signal)).resolves.toBe('cancelled')
    expect(h.lines).toEqual([])
  })

  it('serializes concurrent requests FIFO', async () => {
    const h = makeGate()
    const first = h.gate.ask('first tool')
    const second = h.gate.ask('second tool')
    await nextTick()
    expect(h.lines.filter(l => l !== '')).toEqual([expect.stringContaining('first tool')])
    press(h, 'n')
    await expect(first).resolves.toBe('rejected')
    await nextTick()
    expect(h.lines.filter(l => l !== '')).toEqual([
      expect.stringContaining('first tool'),
      expect.stringContaining('second tool'),
    ])
    press(h, 'y')
    await expect(second).resolves.toBe('allowed-once')
  })
})

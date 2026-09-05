/** runExternalEditor: editor resolution, temp-file round-trip, and exit handling. */

import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveEditor, runExternalEditor } from '../src/external-editor.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const mockedSpawn = vi.mocked(spawn)

/** A fake child process that fires a single close (or error) event. */
function fakeChild(opts: { code?: number | null; error?: Error }): unknown {
  return {
    on(event: string, cb: (...args: unknown[]) => void): void {
      if (event === 'close' && opts.code !== undefined) queueMicrotask(() => cb(opts.code))
      if (event === 'error' && opts.error !== undefined) queueMicrotask(() => cb(opts.error))
    },
  }
}

afterEach(() => {
  mockedSpawn.mockReset()
})

describe('resolveEditor', () => {
  it('prefers $VISUAL, then $EDITOR, then vi', () => {
    expect(resolveEditor({ VISUAL: 'code -w', EDITOR: 'nano' })).toBe('code -w')
    expect(resolveEditor({ EDITOR: 'nano' })).toBe('nano')
    expect(resolveEditor({})).toBe('vi')
  })
})

describe('runExternalEditor', () => {
  it('uses $VISUAL, seeds the temp file, and adopts the edited text', async () => {
    mockedSpawn.mockImplementation((_cmd, args) => {
      const file = args[args.length - 1] as string
      writeFileSync(file, 'edited\n') // simulate the editor saving changes
      return fakeChild({ code: 0 })
    })
    const result = await runExternalEditor('original', { VISUAL: 'myed -x', EDITOR: 'nano' })
    expect(result).toBe('edited\n')
    expect(mockedSpawn).toHaveBeenCalledWith(
      'myed',
      ['-x', expect.stringContaining('prompt.txt')],
      { stdio: 'inherit' },
    )
  })

  it('falls back to $EDITOR when $VISUAL is unset', async () => {
    mockedSpawn.mockImplementation(() => fakeChild({ code: 0 }))
    await runExternalEditor('x', { EDITOR: 'nano' })
    expect(mockedSpawn).toHaveBeenCalledWith('nano', [expect.any(String)], { stdio: 'inherit' })
  })

  it('defaults to vi when neither variable is set', async () => {
    mockedSpawn.mockImplementation(() => fakeChild({ code: 0 }))
    await runExternalEditor('x', {})
    expect(mockedSpawn).toHaveBeenCalledWith('vi', [expect.any(String)], { stdio: 'inherit' })
  })

  it('returns the seed unchanged when the editor exits without saving', async () => {
    mockedSpawn.mockImplementation(() => fakeChild({ code: 0 }))
    const result = await runExternalEditor('untouched', {})
    expect(result).toBe('untouched')
  })

  it('resolves undefined when the editor exits non-zero', async () => {
    mockedSpawn.mockImplementation(() => fakeChild({ code: 1 }))
    const result = await runExternalEditor('x', {})
    expect(result).toBeUndefined()
  })

  it('resolves undefined when the process is killed by a signal', async () => {
    mockedSpawn.mockImplementation(() => fakeChild({ code: null }))
    const result = await runExternalEditor('x', {})
    expect(result).toBeUndefined()
  })

  it('resolves undefined when the editor fails to launch', async () => {
    mockedSpawn.mockImplementation(() => fakeChild({ error: new Error('ENOENT') }))
    const result = await runExternalEditor('x', {})
    expect(result).toBeUndefined()
  })
})

/**
 * The TUI app's ordinary command-line provider over a real Loader tree:
 * `--session`/`--resume` become the injected startup service, while help and
 * usage errors leave the consumer pending.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  runnerMounted: boolean
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(args: string[]): Promise<{ startup: TuiStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  const observed: Observed = { exits: [], out: '', runnerMounted: false }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx) { globalThis.__tuiObserved.runnerMounted = true }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-runner',
    `  name: ${rowUrl}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '- id: tui-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __tuiApply: typeof apply
    __tuiObserved: Observed
  }
  globals.__tuiApply = apply
  globals.__tuiObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    startup: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('tui command-line provider', () => {
  it('mounts the runner with an empty startup on a bare invocation', async () => {
    const { startup, observed } = await bootStartup([])
    expect(startup).toEqual({})
    expect(observed.runnerMounted).toBe(true)
    expect(observed.exits).toEqual([])
  })

  it('publishes --resume as the resume session id', async () => {
    const { startup, observed } = await bootStartup(['--resume', 'abc123'])
    expect(startup).toEqual({ resumeSessionId: 'abc123' })
    expect(observed.runnerMounted).toBe(true)
    expect(observed.exits).toEqual([])
  })

  it('publishes --session as the fresh session id', async () => {
    const { startup, observed } = await bootStartup(['--session', 's1'])
    expect(startup).toEqual({ sessionId: 's1' })
    expect(observed.runnerMounted).toBe(true)
    expect(observed.exits).toEqual([])
  })

  it('rejects --session combined with --resume', async () => {
    const { startup, observed } = await bootStartup(['--session', 's1', '--resume', 'r1'])
    expect(observed.out).toContain('mutually exclusive')
    expect(startup).toBeUndefined()
    expect(observed.runnerMounted).toBe(false)
    expect(observed.exits).toEqual([1])
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { startup, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile tui')
    expect(observed.out).toContain('--resume')
    expect(startup).toBeUndefined()
    expect(observed.runnerMounted).toBe(false)
    expect(observed.exits).toEqual([0])
  })
})

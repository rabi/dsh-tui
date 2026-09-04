/**
 * The TUI app's command-line provider: parses `--session`, `--resume`, and
 * this app's `--help`, then publishes {@link TUI_STARTUP_SERVICE}. The runner
 * row injects that service, so the interactive surface mounts only for a real
 * invocation (never on `--help`).
 *
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** The parsed TUI startup values published as {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Exact id for a fresh session (`--session`); absent mints one. */
  sessionId?: string
  /** Persisted session id to continue (`--resume`). */
  resumeSessionId?: string
}

function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal chat with a DeepSeek Harness agent.')
    .helpOption('-h, --help', 'show this help')
    .option('--session <id>', 'use this exact id for a fresh session')
    .option('--resume <id>', 'continue a persisted session')
    .addHelpText(
      'after',
      `
Examples:
  dsh --profile tui                    start a fresh session
  dsh --profile tui --resume abc123    continue a persisted session
`,
    )
}

export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const opts = program.opts<{ session?: string; resume?: string }>()
    if (opts.session !== undefined && opts.resume !== undefined) {
      program.error('error: --session and --resume are mutually exclusive')
    }
    const values: TuiStartupValues = {}
    if (opts.session !== undefined) values.sessionId = opts.session
    if (opts.resume !== undefined) values.resumeSessionId = opts.resume
    ctx.provide(TUI_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}

/**
 * Run the user's external editor on a temporary file seeded with the current
 * text and resolve to the edited result. The editor is `$VISUAL`, else
 * `$EDITOR`, else `vi`. A clean exit resolves the file contents (which equal
 * the seed when nothing was saved); a non-zero exit or a launch failure
 * resolves `undefined` so the caller keeps the original text.
 *
 * @module @rabi/dsh-tui/external-editor
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Resolve the editor command: `$VISUAL`, else `$EDITOR`, else `vi`. */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL || env.EDITOR || 'vi'
}

/**
 * Edit `initial` in an external editor and resolve to the edited text, or
 * `undefined` when the editor exits non-zero or fails to launch. The seed is
 * written to a fresh temp file; the file (and its directory) are removed
 * before resolving.
 */
export async function runExternalEditor(
  initial: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  // resolveEditor always yields a non-empty command; the default guards the
  // (impossible) empty split under noUncheckedIndexedAccess.
  const [command = 'vi', ...args] = resolveEditor(env).split(/\s+/)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  const file = join(dir, 'prompt.txt')
  try {
    await writeFile(file, initial, 'utf8')
    const code = await waitForEditor(command, [...args, file])
    if (code !== 0) return undefined
    return await readFile(file, 'utf8')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Spawn `command args…` with inherited stdio and resolve to its exit code. */
function waitForEditor(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    // A missing binary surfaces as an 'error' event rather than a close.
    child.on('error', () => resolve(1))
    child.on('close', code => resolve(code ?? 1))
  })
}

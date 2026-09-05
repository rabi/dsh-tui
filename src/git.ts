/** Git status for the TUI status line: current branch or short SHA, live-updated. */
import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Walk up from `cwd` to find the repository's HEAD file.
 * Handles worktrees, where `.git` is a file pointing at the gitdir.
 * @param cwd - directory to start from (usually `process.cwd()`).
 * @returns the absolute HEAD path, or undefined when not inside a repository.
 */
export function findHeadPath(cwd: string): string | undefined {
  let dir = cwd
  for (;;) {
    const gitPath = join(dir, '.git')
    try {
      const stat = statSync(gitPath)
      if (stat.isDirectory()) return join(gitPath, 'HEAD')
      const target = readFileSync(gitPath, 'utf8').trim()
      if (target.startsWith('gitdir: ')) {
        const head = join(resolve(dir, target.slice(8)), 'HEAD')
        if (existsSync(head)) return head
      }
      return undefined
    } catch {
      // No readable .git here; keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Render a HEAD file's content as a status-line name.
 * @param head - raw HEAD content.
 * @returns the branch for a symbolic ref, the first seven hex chars for a
 * detached SHA, or 'unknown' when neither parses.
 */
export function headDisplay(head: string): string {
  const line = head.trim()
  if (line.startsWith('ref: ')) return line.slice(5).replace(/^refs\/heads\//u, '')
  return /^[0-9a-f]{40}$/u.test(line) ? line.slice(0, 7) : 'unknown'
}

/** HEAD poll cadence in milliseconds; branch switches are rare and cheap to catch late. */
const HEAD_POLL_MS = 1000

/**
 * Track the branch of the repository containing `cwd`.
 * @param cwd - directory inside the repository.
 * @param onChange - called after every refresh, including the first, so the UI repaints.
 * @returns the current display name and a disposer that stops polling.
 */
export function createGitStatus(cwd: string, onChange: () => void): { readonly branch: () => string | undefined; dispose(): void } {
  const headPath = findHeadPath(cwd)
  let branch: string | undefined
  if (headPath === undefined) {
    return { branch: (): string | undefined => branch, dispose(): void {} }
  }
  const refresh = (): void => {
    try {
      branch = headDisplay(readFileSync(headPath, 'utf8'))
    } catch {
      branch = undefined
    }
    onChange()
  }
  refresh()
  watchFile(headPath, { interval: HEAD_POLL_MS }, refresh)
  return {
    branch: (): string | undefined => branch,
    dispose(): void { unwatchFile(headPath, refresh) },
  }
}

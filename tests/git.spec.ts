/** Git status tracking: HEAD discovery, display parsing, and live refresh. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitStatus, findHeadPath, headDisplay } from '../src/git.ts'

const dirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-git-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('findHeadPath', () => {
  it('finds a regular repository from the root and a nested directory', async () => {
    const root = await makeDir()
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const nested = join(root, 'a', 'b')
    await mkdir(nested, { recursive: true })
    expect(findHeadPath(root)).toBe(join(root, '.git', 'HEAD'))
    expect(findHeadPath(nested)).toBe(join(root, '.git', 'HEAD'))
  })

  it('resolves a worktree .git file to its gitdir HEAD', async () => {
    const base = await makeDir()
    const gitDir = join(base, 'repo', '.git', 'worktrees', 'wt')
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n')
    const wt = join(base, 'wt')
    await mkdir(wt)
    await writeFile(join(wt, '.git'), `gitdir: ${gitDir}\n`)
    expect(findHeadPath(wt)).toBe(join(gitDir, 'HEAD'))
  })

  it('returns undefined for a worktree whose gitdir has no HEAD', async () => {
    const base = await makeDir()
    const gitDir = join(base, 'empty-wt')
    await mkdir(gitDir, { recursive: true })
    const wt = join(base, 'wt')
    await mkdir(wt)
    await writeFile(join(wt, '.git'), `gitdir: ${gitDir}\n`)
    expect(findHeadPath(wt)).toBeUndefined()
  })

  it('returns undefined for an unreadable or malformed .git file', async () => {
    const base = await makeDir()
    await writeFile(join(base, '.git'), 'not a gitdir pointer\n')
    expect(findHeadPath(base)).toBeUndefined()
  })

  it('returns undefined outside any repository', async () => {
    const dir = await makeDir()
    expect(findHeadPath(dir)).toBeUndefined()
  })
})

describe('headDisplay', () => {
  it('renders symbolic refs as branch names', () => {
    expect(headDisplay('ref: refs/heads/main\n')).toBe('main')
    expect(headDisplay('ref: refs/heads/feature/x\n')).toBe('feature/x')
    expect(headDisplay('ref: refs/remotes/origin/main\n')).toBe('refs/remotes/origin/main')
  })

  it('renders a detached SHA as its first seven chars', () => {
    expect(headDisplay(`${'b'.repeat(40)}\n`)).toBe('bbbbbbb')
  })

  it('renders unparseable content as unknown', () => {
    expect(headDisplay('garbage')).toBe('unknown')
    expect(headDisplay('')).toBe('unknown')
  })
})

describe('createGitStatus', () => {
  it('reports the branch, follows HEAD changes, and stops after dispose', async () => {
    const root = await makeDir()
    const head = join(root, '.git', 'HEAD')
    await mkdir(join(root, '.git'))
    await writeFile(head, 'ref: refs/heads/main\n')
    let changes = 0
    const status = createGitStatus(root, (): void => { changes += 1 })
    expect(status.branch()).toBe('main')
    expect(changes).toBeGreaterThanOrEqual(1)
    await writeFile(head, 'ref: refs/heads/other\n')
    await waitFor(() => status.branch() === 'other', 'the branch change')
    status.dispose()
    const settled = status.branch()
    await new Promise(resolve => setTimeout(resolve, 2500))
    expect(status.branch()).toBe(settled)
  })

  it('stays undefined outside a repository and disposes without error', () => {
    const status = createGitStatus(tmpdir(), (): void => {})
    expect(status.branch()).toBeUndefined()
    status.dispose()
  })

  it('stays undefined when the repository has no readable HEAD', async () => {
    const root = await makeDir()
    await mkdir(join(root, '.git'))
    let changes = 0
    const status = createGitStatus(root, (): void => { changes += 1 })
    expect(status.branch()).toBeUndefined()
    expect(changes).toBeGreaterThanOrEqual(1)
    status.dispose()
  })
})

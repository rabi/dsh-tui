#!/usr/bin/env node
/**
 * Link every @deepseek-ai/* workspace package of the sibling deepseek-harness
 * checkout into this repo's node_modules so tests resolve the same built lib/
 * instances production loads. Runs as postinstall; a no-op when the sibling
 * checkout is absent (consumer machines).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const harness = resolve(root, '..', 'deepseek-harness')
if (!existsSync(join(harness, 'package.json'))) {
  console.log('link-peers: no sibling deepseek-harness checkout; skipping')
  process.exit(0)
}

const scopeDir = join(root, 'node_modules', '@deepseek-ai')
rmSync(scopeDir, { recursive: true, force: true })
mkdirSync(scopeDir, { recursive: true })

const manifests = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path)
    } else if (entry.name === 'package.json') {
      manifests.push(path)
    }
  }
}
for (const tree of ['packages', 'vendor']) walk(join(harness, tree))

let linked = 0
for (const manifest of manifests) {
  const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
  const target = resolve(dirname(manifest))
  if (!existsSync(join(target, 'lib')) && !existsSync(join(target, 'src'))) continue
  const link = join(scopeDir, name.slice('@deepseek-ai/'.length))
  rmSync(link, { force: true })
  symlinkSync(target, link, 'dir')
  linked += 1
}
console.log(`link-peers: linked ${linked} @deepseek-ai packages from ${harness}`)

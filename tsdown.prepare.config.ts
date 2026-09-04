import { defineConfig } from 'tsdown'

/**
 * Consumer-side build for git installs (the `prepare` script): transpile
 * straight from src without tsc project references, which need the sibling
 * harness checkout that only dev machines have. Types are NOT checked here —
 * `pnpm run typecheck` owns that.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/startup.ts', 'src/tui.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  tsconfig: 'tsconfig.prepare.json',
})

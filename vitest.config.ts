import { defineConfig } from 'vitest/config'

// No path aliases: every @deepseek-ai/* import resolves through the
// node_modules/@deepseek-ai symlink to the sibling harness checkout's built
// lib/, so tests exercise the same module instances production loads.
// Requires `pnpm run build` in deepseek-harness after changes there.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})

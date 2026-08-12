import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 60000,
    include: ['tests/integration/security/**/*.test.{mjs,ts}'],
    passWithNoTests: true,
    testTimeout: 60000
  }
})

import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  sourcemap: true,
  clean: true,
  target: 'node22',
  noExternal: [/.*/],
  // Bundled CommonJS deps (multicast-dns) call require() for Node builtins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})

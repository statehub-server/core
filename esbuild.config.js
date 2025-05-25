const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/index.js',
  external: [],
  minify: true,
  sourcemap: false,
})
.catch(() => process.exit(1))

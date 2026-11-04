/** Runtime-only tsup config. Does not `import 'tsup'`, so it works when tsup
 *  lives in the parent app or was installed into the kit itself. */
export default {
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  outDir: 'dist',
};

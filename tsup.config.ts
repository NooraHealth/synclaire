import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'expo/index': 'src/expo/index.ts',
    'react/index': 'src/react/index.tsx',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  external: ['expo-sqlite', 'react', 'better-sqlite3'],
});

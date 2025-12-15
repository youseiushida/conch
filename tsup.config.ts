import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'], // 両対応
  dts: true,              // 型定義生成
  clean: true,
  sourcemap: true,
  // node-ptyはバイナリを含むためバンドルから除外(必須)
  external: ['node-pty', 'net'], 
});
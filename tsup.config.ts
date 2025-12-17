import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["cjs", "esm"], // 両対応
	dts: true, // 型定義生成
	clean: true,
	sourcemap: true,
	// @lydell/node-pty はバイナリを含むためバンドルから除外(必須)
	external: ["@lydell/node-pty", "net"],
});
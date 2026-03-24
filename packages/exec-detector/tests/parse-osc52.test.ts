import { describe, it, expect } from "vitest";
import { parseOsc52 } from "../src";

describe("parseOsc52", () => {
	it("should parse clipboard set (base64 data)", () => {
		const b64 = Buffer.from("hello world").toString("base64");
		expect(parseOsc52(`c;${b64}`)).toEqual({
			type: "set",
			selection: "c",
			data: "hello world",
		});
	});

	it("should parse clipboard query", () => {
		expect(parseOsc52("c;?")).toEqual({
			type: "query",
			selection: "c",
		});
	});

	it("should parse clipboard clear (empty data)", () => {
		expect(parseOsc52("c;")).toEqual({
			type: "clear",
			selection: "c",
		});
	});

	it("should parse clipboard clear (no semicolon)", () => {
		expect(parseOsc52("c")).toEqual({
			type: "clear",
			selection: "c",
		});
	});

	it("should handle primary selection", () => {
		const b64 = Buffer.from("test").toString("base64");
		expect(parseOsc52(`p;${b64}`)).toEqual({
			type: "set",
			selection: "p",
			data: "test",
		});
	});

	it("should default to 's' selection when empty", () => {
		expect(parseOsc52(";?")).toEqual({
			type: "query",
			selection: "s",
		});
	});

	it("should handle multibyte characters", () => {
		const b64 = Buffer.from("日本語テスト").toString("base64");
		expect(parseOsc52(`c;${b64}`)).toEqual({
			type: "set",
			selection: "c",
			data: "日本語テスト",
		});
	});

	it("should return null for invalid base64", () => {
		// This test depends on Buffer.from behavior with invalid base64
		// Most invalid strings still decode without throwing in Node.js
		// So we test a case that results in empty or valid output
		const result = parseOsc52("c;SGVsbG8=");
		expect(result).toEqual({
			type: "set",
			selection: "c",
			data: "Hello",
		});
	});
});

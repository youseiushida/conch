import { describe, it, expect } from "vitest";
import {
	parseOsc633,
	deserializeOsc633Message,
	serializeOsc633Message,
} from "../src";

describe("parseOsc633", () => {
	it("should parse A (PromptStart)", () => {
		expect(parseOsc633("A")).toEqual({ type: "PromptStart" });
	});

	it("should parse B (CommandStart)", () => {
		expect(parseOsc633("B")).toEqual({ type: "CommandStart" });
	});

	it("should parse C (CommandExecuted)", () => {
		expect(parseOsc633("C")).toEqual({ type: "CommandExecuted" });
	});

	it("should parse D (CommandFinished) with exit code", () => {
		expect(parseOsc633("D;0")).toEqual({
			type: "CommandFinished",
			exitCode: 0,
		});
		expect(parseOsc633("D;1")).toEqual({
			type: "CommandFinished",
			exitCode: 1,
		});
	});

	it("should parse D without exit code", () => {
		expect(parseOsc633("D")).toEqual({
			type: "CommandFinished",
			exitCode: undefined,
		});
	});

	it("should parse E (CommandLine)", () => {
		expect(parseOsc633("E;echo hello")).toEqual({
			type: "CommandLine",
			command: "echo hello",
			nonce: undefined,
		});
	});

	it("should parse E with nonce", () => {
		expect(parseOsc633("E;echo hello;abc123")).toEqual({
			type: "CommandLine",
			command: "echo hello",
			nonce: "abc123",
		});
	});

	it("should parse E with escaped characters", () => {
		// \x3b = semicolon, \x0a = newline
		expect(parseOsc633("E;echo\\x3bhello\\x0aworld")).toEqual({
			type: "CommandLine",
			command: "echo;hello\nworld",
			nonce: undefined,
		});
	});

	it("should parse F (ContinuationStart)", () => {
		expect(parseOsc633("F")).toEqual({ type: "ContinuationStart" });
	});

	it("should parse G (ContinuationEnd)", () => {
		expect(parseOsc633("G")).toEqual({ type: "ContinuationEnd" });
	});

	it("should parse H (RightPromptStart)", () => {
		expect(parseOsc633("H")).toEqual({ type: "RightPromptStart" });
	});

	it("should parse I (RightPromptEnd)", () => {
		expect(parseOsc633("I")).toEqual({ type: "RightPromptEnd" });
	});

	it("should parse P (Property) with Cwd", () => {
		expect(parseOsc633("P;Cwd=/home/user")).toEqual({
			type: "Property",
			key: "Cwd",
			value: "/home/user",
		});
	});

	it("should parse P with IsWindows", () => {
		expect(parseOsc633("P;IsWindows=True")).toEqual({
			type: "Property",
			key: "IsWindows",
			value: "True",
		});
	});

	it("should return null for P without =", () => {
		expect(parseOsc633("P;InvalidProp")).toBeNull();
	});

	it("should return null for unknown command", () => {
		expect(parseOsc633("Z")).toBeNull();
		expect(parseOsc633("")).toBeNull();
	});
});

describe("deserializeOsc633Message", () => {
	it("should decode \\xHH sequences", () => {
		expect(deserializeOsc633Message("hello\\x3bworld")).toBe(
			"hello;world",
		);
		expect(deserializeOsc633Message("line1\\x0aline2")).toBe(
			"line1\nline2",
		);
	});

	it("should decode \\\\ as backslash", () => {
		expect(deserializeOsc633Message("path\\\\to\\\\file")).toBe(
			"path\\to\\file",
		);
	});

	it("should handle mixed escapes", () => {
		expect(deserializeOsc633Message("a\\\\b\\x3bc")).toBe("a\\b;c");
	});

	it("should pass through plain text", () => {
		expect(deserializeOsc633Message("hello world")).toBe("hello world");
	});
});

describe("serializeOsc633Message", () => {
	it("should escape semicolons", () => {
		expect(serializeOsc633Message("echo;hello")).toBe("echo\\x3bhello");
	});

	it("should escape backslashes", () => {
		expect(serializeOsc633Message("path\\to")).toBe("path\\\\to");
	});

	it("should escape control characters", () => {
		expect(serializeOsc633Message("line1\nline2")).toBe(
			"line1\\x0aline2",
		);
	});

	it("should round-trip with deserialize", () => {
		const original = 'echo "hello; world" && echo \'done\'\n';
		const serialized = serializeOsc633Message(original);
		const deserialized = deserializeOsc633Message(serialized);
		expect(deserialized).toBe(original);
	});
});

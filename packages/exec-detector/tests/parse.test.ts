import { describe, it, expect } from "vitest";
import { parseOsc133, ShellIntegrationType } from "../src";

describe("parseOsc133", () => {
	it("should parse PromptStart (A)", () => {
		const result = parseOsc133("A");
		expect(result).toEqual({
			type: ShellIntegrationType.PromptStart,
			params: [],
		});
	});

	it("should parse CommandStart (B)", () => {
		const result = parseOsc133("B");
		expect(result).toEqual({
			type: ShellIntegrationType.CommandStart,
			params: [],
		});
	});

	it("should parse CommandExecuted (C)", () => {
		const result = parseOsc133("C");
		expect(result).toEqual({
			type: ShellIntegrationType.CommandExecuted,
			params: [],
		});
	});

	it("should parse CommandFinished (D) with exit code", () => {
		const result = parseOsc133("D;0");
		expect(result).toEqual({
			type: ShellIntegrationType.CommandFinished,
			params: ["0"],
		});
	});

	it("should parse D with multiple params", () => {
		const result = parseOsc133("D;0;123");
		expect(result).toEqual({
			type: ShellIntegrationType.CommandFinished,
			params: ["0", "123"],
		});
	});

	it("should parse A with WezTerm/Ghostty-style params", () => {
		const result = parseOsc133("A;aid=12;cl=w");
		expect(result).toEqual({
			type: ShellIntegrationType.PromptStart,
			params: ["aid=12", "cl=w"],
		});
	});

	it("should return null for unknown type L", () => {
		expect(parseOsc133("L")).toBeNull();
	});

	it("should return null for unknown type P", () => {
		expect(parseOsc133("P;k=i")).toBeNull();
	});

	it("should return null for empty string", () => {
		expect(parseOsc133("")).toBeNull();
	});

	it("should return null for arbitrary data", () => {
		expect(parseOsc133("X;foo;bar")).toBeNull();
	});
});

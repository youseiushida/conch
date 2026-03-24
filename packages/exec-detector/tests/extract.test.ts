import { describe, it, expect } from "vitest";
import { stripAnsiAndOsc, extractCommandOutput } from "../src";

describe("stripAnsiAndOsc", () => {
	it("should pass through plain text unchanged", () => {
		expect(stripAnsiAndOsc("hello world")).toBe("hello world");
	});

	it("should strip OSC with BEL terminator", () => {
		expect(stripAnsiAndOsc("before\x1b]133;A\x07after")).toBe(
			"beforeafter",
		);
	});

	it("should strip OSC with ST terminator", () => {
		expect(stripAnsiAndOsc("before\x1b]133;A\x1b\\after")).toBe(
			"beforeafter",
		);
	});

	it("should strip CSI sequences (SGR colors)", () => {
		expect(stripAnsiAndOsc("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("should strip CSI sequences (cursor movement)", () => {
		expect(stripAnsiAndOsc("\x1b[2Jcleared")).toBe("cleared");
	});

	it("should strip 2-char ESC sequences", () => {
		// ESC M (reverse index) - 'M' is in @-Z range (0x40-0x5A)
		expect(stripAnsiAndOsc("\x1bMtext")).toBe("text");
		// ESC D (index) - 'D' is in @-Z range
		expect(stripAnsiAndOsc("\x1bDtext")).toBe("text");
	});

	it("should strip DCS sequences", () => {
		expect(stripAnsiAndOsc("before\x1bPtmux;data\x1b\\after")).toBe(
			"beforeafter",
		);
	});

	it("should strip DCS with BEL terminator", () => {
		expect(stripAnsiAndOsc("before\x1bPdata\x07after")).toBe(
			"beforeafter",
		);
	});

	it("should strip APC sequences", () => {
		expect(stripAnsiAndOsc("before\x1b_Gdata\x1b\\after")).toBe(
			"beforeafter",
		);
	});

	it("should strip APC with BEL terminator", () => {
		expect(stripAnsiAndOsc("before\x1b_data\x07after")).toBe(
			"beforeafter",
		);
	});

	it("should strip mixed sequences", () => {
		const input =
			"\x1b]133;A\x07\x1b[32mhello\x1b[0m\x1b]133;B\x07\x1bPdcs\x1b\\world";
		expect(stripAnsiAndOsc(input)).toBe("helloworld");
	});
});

describe("extractCommandOutput", () => {
	it("should extract C-D bounded output", () => {
		const raw = "prompt\x1b]133;C\x07output text\x1b]133;D;0\x07next";
		expect(extractCommandOutput(raw, true)).toBe("output text");
	});

	it("should use last C-D pair with multiple pairs", () => {
		const raw =
			"\x1b]133;C\x07first\x1b]133;D;0\x07" +
			"prompt\x1b]133;C\x07second\x1b]133;D;0\x07";
		expect(extractCommandOutput(raw, true)).toBe("second");
	});

	it("should handle multi-line output", () => {
		const raw =
			"\x1b]133;C\x07line1\r\nline2\r\nline3\x1b]133;D;0\x07";
		expect(extractCommandOutput(raw, true)).toBe("line1\r\nline2\r\nline3");
	});

	it("should return empty string when no output between C and D", () => {
		const raw = "\x1b]133;C\x07\x1b]133;D;0\x07";
		expect(extractCommandOutput(raw, true)).toBe("");
	});

	it("should fallback to full strip when shellIntegrationUsed is false", () => {
		const raw = "\x1b[32mhello\x1b[0m";
		expect(extractCommandOutput(raw, false)).toBe("hello");
	});

	it("should fallback when D arrives without C", () => {
		const raw = "output\x1b]133;D;0\x07";
		expect(extractCommandOutput(raw, true)).toBe("output");
	});

	it("should fallback when C arrives without D", () => {
		const raw = "\x1b]133;C\x07output";
		expect(extractCommandOutput(raw, true)).toBe("output");
	});

	it("should strip ANSI within C-D region", () => {
		const raw =
			"\x1b]133;C\x07\x1b[32mcolored\x1b[0m text\x1b]133;D;0\x07";
		expect(extractCommandOutput(raw, true)).toBe("colored text");
	});

	it("should handle ST terminator in markers", () => {
		const raw =
			"prompt\x1b]133;C\x1b\\output\x1b]133;D;0\x1b\\next";
		expect(extractCommandOutput(raw, true)).toBe("output");
	});
});

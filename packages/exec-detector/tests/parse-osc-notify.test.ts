import { describe, it, expect } from "vitest";
import { parseOsc9, parseOsc777 } from "../src";

describe("parseOsc9", () => {
	it("should parse plain notification", () => {
		expect(parseOsc9("Build complete!")).toEqual({
			type: "notification",
			text: "Build complete!",
		});
	});

	it("should parse notification with special chars", () => {
		expect(parseOsc9("Hello World")).toEqual({
			type: "notification",
			text: "Hello World",
		});
	});

	it("should parse ConEmu progress (state + percentage)", () => {
		expect(parseOsc9("4;1;75")).toEqual({
			type: "progress",
			state: 1,
			percentage: 75,
		});
	});

	it("should parse ConEmu progress (state only)", () => {
		expect(parseOsc9("4;3")).toEqual({
			type: "progress",
			state: 3,
			percentage: undefined,
		});
	});

	it("should parse ConEmu progress remove (state 0)", () => {
		expect(parseOsc9("4;0")).toEqual({
			type: "progress",
			state: 0,
			percentage: undefined,
		});
	});

	it("should return null for other ConEmu subcommands", () => {
		expect(parseOsc9("1;500")).toBeNull(); // sleep
		expect(parseOsc9("2;message")).toBeNull(); // message box
		expect(parseOsc9("3;Tab Title")).toBeNull(); // tab title
	});

	it("should not confuse text starting with number as ConEmu subcommand", () => {
		// "42 new messages" - "42" > 11, so treated as notification
		expect(parseOsc9("42;new messages")).toEqual({
			type: "notification",
			text: "42;new messages",
		});
	});

	it("should handle text that looks like subcommand but is not integer", () => {
		expect(parseOsc9("4a;data")).toEqual({
			type: "notification",
			text: "4a;data",
		});
	});
});

describe("parseOsc777", () => {
	it("should parse notify with title and body", () => {
		expect(parseOsc777("notify;Build;Success!")).toEqual({
			title: "Build",
			body: "Success!",
		});
	});

	it("should handle body with semicolons", () => {
		expect(parseOsc777("notify;Title;Body;with;semicolons")).toEqual({
			title: "Title",
			body: "Body;with;semicolons",
		});
	});

	it("should return null for non-notify subcommand", () => {
		expect(parseOsc777("other;title;body")).toBeNull();
	});

	it("should return null for missing body", () => {
		expect(parseOsc777("notify;title")).toBeNull();
	});

	it("should return null for empty data", () => {
		expect(parseOsc777("")).toBeNull();
	});
});

import { describe, it, expect } from "vitest";
import { parseOsc8 } from "../src";

describe("parseOsc8", () => {
	it("should parse hyperlink start with URI only", () => {
		expect(parseOsc8(";http://example.com")).toEqual({
			type: "start",
			uri: "http://example.com",
			id: undefined,
			params: {},
		});
	});

	it("should parse hyperlink start with id param", () => {
		expect(parseOsc8("id=foo;http://example.com")).toEqual({
			type: "start",
			uri: "http://example.com",
			id: "foo",
			params: { id: "foo" },
		});
	});

	it("should parse hyperlink start with multiple params", () => {
		expect(parseOsc8("id=xyz:class=link;http://example.com")).toEqual({
			type: "start",
			uri: "http://example.com",
			id: "xyz",
			params: { id: "xyz", class: "link" },
		});
	});

	it("should parse hyperlink end (empty URI)", () => {
		expect(parseOsc8(";")).toEqual({ type: "end" });
	});

	it("should parse hyperlink end with empty params", () => {
		expect(parseOsc8(";")).toEqual({ type: "end" });
	});

	it("should return null for missing semicolon", () => {
		expect(parseOsc8("no-semicolon")).toBeNull();
	});

	it("should handle file:// URIs", () => {
		expect(parseOsc8(";file:///path/to/file")).toEqual({
			type: "start",
			uri: "file:///path/to/file",
			id: undefined,
			params: {},
		});
	});
});

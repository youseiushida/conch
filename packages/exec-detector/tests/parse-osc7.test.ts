import { describe, it, expect } from "vitest";
import { parseOsc7 } from "../src";

describe("parseOsc7", () => {
	it("should parse file:// with hostname", () => {
		expect(parseOsc7("file://myhost/home/user")).toEqual({
			scheme: "file",
			hostname: "myhost",
			path: "/home/user",
		});
	});

	it("should parse file:// with empty hostname (localhost)", () => {
		expect(parseOsc7("file:///home/user")).toEqual({
			scheme: "file",
			hostname: "",
			path: "/home/user",
		});
	});

	it("should parse file:// with localhost", () => {
		expect(parseOsc7("file://localhost/tmp")).toEqual({
			scheme: "file",
			hostname: "localhost",
			path: "/tmp",
		});
	});

	it("should decode percent-encoded paths for file://", () => {
		expect(parseOsc7("file://host/path%20with%20spaces")).toEqual({
			scheme: "file",
			hostname: "host",
			path: "/path with spaces",
		});
	});

	it("should parse kitty-shell-cwd:// scheme", () => {
		expect(parseOsc7("kitty-shell-cwd://myhost/home/user")).toEqual({
			scheme: "kitty-shell-cwd",
			hostname: "myhost",
			path: "/home/user",
		});
	});

	it("should NOT decode percent-encoding for kitty-shell-cwd://", () => {
		expect(parseOsc7("kitty-shell-cwd://host/path%20raw")).toEqual({
			scheme: "kitty-shell-cwd",
			hostname: "host",
			path: "/path%20raw",
		});
	});

	it("should return null for unknown scheme", () => {
		expect(parseOsc7("http://example.com")).toBeNull();
		expect(parseOsc7("ftp://host/path")).toBeNull();
	});

	it("should return null for missing path", () => {
		expect(parseOsc7("file://hostname")).toBeNull();
	});

	it("should handle root path", () => {
		expect(parseOsc7("file://host/")).toEqual({
			scheme: "file",
			hostname: "host",
			path: "/",
		});
	});
});

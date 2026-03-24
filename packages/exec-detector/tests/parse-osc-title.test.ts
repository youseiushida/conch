import { describe, it, expect } from "vitest";
import { parseOscTitle } from "../src";

describe("parseOscTitle", () => {
	it("should parse window title", () => {
		expect(parseOscTitle("vim - file.txt")).toEqual({
			title: "vim - file.txt",
		});
	});

	it("should handle empty title", () => {
		expect(parseOscTitle("")).toEqual({ title: "" });
	});

	it("should preserve special characters", () => {
		expect(parseOscTitle("user@host: ~/project")).toEqual({
			title: "user@host: ~/project",
		});
	});
});

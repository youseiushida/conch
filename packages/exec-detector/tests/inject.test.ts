import { describe, it, expect } from "vitest";
import { encodeScriptForShell } from "../src";

describe("encodeScriptForShell", () => {
	it("should generate bash eval command", () => {
		const result = encodeScriptForShell("echo hello", "bash");
		expect(result).toContain('eval "$(printf');
		expect(result).toContain("base64");
	});

	it("should generate pwsh iex command", () => {
		const result = encodeScriptForShell("echo hello", "pwsh");
		expect(result).toContain("FromBase64String");
		expect(result).toContain("iex");
	});

	it("should encode script as valid base64 (bash)", () => {
		const script = 'echo "hello world"';
		const result = encodeScriptForShell(script, "bash");
		// Extract base64 from the command
		const match = result.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
		expect(match).not.toBeNull();
		const decoded = Buffer.from(match![1], "base64").toString("utf-8");
		expect(decoded).toBe(script);
	});

	it("should encode script as valid base64 (pwsh)", () => {
		const script = "Write-Host 'hello'";
		const result = encodeScriptForShell(script, "pwsh");
		const match = result.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
		expect(match).not.toBeNull();
		const decoded = Buffer.from(match![1], "base64").toString("utf-8");
		expect(decoded).toBe(script);
	});

	it("should throw for unsupported shell", () => {
		expect(() =>
			encodeScriptForShell("test", "zsh" as "bash"),
		).toThrow("Unsupported shell for injection: zsh");
	});

	it("should handle scripts with special characters", () => {
		const script = 'echo "hello; world" && echo \'done\'';
		const result = encodeScriptForShell(script, "bash");
		const match = result.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
		const decoded = Buffer.from(match![1], "base64").toString("utf-8");
		expect(decoded).toBe(script);
	});
});

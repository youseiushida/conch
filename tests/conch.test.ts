import { describe, it, expect, vi } from "vitest";
import { Conch } from "../src/conch";
import { MockBackend } from "./utils/MockBackend";

describe("Conch (Facade)", () => {
	it("launch() should accept backend instance and spawn it", async () => {
		const backend = new MockBackend();

		const conch = await Conch.launch({
			backend,
			cols: 80,
			rows: 24,
			timeoutMs: 50,
		});

		expect(backend.spawn).toHaveBeenCalledTimes(1);
		expect(conch.backend).toBe(backend);
		expect(conch.session).toBeDefined();

		conch.dispose();
	});

	it("run() should resolve with exitCode and stripped output when OSC133 C+D arrives", async () => {
		const backend = new MockBackend();

		backend.write.mockImplementation((_data: string) => {
			// Full A/B/C/D flow: command echo → C → colored output → D
			backend.emitData('echo "HELLO"\r\n');
			backend.emitData("\x1b]133;C\x07");
			backend.emitData("\x1b[31mHELLO\x1b[0m\r\n");
			backend.emitData("\x1b]133;D;0\x07");
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		const result = await conch.run('echo "HELLO"', { timeoutMs: 1000 });

		expect(result.exitCode).toBe(0);
		expect(result.meta.method).toBe("osc133");
		expect(result.outputText).toContain("HELLO");
		expect(result.outputText).not.toContain("\x1b");
		expect(result.outputText).not.toContain('echo "HELLO"');
		expect(result.snapshotAfter).toBeDefined();
		expect(result.snapshotAfter?.text).toContain("HELLO");

		conch.dispose();
	});

	it("run() should fallback when OSC133 D is not observed (strict=false)", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((_data: string) => {
			backend.emitData("some output\r\n");
		});

		const conch = await Conch.launch({ backend, timeoutMs: 20 });

		const result = await conch.run("echo hi", { timeoutMs: 20, strict: false });

		expect(result.exitCode).toBeUndefined();
		expect(result.meta.method).toBe("fallback");
		expect(result.snapshotAfter).toBeDefined();

		conch.dispose();
	});

	it("run() should reject immediately on fatal backend error by default", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((_data: string) => {
			backend.emitError(new Error("fatal backend error"));
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		await expect(conch.run("cmd", { timeoutMs: 1000 })).rejects.toThrow(
			"fatal backend error",
		);

		conch.dispose();
	});

	it("run() should ignore fatal backend error when backendError: 'ignore'", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((_data: string) => {
			backend.emitError(new Error("fatal backend error"));
			backend.emitData("some output\r\n");
		});

		const conch = await Conch.launch({ backend, timeoutMs: 20 });

		const result = await conch.run("cmd", {
			timeoutMs: 20,
			strict: false,
			backendError: "ignore",
		});

		expect(result.meta.method).toBe("fallback");
		expect(result.exitCode).toBeUndefined();
		expect(result.outputText).toContain("some output");

		conch.dispose();
	});

	it("run() should allow snapshot: 'none'", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((_data: string) => {
			backend.emitData("cmd\r\n");
			backend.emitData("\x1b]133;C\x07");
			backend.emitData("OK\r\n");
			backend.emitData("\x1b]133;D;0\x07");
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		const result = await conch.run("cmd", { timeoutMs: 1000, snapshot: "none" });

		expect(result.outputText).toContain("OK");
		expect(result.snapshot).toBeUndefined();
		expect(result.snapshotAfter).toBeUndefined();

		conch.dispose();
	});

	it("run() should serialize concurrent calls to avoid OSC133 mixing", async () => {
		const backend = new MockBackend();
		const writes: string[] = [];

		backend.write.mockImplementation((data: string) => {
			writes.push(data);
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		const p1 = conch.run("cmd1", { timeoutMs: 1000 });
		const p2 = conch.run("cmd2", { timeoutMs: 1000 });

		// drain() in runInternal resolves immediately when queue is empty.
		await new Promise((r) => setTimeout(r, 50));

		// Only the first run should have executed.
		expect(writes).toHaveLength(1);
		expect(writes[0]).toBe("cmd1\r");

		// Complete cmd1 with C+D
		backend.emitData("cmd1\r\n");
		backend.emitData("\x1b]133;C\x07");
		backend.emitData("ONE\r\n");
		backend.emitData("\x1b]133;D;1\x07");
		const r1 = await p1;

		// After cmd1 completes, cmd2 should start.
		await new Promise((r) => setTimeout(r, 50));
		expect(writes).toHaveLength(2);
		expect(writes[1]).toBe("cmd2\r");

		backend.emitData("cmd2\r\n");
		backend.emitData("\x1b]133;C\x07");
		backend.emitData("TWO\r\n");
		backend.emitData("\x1b]133;D;2\x07");
		const r2 = await p2;

		expect(r1.exitCode).toBe(1);
		expect(r2.exitCode).toBe(2);

		expect(r1.outputText).toContain("ONE");
		expect(r2.outputText).toContain("TWO");

		expect(r1.outputText).not.toContain("TWO");
		expect(r2.outputText).not.toContain("ONE");

		expect(r1.snapshotAfter?.text).toContain("ONE");
		expect(r2.snapshotAfter?.text).toContain("TWO");

		conch.dispose();
	});

	it("pressAndSnapshot() should wait for change by default and return snapshot", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((data: string) => {
			if (data === "\r") {
				backend.emitData("PRESSED\r\n");
			}
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		const result = await conch.pressAndSnapshot("Enter", {
			snapshot: "viewport",
		});

		expect(result.meta.action).toBe("press");
		expect(result.meta.waited).toBe("change");
		expect(result.snapshot.text).toContain("PRESSED");

		conch.dispose();
	});

	it("typeAndSnapshot() should wait for change by default", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((data: string) => {
			backend.emitData(data);
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		const result = await conch.typeAndSnapshot("HELLO", { snapshot: "viewport" });

		expect(result.meta.action).toBe("type");
		expect(result.meta.waited).toBe("change");
		expect(result.snapshot.text).toContain("HELLO");

		conch.dispose();
	});

	describe("dispose guard", () => {
		it("should throw on sync methods after dispose", async () => {
			const backend = new MockBackend();
			const conch = await Conch.launch({ backend, timeoutMs: 50 });
			conch.dispose();

			expect(() => conch.execute("test")).toThrow("Conch instance is disposed");
			expect(() => conch.write("test")).toThrow("Conch instance is disposed");
			expect(() => conch.press("Enter")).toThrow("Conch instance is disposed");
			expect(() => conch.type("test")).toThrow("Conch instance is disposed");
			expect(() => conch.resize(100, 50)).toThrow("Conch instance is disposed");
			expect(() => conch.getSnapshot()).toThrow("Conch instance is disposed");
		});

		it("should throw/reject on promise methods after dispose", async () => {
			const backend = new MockBackend();
			const conch = await Conch.launch({ backend, timeoutMs: 50 });
			conch.dispose();

			await expect(conch.run("test")).rejects.toThrow("Conch instance is disposed");
			expect(() => conch.pressAndSnapshot("Enter")).toThrow("Conch instance is disposed");
			expect(() => conch.typeAndSnapshot("test")).toThrow("Conch instance is disposed");
			expect(() => conch.waitForText("x")).toThrow("Conch instance is disposed");
			expect(() => conch.waitForSilence()).toThrow("Conch instance is disposed");
			expect(() => conch.drain()).toThrow("Conch instance is disposed");
		});
	});

	describe("extractCommandOutput", () => {
		it("should extract C-D bounded output precisely", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((_data: string) => {
				// Full realistic flow: echo → C → output → D → A → prompt
				backend.emitData('echo "hello"\r\n');
				backend.emitData("\x1b]133;C\x07");
				backend.emitData("hello\r\n");
				backend.emitData("\x1b]133;D;0\x07");
				backend.emitData("\x1b]133;A\x07$ ");
			});

			const conch = await Conch.launch({ backend, timeoutMs: 1000 });
			const result = await conch.run('echo "hello"', { timeoutMs: 1000 });

			expect(result.exitCode).toBe(0);
			expect(result.outputText.trim()).toBe("hello");
			expect(result.outputText).not.toContain('echo "hello"');
			expect(result.outputText).not.toContain("$");

			conch.dispose();
		});

		it("should handle residual output with multiple C-D pairs", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((_data: string) => {
				// Residual from prior command + our command's C-D
				backend.emitData("residual junk\r\n");
				backend.emitData("\x1b]133;C\x07");  // prior C (spurious)
				backend.emitData("\x1b]133;D;0\x07"); // prior D
				backend.emitData("\x1b]133;A\x07$ "); // prompt
				backend.emitData('echo "real"\r\n');  // our command echo
				backend.emitData("\x1b]133;C\x07");   // our C
				backend.emitData("real output\r\n");  // our output
				backend.emitData("\x1b]133;D;0\x07"); // our D
			});

			const conch = await Conch.launch({ backend, timeoutMs: 1000 });
			const result = await conch.run('echo "real"', { timeoutMs: 1000 });

			expect(result.outputText.trim()).toBe("real output");
			expect(result.outputText).not.toContain("residual");
			expect(result.outputText).not.toContain("$");
			expect(result.outputText).not.toContain('echo "real"');

			conch.dispose();
		});

		it("should fall back to D-only extraction when C is absent", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((_data: string) => {
				// No C marker — legacy/fallback path
				backend.emitData('echo "fallback"\r\n');
				backend.emitData("fallback output\r\n");
				backend.emitData("\x1b]133;D;0\x07");
			});

			const conch = await Conch.launch({ backend, timeoutMs: 1000 });
			const result = await conch.run('echo "fallback"', { timeoutMs: 1000 });

			expect(result.outputText).toContain("fallback output");
			expect(result.outputText).not.toContain('echo "fallback"');

			conch.dispose();
		});

		it("should handle multi-line output in C-D boundaries", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((_data: string) => {
				backend.emitData("cmd\r\n");
				backend.emitData("\x1b]133;C\x07");
				backend.emitData("line1\r\nline2\r\nline3\r\n");
				backend.emitData("\x1b]133;D;0\x07");
			});

			const conch = await Conch.launch({ backend, timeoutMs: 1000 });
			const result = await conch.run("cmd", { timeoutMs: 1000 });

			expect(result.outputText).toContain("line1");
			expect(result.outputText).toContain("line2");
			expect(result.outputText).toContain("line3");
			expect(result.outputText).not.toContain("cmd");

			conch.dispose();
		});

		it("should return empty string when command produces no output", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((_data: string) => {
				backend.emitData("true\r\n");
				backend.emitData("\x1b]133;C\x07");
				backend.emitData("\x1b]133;D;0\x07");
			});

			const conch = await Conch.launch({ backend, timeoutMs: 1000 });
			const result = await conch.run("true", { timeoutMs: 1000 });

			expect(result.outputText).toBe("");
			expect(result.exitCode).toBe(0);

			conch.dispose();
		});
	});

	describe("Locator / Assertion Shortcuts", () => {
		it("screenText() should return current snapshot text", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((data) => backend.emitData(data));

			const conch = await Conch.launch({ backend });
			conch.type("ABC");
			await conch.drain();

			expect(conch.screenText()).toContain("ABC");
			conch.dispose();
		});

		it("hasText() should return boolean presence", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((data) => backend.emitData(data));

			const conch = await Conch.launch({ backend });
			conch.type("XYZ");
			await conch.drain();

			expect(conch.hasText("XYZ")).toBe(true);
			expect(conch.hasText(/X.Z/)).toBe(true);
			expect(conch.hasText("FOO")).toBe(false);
			conch.dispose();
		});

		it("findText() should delegate to locator util", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((data) => backend.emitData(data));

			const conch = await Conch.launch({ backend });
			conch.type("FOO BAR FOO");
			await conch.drain();

			const matches = conch.findText("FOO");
			expect(matches).toHaveLength(2);
			expect(matches[0].match).toBe("FOO");
			expect(matches[1].match).toBe("FOO");

			conch.dispose();
		});

		it("cropText() should delegate to locator util", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((data) => backend.emitData(data));

			const conch = await Conch.launch({ backend });
			conch.type("12345");
			await conch.drain();

			const cropped = conch.cropText({ x: 0, y: 0, width: 3, height: 1 });
			expect(cropped).toBe("123");

			conch.dispose();
		});
	});
});

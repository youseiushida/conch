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

	it("run() should resolve with exitCode and stripped output when OSC133 D arrives", async () => {
		const backend = new MockBackend();

		backend.write.mockImplementation((_data: string) => {
			backend.emitData("\x1b[31mHELLO\x1b[0m\r\n");
			backend.emitData("\x1b]133;D;0\x07");
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		const result = await conch.run('echo "HELLO"', { timeoutMs: 1000 });

		expect(result.exitCode).toBe(0);
		expect(result.meta.method).toBe("osc133");
		expect(result.outputText).toContain("HELLO");
		expect(result.outputText).not.toContain("\x1b");
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

	it("run() should allow snapshot: 'none'", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((_data: string) => {
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

		// Let the first queued run start.
		await Promise.resolve();

		// Only the first run should have executed immediately.
		expect(writes).toHaveLength(1);
		expect(writes[0]).toBe("cmd1\r");

		// Complete cmd1
		backend.emitData("ONE\r\n");
		backend.emitData("\x1b]133;D;1\x07");
		const r1 = await p1;

		// After cmd1 completes, cmd2 should start (write happens after listeners are attached).
		expect(writes).toHaveLength(2);
		expect(writes[1]).toBe("cmd2\r");

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
			// Enter key
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

	it("typeAndSnapshot() should return snapshot (default: drain)", async () => {
		const backend = new MockBackend();
		backend.write.mockImplementation((data: string) => {
			backend.emitData(data);
		});

		const conch = await Conch.launch({ backend, timeoutMs: 1000 });

		const result = await conch.typeAndSnapshot("HELLO", { snapshot: "viewport" });

		expect(result.meta.action).toBe("type");
		expect(result.meta.waited).toBe("drain");
		expect(result.snapshot.text).toContain("HELLO");

		conch.dispose();
	});

	describe("Locator / Assertion Shortcuts", () => {
		it("screenText() should return current snapshot text", async () => {
			const backend = new MockBackend();
			backend.write.mockImplementation((data) => backend.emitData(data));

			const conch = await Conch.launch({ backend });
			conch.type("ABC");
			await conch.drain(); // Wait for xterm to process

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

			// MockBackend sends raw chars, which xterm puts at (0,0)
			const cropped = conch.cropText({ x: 0, y: 0, width: 3, height: 1 });
			expect(cropped).toBe("123");

			conch.dispose();
		});
	});
});

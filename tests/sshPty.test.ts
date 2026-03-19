import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// --- ssh2 module mock ---

type FakeChannel = PassThrough & {
	close: ReturnType<typeof vi.fn>;
	setWindow: ReturnType<typeof vi.fn>;
};

const ssh2Mocks = vi.hoisted(() => {
	// Must be a regular function — SshPty uses `new Client()`.
	const ClientMock = vi.fn(function ClientMock() {});
	return { ClientMock };
});

vi.mock("ssh2", () => ({
	Client: ssh2Mocks.ClientMock,
}));

// Import AFTER mocking ssh2.
import { SshPty } from "../src/backend/SshPty";

function createFakeChannel(): FakeChannel {
	const stream = new PassThrough() as FakeChannel;
	stream.close = vi.fn();
	stream.setWindow = vi.fn();
	return stream;
}

function setupClient(overrides?: {
	shellError?: Error;
	connectError?: Error;
}) {
	const stream = createFakeChannel();

	ssh2Mocks.ClientMock.mockClear();
	ssh2Mocks.ClientMock.mockImplementation(function (this: EventEmitter) {
		// Mix in EventEmitter so on/once/emit/removeListener work natively
		EventEmitter.call(this);
		Object.setPrototypeOf(this, EventEmitter.prototype);

		const self = this;

		(this as any).connect = vi.fn().mockImplementation(() => {
			if (overrides?.connectError) {
				process.nextTick(() => self.emit("error", overrides.connectError));
			} else {
				process.nextTick(() => self.emit("ready"));
			}
		});

		(this as any).shell = vi.fn().mockImplementation(
			(_opts: unknown, cb: (err: Error | null, ch?: unknown) => void) => {
				if (overrides?.shellError) {
					cb(overrides.shellError);
				} else {
					cb(null, stream);
				}
			},
		);

		(this as any).end = vi.fn();
	});

	return { stream };
}

/** Helper to get the mock client instance after spawn. */
function getLastClient(): any {
	return ssh2Mocks.ClientMock.mock.instances[
		ssh2Mocks.ClientMock.mock.instances.length - 1
	];
}

describe("SshPty", () => {
	it("should decode UTF-8 safely across chunk boundaries", async () => {
		const { stream } = setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		const out: string[] = [];
		pty.onData((d) => out.push(d));

		await pty.spawn();

		// 'あ' (U+3042) UTF-8 bytes: E3 81 82
		stream.write(Buffer.from([0xe3, 0x81]));
		stream.write(Buffer.from([0x82]));

		expect(out.join("")).toBe("あ");

		await pty.disposeAsync?.();
	});

	it("should rollback when shell() fails after connect", async () => {
		setupClient({ shellError: new Error("shell failed") });
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		await expect(pty.spawn()).rejects.toThrow("shell failed");

		const client = getLastClient();
		expect(client.end).toHaveBeenCalledTimes(1);
	});

	it("should rollback when connect fails", async () => {
		setupClient({ connectError: new Error("auth failed") });
		const pty = new SshPty({ host: "example.com", username: "user", password: "wrong" });

		await expect(pty.spawn()).rejects.toThrow("auth failed");

		const client = getLastClient();
		expect(client.end).toHaveBeenCalledTimes(1);
	});

	it("should emit onError and onExit(-1) once on client error after spawn", async () => {
		setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		const errors: Error[] = [];
		const exits: number[] = [];
		pty.onError?.((e) => errors.push(e));
		pty.onExit((code) => exits.push(code));

		await pty.spawn();

		const client = getLastClient();
		client.emit("error", new Error("connection lost"));
		client.emit("error", new Error("second error"));

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("connection lost");
		expect(exits).toEqual([-1]);

		await pty.disposeAsync?.();
	});

	it("should emit exit code from stream exit event", async () => {
		const { stream } = setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		const exits: { code: number; signal?: number }[] = [];
		pty.onExit((code, signal) => exits.push({ code, signal }));

		await pty.spawn();

		stream.emit("exit", 42, null);

		expect(exits).toEqual([{ code: 42, signal: undefined }]);

		await pty.disposeAsync?.();
	});

	it("should map signal string to number on exit", async () => {
		const { stream } = setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		const exits: { code: number; signal?: number }[] = [];
		pty.onExit((code, signal) => exits.push({ code, signal }));

		await pty.spawn();

		// Killed by SIGTERM (15) → exit code = 128 + 15 = 143
		stream.emit("exit", null, "TERM");

		expect(exits).toEqual([{ code: 143, signal: 15 }]);

		await pty.disposeAsync?.();
	});

	it("should handle close without exit (graceful disconnect)", async () => {
		const { stream } = setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		const exits: number[] = [];
		pty.onExit((code) => exits.push(code));

		await pty.spawn();

		stream.emit("close");

		expect(exits).toEqual([0]);

		await pty.disposeAsync?.();
	});

	it("disposeAsync should be idempotent and return the same promise", async () => {
		setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });
		await pty.spawn();

		const p1 = pty.disposeAsync?.();
		const p2 = pty.disposeAsync?.();
		expect(p1).toBe(p2);

		await p1;

		const client = getLastClient();
		expect(client.end).toHaveBeenCalledTimes(1);
	});

	it("disposeAsync should clear listeners before teardown", async () => {
		const { stream } = setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		const data: string[] = [];
		pty.onData((d) => data.push(d));

		await pty.spawn();

		const disposeP = pty.disposeAsync?.();
		stream.write(Buffer.from("late data"));

		await disposeP;

		expect(data.filter((d) => d.includes("late"))).toHaveLength(0);
	});

	it("resize should call setWindow with correct argument order", async () => {
		const { stream } = setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		await pty.spawn();

		pty.resize(120, 40);

		// setWindow(rows, cols, height, width) — rows first!
		expect(stream.setWindow).toHaveBeenCalledWith(40, 120, 0, 0);

		await pty.disposeAsync?.();
	});

	it("should throw if spawn is called after dispose", async () => {
		setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });
		pty.dispose();

		await expect(pty.spawn()).rejects.toThrow("disposed");
	});

	it("should throw if spawn is called twice", async () => {
		setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });
		await pty.spawn();

		await expect(pty.spawn()).rejects.toThrow("already spawned");

		await pty.disposeAsync?.();
	});

	it("processName should return user@host", () => {
		const pty = new SshPty({ host: "example.com", username: "testuser", password: "pass" });
		expect(pty.processName).toBe("testuser@example.com");
	});

	it("id should be unique across instances", () => {
		setupClient();
		const a = new SshPty({ host: "a.com", username: "u", password: "p" });
		const b = new SshPty({ host: "b.com", username: "u", password: "p" });
		expect(a.id).not.toBe(b.id);
		expect(a.id).toContain("ssh-a.com");
		expect(b.id).toContain("ssh-b.com");
	});

	it("write before spawn should warn, not crash", () => {
		setupClient();
		const pty = new SshPty({ host: "example.com", username: "user", password: "pass" });

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		pty.write("test");
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("write called before spawn"));
		warnSpy.mockRestore();
	});
});

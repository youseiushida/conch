import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

type FakeContainer = {
	id: string;
	start: ReturnType<typeof vi.fn>;
	attach: ReturnType<typeof vi.fn>;
	wait: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
};

// --- dockerode module mock ---

let fakeContainer: FakeContainer;

const dockerodeMocks = vi.hoisted(() => {
	const createContainerMock = vi.fn();
	// Dockerode default export is a constructor (used with `new Dockerode(...)`),
	// so the mock implementation must be a `function`/`class` (not an arrow).
	const DockerodeMock = vi.fn(function DockerodeMock() {
		return {
			createContainer: createContainerMock,
		};
	});

	return { createContainerMock, DockerodeMock };
});

vi.mock("dockerode", () => ({
	default: dockerodeMocks.DockerodeMock,
}));

// Import AFTER mocking dockerode.
import { DockerPty } from "../src/backend/DockerPty";

function setupContainer(overrides?: Partial<FakeContainer>) {
	const stream = new PassThrough();

	fakeContainer = {
		id: "container-123",
		start: vi.fn().mockResolvedValue(undefined),
		attach: vi.fn().mockResolvedValue(stream),
		wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
		resize: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};

	dockerodeMocks.createContainerMock.mockReset();
	dockerodeMocks.createContainerMock.mockResolvedValue(fakeContainer);

	dockerodeMocks.DockerodeMock.mockClear();

	return { stream };
}

describe("DockerPty", () => {
	it("decodes UTF-8 safely across chunk boundaries", async () => {
		const { stream } = setupContainer();
		const pty = new DockerPty({ image: "alpine:latest" });

		const out: string[] = [];
		pty.onData((d) => out.push(d));

		await pty.spawn();

		// 'あ' (U+3042) UTF-8 bytes: E3 81 82
		stream.write(Buffer.from([0xe3, 0x81]));
		stream.write(Buffer.from([0x82]));

		expect(out.join("")).toBe("あ");

		await pty.disposeAsync?.();
	});

	it("rolls back (stop/remove) when spawn fails after container creation", async () => {
		setupContainer({
			attach: vi.fn().mockRejectedValue(new Error("attach failed")),
		});

		const pty = new DockerPty({ image: "alpine:latest" });

		await expect(pty.spawn()).rejects.toThrow("attach failed");

		expect(fakeContainer.stop).toHaveBeenCalledTimes(1);
		expect(fakeContainer.remove).toHaveBeenCalledTimes(1);
	});

	it("emits onError and onExit(-1) once on attach stream error", async () => {
		const { stream } = setupContainer({
			// Keep wait pending so the only termination signal is the stream error.
			wait: vi.fn().mockReturnValue(new Promise(() => {})),
		});
		const pty = new DockerPty({ image: "alpine:latest" });

		const errors: Error[] = [];
		const exits: number[] = [];
		pty.onError?.((e) => errors.push(e));
		pty.onExit((code) => exits.push(code));

		await pty.spawn();

		stream.emit("error", new Error("boom"));
		stream.emit("error", new Error("boom2"));

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("boom");
		expect(exits).toEqual([-1]);

		await pty.disposeAsync?.();
	});

	it("disposeAsync is idempotent and returns the same promise", async () => {
		const { stream } = setupContainer({
			wait: vi.fn().mockReturnValue(new Promise(() => {})),
		});
		const pty = new DockerPty({ image: "alpine:latest" });
		await pty.spawn();

		// Keep the stream alive.
		stream.write(Buffer.from("hi"));

		const p1 = pty.disposeAsync?.();
		const p2 = pty.disposeAsync?.();
		expect(p1).toBe(p2);

		await p1;

		expect(fakeContainer.stop).toHaveBeenCalledTimes(1);
		expect(fakeContainer.remove).toHaveBeenCalledTimes(1);
	});

	it("disposeAsync clears listeners before teardown so no callbacks fire during cleanup", async () => {
		const { stream } = setupContainer({
			wait: vi.fn().mockReturnValue(new Promise(() => {})),
		});
		const pty = new DockerPty({ image: "alpine:latest" });

		const data: string[] = [];
		pty.onData((d) => data.push(d));

		await pty.spawn();

		// Start dispose, then push data into the stream.
		const disposeP = pty.disposeAsync?.();
		stream.write(Buffer.from("late data"));

		await disposeP;

		// The listener should NOT have received the late data.
		expect(data.filter((d) => d.includes("late"))).toHaveLength(0);
	});

	it("serializes resize calls to prevent race conditions", async () => {
		const resizeOrder: string[] = [];
		setupContainer({
			wait: vi.fn().mockReturnValue(new Promise(() => {})),
			resize: vi.fn().mockImplementation(({ w }: { w: number }) => {
				resizeOrder.push(`start-${w}`);
				return new Promise<void>((resolve) =>
					setTimeout(() => {
						resizeOrder.push(`end-${w}`);
						resolve();
					}, 10),
				);
			}),
		});
		const pty = new DockerPty({ image: "alpine:latest", cols: 80, rows: 24 });
		await pty.spawn();

		// Fire two resizes without waiting.
		pty.resize(100, 30);
		pty.resize(120, 40);

		// Wait for chain to settle.
		await new Promise((r) => setTimeout(r, 100));

		// First resize must complete before second starts.
		expect(resizeOrder).toEqual([
			"start-80",   // initial from spawn
			"end-80",
			"start-100",
			"end-100",
			"start-120",
			"end-120",
		]);

		await pty.disposeAsync?.();
	});
});


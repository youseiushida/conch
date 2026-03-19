import { createBackend } from "./backendFactory";
import { ConchSession } from "./session";
import type {
	ActionResult,
	ConchActionOptions,
	ConchLaunchOptions,
	ConchWait,
	IDisposable,
	IShellIntegrationEvent,
	ISnapshot,
	ITerminalBackend,
	RunOptions,
	RunResult,
	SnapshotMode,
	SnapshotOptions,
	SnapshotRange,
} from "./types";
import { ShellIntegrationType } from "./types";
import {
	cropText,
	findText,
	type Rect,
	type TextMatch,
	waitForChange,
	waitForSilence,
	waitForStable,
	waitForText,
} from "./utils";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Conch implements IDisposable {
	public readonly session: ConchSession;
	public readonly backend: ITerminalBackend;
	private readonly defaultTimeoutMs: number;
	private _disposed = false;
	/**
	 * Serialize high-level actions per Conch instance.
	 *
	 * High-level methods (run / pressAndSnapshot / ...) attach listeners and/or wait on
	 * shared session state. Concurrent calls can interleave and cause mixed results.
	 */
	private actionQueue: Promise<void> = Promise.resolve();

	private constructor(
		session: ConchSession,
		backend: ITerminalBackend,
		options: { timeoutMs?: number },
	) {
		this.session = session;
		this.backend = backend;
		this.defaultTimeoutMs = options.timeoutMs ?? 10000;
	}

	private throwIfDisposed(): void {
		if (this._disposed) {
			throw new Error("Conch instance is disposed");
		}
	}

	/**
	 * Creates and launches a new Conch instance.
	 */
	public static async launch(options: ConchLaunchOptions): Promise<Conch> {
		const backend = await createBackend(options.backend, {
			cols: options.cols,
			rows: options.rows,
		});

		const session = new ConchSession(backend, {
			cols: options.cols,
			rows: options.rows,
		});

		// Spawn AFTER wiring session listeners (to avoid losing early output).
		await backend.spawn();

		// Wait for the process to stabilize a bit (important for slow backends like WSL)
		await waitForStable(session, 100, { timeout: 2000 });

		const conch = new Conch(session, backend, {
			timeoutMs: options.timeoutMs ?? options.timeout,
		});

		if (options.autoDispose) {
			const cleanup = () => conch.dispose();
			process.on('exit', cleanup);
			process.on('SIGINT', () => { cleanup(); process.exit(); });
			process.on('SIGTERM', () => { cleanup(); process.exit(); });
		};			

		if (options.shellIntegration?.enable) {
			const ok = await session.enableShellIntegration(
				options.shellIntegration.shell,
			);
			if (options.shellIntegration.strict && !ok) {
				throw new Error("Shell integration enable failed");
			}
		}

		return conch;
	}

	public dispose(): void {
		this._disposed = true;
		this.session.dispose();
	}

	// --- Delegation Methods ---

	public write(data: string): void {
		this.throwIfDisposed();
		this.session.write(data);
	}

	public execute(command: string): void {
		this.throwIfDisposed();
		this.session.execute(command);
	}

	public press(key: string): void {
		this.throwIfDisposed();
		this.session.press(key);
	}

	public type(text: string): void {
		this.throwIfDisposed();
		this.session.type(text);
	}

	public resize(cols: number, rows: number): void {
		this.throwIfDisposed();
		this.session.resize(cols, rows);
	}

	public getSnapshot(options?: SnapshotOptions): ISnapshot {
		this.throwIfDisposed();
		return this.session.getSnapshot(options);
	}

	public onOutput(listener: (data: string) => void): IDisposable {
		this.throwIfDisposed();
		return this.session.onOutput(listener);
	}

	public onExit(
		listener: (code: number, signal?: number) => void,
	): IDisposable {
		this.throwIfDisposed();
		return this.session.onExit(listener);
	}

	public onShellIntegration(
		listener: (event: IShellIntegrationEvent) => void,
	): IDisposable {
		this.throwIfDisposed();
		return this.session.onShellIntegration(listener);
	}

	public drain(): Promise<void> {
		this.throwIfDisposed();
		return this.session.drain();
	}

	// --- Wait Methods (Normalized) ---

	public waitForText(
		pattern: string | RegExp,
		options?: { timeoutMs?: number; intervalMs?: number },
	): Promise<void> {
		this.throwIfDisposed();
		return waitForText(this.session, pattern, {
			timeout: options?.timeoutMs ?? this.defaultTimeoutMs,
			interval: options?.intervalMs,
		});
	}

	public waitForSilence(options?: {
		durationMs?: number;
		timeoutMs?: number;
	}): Promise<void> {
		this.throwIfDisposed();
		return waitForSilence(
			this.session,
			options?.durationMs, // default handled in utils
			options?.timeoutMs ?? this.defaultTimeoutMs,
		);
	}

	public waitForChange(options?: {
		timeoutMs?: number;
		intervalMs?: number;
	}): Promise<void> {
		this.throwIfDisposed();
		return waitForChange(this.session, {
			timeout: options?.timeoutMs ?? this.defaultTimeoutMs,
			interval: options?.intervalMs,
		});
	}

	public waitForStable(options?: {
		durationMs?: number;
		timeoutMs?: number;
		intervalMs?: number;
	}): Promise<void> {
		this.throwIfDisposed();
		return waitForStable(this.session, options?.durationMs, {
			timeout: options?.timeoutMs ?? this.defaultTimeoutMs,
			interval: options?.intervalMs,
		});
	}

	// --- High-level API ---

	private static stripAnsiAndOsc(input: string): string {
		// OSC: ESC ] ... BEL  OR  ESC ] ... ST (ESC \)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: We intentionally match ESC/BEL to strip OSC sequences.
		const withoutOsc = input.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
		// CSI: ESC [ ... command
		// biome-ignore lint/suspicious/noControlCharactersInRegex: We intentionally match ESC to strip CSI sequences.
		const withoutCsi = withoutOsc.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		// Other 2-char escapes like ESC ( or ESC )
		// biome-ignore lint/suspicious/noControlCharactersInRegex: We intentionally match ESC to strip remaining ANSI escapes.
		return withoutCsi.replace(/\x1b[@-Z\\-_]/g, "");
	}

	/**
	 * Extract clean command output from raw captured data.
	 *
	 * With full OSC 133 integration (A/B/C/D), the raw stream looks like:
	 *   ...[C marker][actual output][D marker]...
	 *
	 * C (CommandExecuted) fires just before the command runs (via DEBUG trap).
	 * D (CommandFinished) fires at the next prompt (via PROMPT_COMMAND).
	 * Content between the last C and last D is the command output — deterministic,
	 * no heuristics needed.
	 *
	 * Falls back to D-only extraction (command echo heuristic) when C is absent,
	 * and to full ANSI stripping when no markers are present at all.
	 */
	private static extractCommandOutput(
		raw: string,
		shellIntegrationUsed: boolean,
		command?: string,
	): string {
		if (shellIntegrationUsed) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Matching OSC 133 C marker bytes.
			const cRe = /\x1b\]133;C(?:\x07|\x1b\\)/g;
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Matching OSC 133 D marker bytes.
			const dRe = /\x1b\]133;D;?[^\x07\x1b]*(?:\x07|\x1b\\)/g;

			let lastCEnd = -1;
			let lastDStart = -1;
			let m: RegExpExecArray | null;

			// biome-ignore lint/suspicious/noAssignInExpressions: Standard RegExp loop pattern.
			while ((m = cRe.exec(raw)) !== null) {
				lastCEnd = m.index + m[0].length;
			}
			// biome-ignore lint/suspicious/noAssignInExpressions: Standard RegExp loop pattern.
			while ((m = dRe.exec(raw)) !== null) {
				lastDStart = m.index;
			}

			// Primary path: C-D boundary extraction (deterministic).
			if (lastCEnd >= 0 && lastDStart >= 0 && lastCEnd <= lastDStart) {
				return Conch.stripAnsiAndOsc(raw.slice(lastCEnd, lastDStart));
			}

			// Legacy fallback: D-only extraction (no C marker).
			// Uses command echo heuristic to strip the first line.
			if (lastDStart >= 0) {
				const stripped = Conch.stripAnsiAndOsc(raw.slice(0, lastDStart));
				if (command) {
					const cmdIdx = stripped.lastIndexOf(command);
					if (cmdIdx >= 0) {
						const afterCmd = stripped.slice(cmdIdx + command.length);
						const nlIdx = afterCmd.indexOf("\n");
						return nlIdx >= 0 ? afterCmd.slice(nlIdx + 1) : "";
					}
				}
				const firstNl = stripped.indexOf("\n");
				return firstNl >= 0 ? stripped.slice(firstNl + 1) : "";
			}
		}

		// No markers: strip ANSI/OSC and return as-is.
		return Conch.stripAnsiAndOsc(raw);
	}

	private async enqueueAction<T>(fn: () => Promise<T>): Promise<T> {
		let release: (() => void) | undefined;
		const prev = this.actionQueue;
		this.actionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});

		await prev;
		try {
			return await fn();
		} finally {
			release?.();
		}
	}

	private async bestEffortDrain(budgetMs: number): Promise<void> {
		if (budgetMs <= 0) return;
		let timeoutId: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				this.session.drain(),
				new Promise<void>((resolve) => {
					timeoutId = setTimeout(resolve, budgetMs);
				}),
			]);
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
		}
	}

	private resolveSnapshotRange(
		options?: { snapshot?: SnapshotRange } | { snapshot?: SnapshotMode },
	): SnapshotRange {
		const mode = options?.snapshot;
		if (!mode || mode === "none") return "viewport";
		return mode;
	}

	private resolveWait(
		options: ConchActionOptions | undefined,
		defaultWait: ConchWait,
	): ConchWait {
		return options?.wait ?? defaultWait;
	}

	private async waitForChangeFrom(
		baselineText: string,
		range: SnapshotRange,
		options: { timeoutMs: number; intervalMs: number },
	): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < options.timeoutMs) {
			await this.bestEffortDrain(Math.min(options.intervalMs, 25));
			const current = this.session.getSnapshot({ range }).text;
			if (current !== baselineText) return;
			await sleep(options.intervalMs);
		}
		throw new Error(`waitForChangeFrom timed out after ${options.timeoutMs}ms`);
	}

	private async runActionAndSnapshot(
		action: "press" | "type" | "execute",
		act: () => void,
		options: ConchActionOptions | undefined,
		defaultWait: ConchWait,
	): Promise<ActionResult> {
		return this.enqueueAction(async () => {
			const snapshotRange = this.resolveSnapshotRange(options);
			const wait = this.resolveWait(options, defaultWait);

			// For change-waits, capture baseline BEFORE action (after best-effort drain).
			let baselineText: string | undefined;
			if (wait.kind === "change") {
				await this.bestEffortDrain(25);
				baselineText = this.session.getSnapshot({ range: snapshotRange }).text;
			}

			const start = Date.now();
			act();

			switch (wait.kind) {
				case "none":
					break;
				case "drain": {
					const budgetMs = Math.min(wait.budgetMs ?? 50, 5000);
					await this.bestEffortDrain(budgetMs);
					break;
				}
				case "change": {
					const timeoutMs = wait.timeoutMs ?? this.defaultTimeoutMs;
					const intervalMs = wait.intervalMs ?? 50;
					await this.waitForChangeFrom(baselineText ?? "", snapshotRange, {
						timeoutMs,
						intervalMs,
					});
					break;
				}
				case "stable": {
					await waitForStable(this.session, wait.durationMs, {
						timeout: wait.timeoutMs ?? this.defaultTimeoutMs,
						interval: wait.intervalMs,
					});
					break;
				}
				case "silence": {
					await waitForSilence(
						this.session,
						wait.durationMs,
						wait.timeoutMs ?? this.defaultTimeoutMs,
					);
					break;
				}
				case "text": {
					await waitForText(this.session, wait.pattern, {
						timeout: wait.timeoutMs ?? this.defaultTimeoutMs,
						interval: wait.intervalMs,
					});
					break;
				}
				default: {
					// Exhaustiveness guard
					const _never: never = wait;
					throw new Error(`Unsupported wait kind: ${String(_never)}`);
				}
			}

			// Final snapshot (best-effort drain).
			await this.bestEffortDrain(25);
			const snapshot = this.session.getSnapshot({ range: snapshotRange });
			const durationMs = Date.now() - start;

			return {
				snapshot,
				durationMs,
				meta: {
					action,
					waited: wait.kind,
					snapshotRange,
				},
			};
		});
	}

	/**
	 * High-level action: press + (optional wait) + snapshot.
	 *
	 * Default: wait for screen change (TUI-friendly).
	 */
	public pressAndSnapshot(
		key: string,
		options?: ConchActionOptions,
	): Promise<ActionResult> {
		this.throwIfDisposed();
		return this.runActionAndSnapshot(
			"press",
			() => this.session.press(key),
			options,
			{ kind: "change" },
		);
	}

	/**
	 * High-level action: type + (optional wait) + snapshot.
	 *
	 * Default: wait for screen change (ensures PTY echo is reflected in snapshot).
	 */
	public typeAndSnapshot(
		text: string,
		options?: ConchActionOptions,
	): Promise<ActionResult> {
		this.throwIfDisposed();
		return this.runActionAndSnapshot(
			"type",
			() => this.session.type(text),
			options,
			{ kind: "change" },
		);
	}

	/**
	 * High-level action: execute + (optional wait) + snapshot.
	 *
	 * Default: best-effort drain (shows immediate echo / prompt changes).
	 */
	public executeAndSnapshot(
		command: string,
		options?: ConchActionOptions,
	): Promise<ActionResult> {
		this.throwIfDisposed();
		return this.runActionAndSnapshot(
			"execute",
			() => this.session.execute(command),
			options,
			{ kind: "drain" },
		);
	}

	public async run(
		command: string,
		options: RunOptions = {},
	): Promise<RunResult> {
		this.throwIfDisposed();
		return this.enqueueAction(() => this.runInternal(command, options));
	}

	private async runInternal(
		command: string,
		options: RunOptions,
	): Promise<RunResult> {
		const timeoutMs =
			options.timeoutMs ?? options.timeout ?? this.defaultTimeoutMs;
		const strict = options.strict ?? false;

		const start = Date.now();
		let raw = "";
		let exitCode: number | undefined;
		let method: "osc133" | "fallback" = "fallback";
		let shellIntegrationUsed = false;

		let done = false;
		let resolveDone: (() => void) | undefined;
		let rejectDone: ((e: Error) => void) | undefined;

		const snapshotMode: SnapshotMode = options.snapshot ?? "viewport";

		const donePromise = new Promise<void>((resolve, reject) => {
			resolveDone = resolve;
			rejectDone = reject;
		});

		const backendErrorMode = options.backendError ?? "reject";
		const backendErrorDisp = this.backend.onError?.((err) => {
			if (done) return;
			if (backendErrorMode === "ignore") return;
			done = true;
			rejectDone?.(err);
		});

		const outputDisp = this.session.onOutput((data) => {
			if (!done) raw += data;
		});

		// C-gate: ignore D events that arrive before either (a) our C marker or
		// (b) we have issued the command. Residual D events from prior commands
		// arrive before our execute() call. Our command's D arrives after.
		//
		// When C is available (bash with DEBUG trap): C fires → sawC=true → next D accepted.
		// When C is absent (pwsh, legacy): commandIssued=true → next D accepted.
		// Residual D's arrive before commandIssued is set → skipped.
		let sawC = false;
		let commandIssued = false;

		const oscDisp = this.session.onShellIntegration((event) => {
			if (done) return;
			if (event.type === ShellIntegrationType.CommandExecuted) {
				sawC = true;
				return;
			}
			if (event.type !== ShellIntegrationType.CommandFinished) return;
			// Skip residual D's: those that arrive before both C and execute().
			if (!sawC && !commandIssued) return;

			shellIntegrationUsed = true;
			method = "osc133";
			const maybeCode = Number(event.params[0]);
			exitCode = Number.isFinite(maybeCode) ? maybeCode : undefined;
			done = true;
			resolveDone?.();
		});

		// Issue command AFTER hooks are attached.
		this.session.execute(command);
		commandIssued = true;

		const timeoutId = setTimeout(() => {
			if (done) return;
			done = true;
			if (strict) {
				rejectDone?.(new Error(`run() timed out after ${timeoutMs}ms`));
			} else {
				resolveDone?.();
			}
		}, timeoutMs);

		try {
			await donePromise;
		} finally {
			clearTimeout(timeoutId);
			outputDisp.dispose();
			oscDisp.dispose();
			backendErrorDisp?.dispose();
		}

		let snapshot: ISnapshot | undefined;
		let snapshotAfter: ISnapshot | undefined;
		if (snapshotMode !== "none") {
			// Snapshot-after: best-effort drain so the screen is up-to-date.
			const elapsedMs = Date.now() - start;
			const remainingMs = Math.max(0, timeoutMs - elapsedMs);
			const drainBudgetMs = Math.min(remainingMs, 250);
			await this.bestEffortDrain(drainBudgetMs);

			const range = snapshotMode;
			snapshotAfter = this.session.getSnapshot({ range });
			snapshot = snapshotAfter; // primary snapshot alias
		}

		const durationMs = Date.now() - start;
		const outputText = Conch.extractCommandOutput(raw, shellIntegrationUsed, command);

		return {
			exitCode,
			outputText,
			snapshot,
			snapshotAfter,
			durationMs,
			meta: {
				action: "run",
				waited: method,
				snapshotMode,
				method,
				shellIntegrationUsed,
			},
			// Keep raw available for future capture refinement.
			outputRaw: raw,
		};
	}

	// --- Locator / Assertion Shortcuts ---

	/**
	 * Shortcut for getSnapshot().text
	 * Returns the current text content of the viewport (or specified range).
	 */
	public screenText(options?: SnapshotOptions): string {
		this.throwIfDisposed();
		return this.getSnapshot(options).text;
	}

	/**
	 * Check if the specified pattern exists in the current screen snapshot.
	 */
	public hasText(pattern: string | RegExp, options?: SnapshotOptions): boolean {
		this.throwIfDisposed();
		const text = this.screenText(options);
		if (typeof pattern === "string") {
			return text.includes(pattern);
		}
		// Reset RegExp state for safety
		if (pattern.global || pattern.sticky) {
			pattern.lastIndex = 0;
		}
		return pattern.test(text);
	}

	/**
	 * Find all occurrences of the pattern in the current snapshot.
	 */
	public findText(
		pattern: string | RegExp,
		options?: SnapshotOptions,
	): TextMatch[] {
		this.throwIfDisposed();
		const snapshot = this.getSnapshot(options);
		return findText(snapshot, pattern);
	}

	/**
	 * Extract text from a specific rectangular region of the screen.
	 */
	public cropText(rect: Rect, options?: SnapshotOptions): string {
		this.throwIfDisposed();
		const snapshot = this.getSnapshot(options);
		return cropText(snapshot, rect);
	}
}

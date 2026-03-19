import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { IDisposable, ITerminalBackend } from "../types";
import { StringDecoder } from "node:string_decoder";

export interface SshPtyOptions {
  host: string;
  port?: number;
  username: string;

  // Authentication (at least one required)
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  agent?: string;

  // PTY
  cols?: number;
  rows?: number;
  term?: string;

  // Connection tuning
  readyTimeout?: number;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;

  // Host key verification (default: accept all for automation)
  hostVerifier?: (key: Buffer) => boolean;

  // Escape hatch: raw ssh2 ConnectConfig overrides (applied last)
  connectOptions?: Partial<ConnectConfig>;
}

/** Map common POSIX signal names to numbers. */
const SIGNAL_MAP: Record<string, number> = {
  HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6,
  FPE: 8, KILL: 9, SEGV: 11, PIPE: 13, ALRM: 14, TERM: 15,
};

export class SshPty implements ITerminalBackend {
  private static _nextId = 0;

  private client: Client | undefined;
  private stream: ClientChannel | undefined;
  private _disposed = false;
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private _errorListeners: ((err: Error) => void)[] = [];

  // Bound handlers for targeted removal in disposeAsync.
  private _streamDataHandler: ((chunk: Buffer) => void) | undefined;
  private _streamExitHandler: ((code: number | null, signal?: string | null) => void) | undefined;
  private _streamCloseHandler: (() => void) | undefined;
  private _clientErrorHandler: ((err: Error) => void) | undefined;
  private _clientCloseHandler: (() => void) | undefined;

  // Ensure exit/error are emitted at most once.
  private _ended = false;

  // Idempotent async disposal.
  private disposePromise: Promise<void> | undefined;

  private readonly _instanceId: string;

  constructor(private options: SshPtyOptions) {
    this._instanceId = `ssh-${options.host}:${options.port ?? 22}-${SshPty._nextId++}`;
  }

  get id(): string {
    return this._instanceId;
  }

  get processName(): string {
    return `${this.options.username}@${this.options.host}`;
  }

  async spawn(): Promise<void> {
    if (this._disposed) throw new Error("SshPty is disposed");
    if (this.client) throw new Error("SshPty is already spawned");

    let client: Client | undefined;
    let stream: ClientChannel | undefined;

    try {
      client = new Client();

      // Connect (Promise wrapper around event-based API)
      await new Promise<void>((resolve, reject) => {
        const connectConfig: ConnectConfig = {
          host: this.options.host,
          port: this.options.port ?? 22,
          username: this.options.username,
          password: this.options.password,
          privateKey: this.options.privateKey,
          passphrase: this.options.passphrase,
          agent: this.options.agent,
          readyTimeout: this.options.readyTimeout ?? 20000,
          keepaliveInterval: this.options.keepaliveInterval ?? 10000,
          keepaliveCountMax: this.options.keepaliveCountMax ?? 3,
          // Default: accept all host keys (automation use case).
          // Users can override via hostVerifier option.
          hostVerifier: this.options.hostVerifier ?? (() => true),
          ...this.options.connectOptions,
        };

        client!.once("ready", () => resolve());
        client!.once("error", (err: Error) => reject(err));
        client!.connect(connectConfig);
      });

      this.client = client;

      // Open interactive shell with PTY
      stream = await new Promise<ClientChannel>((resolve, reject) => {
        client!.shell(
          {
            term: this.options.term ?? "xterm-256color",
            cols: this.options.cols ?? 80,
            rows: this.options.rows ?? 24,
          },
          (err, ch) => {
            if (err) reject(err);
            else resolve(ch);
          },
        );
      });

      this.stream = stream;

      // Wire stream events
      const decoder = new StringDecoder("utf8");
      this._streamDataHandler = (chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (!text) return;
        this._dataListeners.forEach((l) => l(text));
      };
      stream.on("data", this._streamDataHandler);

      this._streamExitHandler = (
        code: number | null,
        signal?: string | null,
      ) => {
        const signalNum = signal
          ? SIGNAL_MAP[signal.toUpperCase()]
          : undefined;
        // Unix convention: exit code = 128 + signal when killed by signal
        const exitCode =
          code ?? (signalNum ? 128 + signalNum : 0);
        this.emitExit(exitCode, signalNum);
      };
      stream.on("exit", this._streamExitHandler);

      this._streamCloseHandler = () => {
        // Channel closed without explicit exit — treat as graceful exit.
        if (!this._ended) this.emitExit(0);
      };
      stream.on("close", this._streamCloseHandler);

      // Wire client-level events (connection drops, network errors)
      this._clientErrorHandler = (err: Error) => {
        this.emitError(err);
      };
      client.on("error", this._clientErrorHandler);

      this._clientCloseHandler = () => {
        // Server disconnected gracefully (no preceding error).
        if (!this._ended) this.emitExit(0);
      };
      client.on("close", this._clientCloseHandler);
    } catch (err) {
      // Rollback on spawn failure
      const error =
        err instanceof Error ? err : new Error(String(err ?? "ssh spawn error"));

      if (stream) {
        try { stream.close(); } catch (e) {
          console.debug("[SshPty] rollback stream.close() failed:", e);
        }
      }

      if (client) {
        try { client.end(); } catch (e) {
          console.debug("[SshPty] rollback client.end() failed:", e);
        }
      }

      this.stream = undefined;
      this.client = undefined;

      throw error;
    }
  }

  write(data: string): void {
    if (!this.stream) {
      console.warn("[SshPty] write called before spawn");
      return;
    }
    try {
      this.stream.write(data);
    } catch (error) {
      console.warn("[SshPty] write failed:", error);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.stream) return;
    try {
      // ssh2 setWindow: (rows, cols, height, width) — note rows/cols order
      this.stream.setWindow(rows, cols, 0, 0);
    } catch (error) {
      console.warn("[SshPty] resize failed:", error);
    }
  }

  dispose(): void {
    void this.disposeAsync();
  }

  public disposeAsync(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this._disposed = true;
    this._ended = true;

    this.disposePromise = (async () => {
      const stream = this.stream;
      const client = this.client;

      // Clear listener arrays FIRST so no callbacks fire during teardown.
      this._dataListeners = [];
      this._exitListeners = [];
      this._errorListeners = [];

      // Remove specific stream handlers
      if (stream) {
        if (this._streamDataHandler) {
          try { stream.removeListener("data", this._streamDataHandler); } catch (e) {
            console.debug("[SshPty] removeListener(data) failed:", e);
          }
        }
        if (this._streamExitHandler) {
          try { stream.removeListener("exit", this._streamExitHandler); } catch (e) {
            console.debug("[SshPty] removeListener(exit) failed:", e);
          }
        }
        if (this._streamCloseHandler) {
          try { stream.removeListener("close", this._streamCloseHandler); } catch (e) {
            console.debug("[SshPty] removeListener(close) failed:", e);
          }
        }
        this._streamDataHandler = undefined;
        this._streamExitHandler = undefined;
        this._streamCloseHandler = undefined;
      }

      // Remove client-level handlers
      if (client) {
        if (this._clientErrorHandler) {
          try { client.removeListener("error", this._clientErrorHandler); } catch (e) {
            console.debug("[SshPty] removeListener(client error) failed:", e);
          }
        }
        if (this._clientCloseHandler) {
          try { client.removeListener("close", this._clientCloseHandler); } catch (e) {
            console.debug("[SshPty] removeListener(client close) failed:", e);
          }
        }
        this._clientErrorHandler = undefined;
        this._clientCloseHandler = undefined;
      }

      // Close stream then disconnect
      try { stream?.close(); } catch (e) {
        console.debug("[SshPty] stream.close() failed:", e);
      }
      this.stream = undefined;

      try { client?.end(); } catch (e) {
        console.debug("[SshPty] client.end() failed:", e);
      }
      this.client = undefined;
    })();

    return this.disposePromise;
  }

  onData(listener: (data: string) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._dataListeners.push(listener);
    return {
      dispose: () => {
        this._dataListeners = this._dataListeners.filter((l) => l !== listener);
      },
    };
  }

  onExit(listener: (code: number, signal?: number) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._exitListeners.push(listener);
    return {
      dispose: () => {
        this._exitListeners = this._exitListeners.filter((l) => l !== listener);
      },
    };
  }

  onError(listener: (err: Error) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._errorListeners.push(listener);
    return {
      dispose: () => {
        this._errorListeners = this._errorListeners.filter((l) => l !== listener);
      },
    };
  }

  private emitExit(code: number, signal?: number): void {
    if (this._ended) return;
    this._ended = true;
    if (this._disposed) return;
    this._exitListeners.forEach((l) => l(code, signal));
  }

  private emitError(err: Error): void {
    if (this._ended) return;
    this._errorListeners.forEach((l) => l(err));
    this.emitExit(-1);
  }
}

import Dockerode, { type Container } from "dockerode";
import type { IDisposable, ITerminalBackend } from "../types";
import { StringDecoder } from "node:string_decoder";

export interface DockerPtyOptions {
  image: string;
  cmd?: string[];
  workdir?: string;
  env?: Record<string, string>;
  name?: string;
  user?: string;
  autoRemove?: boolean;
  docker?: Dockerode.DockerOptions;
  cols?: number;
  rows?: number;
}

export class DockerPty implements ITerminalBackend {
  private static hasDestroy(
    stream: unknown,
  ): stream is { destroy: (error?: unknown) => unknown } {
    return typeof (stream as { destroy?: unknown } | null)?.destroy === "function";
  }

  private docker: Dockerode;
  private container: Container | undefined;
  private attachStream: NodeJS.ReadWriteStream | undefined;
  private _disposed = false;
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private _errorListeners: ((err: Error) => void)[] = [];

  // Bound stream handlers — stored for targeted removal in disposeAsync.
  private _streamDataHandler: ((chunk: Buffer) => void) | undefined;
  private _streamErrorHandler: ((err: unknown) => void) | undefined;

  // Ensure exit/error are emitted at most once.
  private _ended = false;

  // Idempotent async disposal.
  private disposePromise: Promise<void> | undefined;

  // Serialize resize calls to prevent race conditions (Docker resize is async).
  private _resizeChain: Promise<void> = Promise.resolve();

  constructor(private options: DockerPtyOptions) {
    const defaultSocket =
      process.platform === "win32"
        ? "//./pipe/docker_engine"
        : "/var/run/docker.sock";
    this.docker = new Dockerode(
      options.docker ?? { socketPath: defaultSocket },
    );
  }

  get id(): string | number {
    return this.container?.id ?? "";
  }

  get processName(): string {
    return this.options.image;
  }

  async spawn(): Promise<void> {
    if (this._disposed) throw new Error("DockerPty is disposed");
    if (this.container) throw new Error("DockerPty is already spawned");

    let container: Container | undefined;
    let stream: NodeJS.ReadWriteStream | undefined;

    try {
      container = await this.docker.createContainer({
        Image: this.options.image,
        Cmd: this.options.cmd ?? ["/bin/sh"],
        Tty: true,
        OpenStdin: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Env: this.options.env
          ? Object.entries(this.options.env).map(([k, v]) => `${k}=${v}`)
          : undefined,
        WorkingDir: this.options.workdir,
        name: this.options.name,
        StdinOnce: false,
        StopSignal: "SIGTERM",
        User: this.options.user,
        HostConfig: {
          AutoRemove: this.options.autoRemove ?? true,
        },
      });

      this.container = container;
      await container.start();

      stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        // hijack: true is required for stdin writes to reach the container.
        // Without it, the HTTP connection is half-duplex and write() silently no-ops.
        hijack: true,
      });
      this.attachStream = stream;

      const decoder = new StringDecoder("utf8");
      this._streamDataHandler = (chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (!text) return;
        this._dataListeners.forEach((l) => l(text));
      };
      this._streamErrorHandler = (err: unknown) => {
        const error =
          err instanceof Error ? err : new Error(String(err ?? "attach error"));
        this.emitError(error);
      };
      stream.on("data", this._streamDataHandler);
      stream.on("error", this._streamErrorHandler);

      container
        .wait()
        .then(({ StatusCode }) => {
          this.emitExit(StatusCode ?? 0);
        })
        .catch((err) => {
          const error =
            err instanceof Error ? err : new Error(String(err ?? "wait error"));
          this.emitError(error);
        });

      if (this.options.cols || this.options.rows) {
        this.resize(this.options.cols ?? 80, this.options.rows ?? 24);
      }
    } catch (err) {
      // Rollback on spawn failure: best-effort stop/remove so we don't leak containers.
      const error =
        err instanceof Error ? err : new Error(String(err ?? "spawn error"));

      // Close stream if it was created.
      if (stream) {
        try { stream.end(); } catch (e) {
          console.debug("[DockerPty] rollback stream.end() failed:", e);
        }
        if (DockerPty.hasDestroy(stream)) {
          try { stream.destroy(); } catch (e) {
            console.debug("[DockerPty] rollback stream.destroy() failed:", e);
          }
        }
      }

      if (container) {
        try { await container.stop({ t: 1 }); } catch (e) {
          console.debug("[DockerPty] rollback container.stop() failed:", e);
        }
        try { await container.remove({ force: true }); } catch (e) {
          console.debug("[DockerPty] rollback container.remove() failed:", e);
        }
      }

      // Reset references so callers can retry safely on the same instance if desired.
      this.attachStream = undefined;
      this.container = undefined;

      throw error;
    }
  }

  write(data: string): void {
    if (!this.attachStream) {
      console.warn("[DockerPty] write called before spawn");
      return;
    }
    try {
      this.attachStream.write(data);
    } catch (error) {
      console.warn("[DockerPty] write failed:", error);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.container) return;
    const container = this.container;
    this._resizeChain = this._resizeChain
      .then(() => container.resize({ w: cols, h: rows }))
      .catch((err) => console.warn("[DockerPty] resize failed:", err));
  }

  dispose(): void {
    // Keep synchronous dispose for signal handlers / process exit hooks.
    void this.disposeAsync();
  }

  public disposeAsync(): Promise<void> {
    // NOTE: this method must NOT be `async`, otherwise returning `this.disposePromise`
    // would wrap it in a new Promise each call, breaking idempotency by identity.
    if (this.disposePromise) return this.disposePromise;

    this._disposed = true;
    // Prevent any pending wait()/stream callbacks from emitting events.
    this._ended = true;

    this.disposePromise = (async () => {
      const stream = this.attachStream;
      const container = this.container;

      // Clear listener arrays FIRST so no callbacks fire during teardown.
      this._dataListeners = [];
      this._exitListeners = [];
      this._errorListeners = [];

      // Remove only our own handlers instead of removeAllListeners().
      if (stream) {
        const s = stream as NodeJS.ReadWriteStream & {
          removeListener?: (event: string, fn: (...args: unknown[]) => void) => void;
        };
        if (this._streamDataHandler && s.removeListener) {
          try { s.removeListener("data", this._streamDataHandler); } catch (e) {
            console.debug("[DockerPty] removeListener(data) failed:", e);
          }
        }
        if (this._streamErrorHandler && s.removeListener) {
          try { s.removeListener("error", this._streamErrorHandler); } catch (e) {
            console.debug("[DockerPty] removeListener(error) failed:", e);
          }
        }
        this._streamDataHandler = undefined;
        this._streamErrorHandler = undefined;
      }

      // dockerode types `attach()` as NodeJS.ReadWriteStream, which doesn't include `destroy()`.
      // Close using `end()` (typed) and call destroy when available at runtime.
      try {
        stream?.end();
      } catch (e) {
        console.debug("[DockerPty] stream.end() failed:", e);
      }
      if (DockerPty.hasDestroy(stream)) {
        try {
          stream.destroy();
        } catch (e) {
          console.debug("[DockerPty] stream.destroy() failed:", e);
        }
      }
      this.attachStream = undefined;

      if (container) {
        // stop then remove (remove is no-op when AutoRemove=true)
        try {
          await container.stop({ t: 1 });
        } catch (e) {
          console.debug("[DockerPty] container.stop() failed:", e);
        }
        try {
          await container.remove({ force: true });
        } catch (e) {
          console.debug("[DockerPty] container.remove() failed:", e);
        }
      }
      this.container = undefined;
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

    // Avoid emitting after disposal (session may already be torn down).
    if (this._disposed) return;

    this._exitListeners.forEach((l) => l(code, signal));
  }

  private emitError(err: Error): void {
    if (this._ended) return;

    // Emit error details when supported.
    this._errorListeners.forEach((l) => l(err));

    // Backward-compatible signal: treat fatal transport errors as abnormal exit.
    this.emitExit(-1);
  }
}
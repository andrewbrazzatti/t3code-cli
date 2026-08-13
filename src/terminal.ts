import { DEFAULT_TERMINAL_ID, WS_METHODS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { commandContext, resolveThreadContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";
import { errorMessage } from "./connection.js";

type TtyCommand =
  | { readonly kind: "write"; readonly data: string }
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number };

function exitCodeFromExited(event: { exitCode: number | null; exitSignal: number | null }): number {
  if (event.exitCode !== null && event.exitCode !== undefined) return event.exitCode;
  if (event.exitSignal !== null && event.exitSignal !== undefined) return 128 + event.exitSignal;
  return 0;
}

function clampCols(cols: number): number {
  return Math.min(Math.max(Math.trunc(cols), 1), 1000);
}

function clampRows(rows: number): number {
  return Math.min(Math.max(Math.trunc(rows), 1), 500);
}

export interface TerminalAttachOptions extends CommandContext {
  readonly threadId: string;
  readonly terminalId?: string;
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Record<string, string>;
}

/**
 * Open an interactive terminal for a thread and drive it until the remote
 * shell exits. Resolves to the shell's exit code.
 */
export async function attachTerminal(options: TerminalAttachOptions): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new ConfigError(
      "An interactive terminal requires a TTY. Run t3ctl terminal attach from an interactive shell.",
      "tty_required",
    );
  }

  const resolved = await resolveThreadContext(options, options.threadId);
  const threadId = options.threadId;
  const terminalId = options.terminalId ?? DEFAULT_TERMINAL_ID;
  const cwd = options.cwd ?? resolved.cwd;
  const worktreePath = resolved.worktreePath;
  const cols = clampCols(options.cols ?? stdout.columns ?? 80);
  const rows = clampRows(options.rows ?? stdout.rows ?? 24);

  const exitCode = await withClient(options, (client) =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<number>();
      const commands = yield* Queue.unbounded<TtyCommand>();

      const runCommand = (command: TtyCommand) =>
        command.kind === "write"
          ? client[WS_METHODS.terminalWrite]({ threadId, terminalId, data: command.data })
          : client[WS_METHODS.terminalResize]({ threadId, terminalId, cols: command.cols, rows: command.rows });

      // Forward queued stdin/resize commands to the remote terminal, serially.
      yield* Stream.fromQueue(commands).pipe(
        Stream.mapEffect((command) => runCommand(command).pipe(Effect.catch(() => Effect.void))),
        Stream.runDrain,
      ).pipe(Effect.forkScoped);

      const attachStream = client[WS_METHODS.terminalAttach]({
        threadId,
        terminalId,
        cwd,
        ...(worktreePath ? { worktreePath } : {}),
        cols,
        rows,
        ...(options.env ? { env: options.env } : {}),
        restartIfNotRunning: true,
      });

      // Consume the attach stream, rendering output and completing the exit
      // deferred on termination. Forked so the main effect can await it while
      // the command queue drains concurrently.
      yield* (Effect.gen(function* () {
        yield* attachStream.pipe(
          Stream.runForEach((event: any) =>
            Effect.gen(function* () {
              if (event.type === "snapshot") {
                const snapshot = event.snapshot;
                if (snapshot.history) stdout.write(snapshot.history);
                if (snapshot.status === "exited" || snapshot.status === "error") {
                  yield* Deferred.succeed(exit, exitCodeFromExited(snapshot));
                }
              } else if (event.type === "output") {
                stdout.write(event.data);
              } else if (event.type === "exited") {
                yield* Deferred.succeed(exit, exitCodeFromExited(event));
              } else if (event.type === "closed") {
                yield* Deferred.succeed(exit, 0);
              } else if (event.type === "error") {
                stdout.write(`\n[t3ctl] terminal error: ${event.message}\n`);
                yield* Deferred.succeed(exit, 1);
              }
            }),
          ),
          Effect.catch((error: unknown) =>
            Effect.gen(function* () {
              stdout.write(`\n[t3ctl] terminal stream error: ${errorMessage(error)}\n`);
              yield* Deferred.succeed(exit, 1);
            }),
          ),
        );
        // The stream ended without an explicit terminal exit (e.g. the server
        // closed the connection). Complete so the awaiting fiber can finish.
        yield* Deferred.succeed(exit, 0);
      })).pipe(Effect.forkScoped);

      // Switch the local terminal to raw mode so keystrokes and control
      // sequences pass through to the remote shell, and route SIGWINCH resizes.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const onData = (chunk: Buffer | string) => {
            Queue.offerUnsafe(commands, { kind: "write", data: String(chunk) });
          };
          const onResize = () => {
            const nextCols = clampCols(stdout.columns ?? 80);
            const nextRows = clampRows(stdout.rows ?? 24);
            Queue.offerUnsafe(commands, { kind: "resize", cols: nextCols, rows: nextRows });
          };
          stdin.setRawMode(true);
          stdin.setEncoding("utf8");
          stdin.resume();
          stdin.on("data", onData);
          process.on("SIGWINCH", onResize);
          return { onData, onResize };
        }),
        ({ onData, onResize }) =>
          Effect.sync(() => {
            stdin.off("data", onData);
            process.off("SIGWINCH", onResize);
            stdin.pause();
            stdin.setRawMode(false);
          }),
      );

      return yield* Deferred.await(exit);
    }) as any,
  );

  // The remote shell has exited and the local terminal is restored. Exit
  // explicitly: the raw-mode stdin stream and the WebSocket close handshake can
  // otherwise leave handles that keep the process alive after the session ends.
  return process.exit(exitCode);
}

export interface TerminalListOptions extends CommandContext {
  readonly threadId: string;
}

export async function listTerminals(options: TerminalListOptions): Promise<unknown> {
  const { sink } = commandContext(options);
  const terminals = await withClient(options, (client) =>
    Effect.gen(function* () {
      const stream = client[WS_METHODS.subscribeTerminalMetadata]({});
      let snapshot: any[] | undefined;
      yield* stream.pipe(
        Stream.runForEachWhile((item: any) =>
          Effect.sync(() => {
            if (item?.type === "snapshot") snapshot = item.terminals ?? [];
            return snapshot === undefined;
          }),
        ),
      );
      return (snapshot ?? []).filter((terminal: any) => terminal.threadId === options.threadId);
    }),
  );
  const result = { threadId: options.threadId, terminals };
  sink.write(result);
  return result;
}

export interface TerminalCloseOptions extends CommandContext {
  readonly threadId: string;
  readonly terminalId?: string;
  readonly deleteHistory?: boolean;
}

export async function closeTerminal(options: TerminalCloseOptions): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) =>
    Effect.gen(function* () {
      yield* client[WS_METHODS.terminalClose]({
        threadId: options.threadId,
        ...(options.terminalId ? { terminalId: options.terminalId } : {}),
        ...(options.deleteHistory ? { deleteHistory: true } : {}),
      });
    }),
  );
  const result = { threadId: options.threadId, terminalId: options.terminalId ?? null, closed: true };
  sink.write(result);
  return result;
}

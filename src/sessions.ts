/**
 * Import history from the local Claude Code and Codex CLIs into T3 Code.
 * `scan` discovers directories those agents have run in; `import` folds one
 * project's native session history into the T3 Code thread list.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, resolveProject, withClient, type CommandContext } from "./app.js";

export async function sessionsScan(options: CommandContext): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.agentSessionsScan]({});
  }));
  sink.write(result);
  return result;
}

export async function sessionsImport(options: CommandContext & { readonly projectId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  const project = await resolveProject(options, options.projectId);
  const result = await withClient(options, (client) => Effect.gen(function* () {
    return yield* client[WS_METHODS.agentSessionsImport]({
      projectId: project.id,
      expectedWorkspaceRoot: project.workspaceRoot,
    });
  }));
  sink.write({ projectId: project.id, ...(result as object) });
  return result;
}

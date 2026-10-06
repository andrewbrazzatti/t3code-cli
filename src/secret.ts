/**
 * Answer an agent's secret request: save a value the server keeps under a
 * one-use reference, or decline.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, withClient, type CommandContext } from "./app.js";
import { ConfigError } from "./config.js";

export async function answerSecret(options: CommandContext & {
  readonly threadId: string;
  readonly turnItemId: string;
  readonly secret?: string;
  readonly decline?: boolean;
}): Promise<unknown> {
  const { sink } = commandContext(options);
  const hasSecret = options.secret !== undefined;
  if (hasSecret === Boolean(options.decline)) {
    throw new ConfigError("Provide --secret VALUE or --decline (exactly one).", "cli_parse_failed");
  }
  const answer = hasSecret ? { type: "save", secret: options.secret! } : { type: "decline" };
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.secretsAnswerRequest]({
      threadId: options.threadId,
      turnItemId: options.turnItemId,
      answer,
    });
  }));
  const result = { threadId: options.threadId, turnItemId: options.turnItemId, answered: true, saved: hasSecret };
  sink.write(result);
  return result;
}

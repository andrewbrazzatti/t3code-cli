/**
 * Chat attachments. `upload` mints a signed upload URL, POSTs the bytes, and
 * returns the persisted attachment ids; `delete` removes a pending upload.
 */

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { commandContext, uploadAttachments, withClient, type CommandContext } from "./app.js";

export async function attachUpload(options: CommandContext & { readonly paths: ReadonlyArray<string> }): Promise<unknown> {
  const { sink } = commandContext(options);
  const result = await withClient(options, (client, target) => Effect.gen(function* () {
    const attachments = yield* uploadAttachments(client, target, options.paths);
    return { attachments };
  }));
  sink.write(result);
  return result;
}

export async function attachDelete(options: CommandContext & { readonly attachmentId: string }): Promise<unknown> {
  const { sink } = commandContext(options);
  await withClient(options, (client) => Effect.gen(function* () {
    yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: options.attachmentId });
  }));
  const result = { attachmentId: options.attachmentId, deleted: true };
  sink.write(result);
  return result;
}

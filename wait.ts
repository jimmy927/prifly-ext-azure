/**
 * `azure_wait_operation`: follow an operation ARM accepted (the
 * Azure-AsyncOperation or Location URL of a 201 or 202) until it succeeds,
 * fails or is cancelled, or the wait runs out. Only management.azure.com URLs
 * are polled, at the pace the operation's Retry-After asks.
 */

import type { ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import type { ArmClient, ArmReply } from "./arm";
import { obj, str, subscriptionOf } from "./azure";
import { arg, type Kit, tenantFor, withReach } from "./kit";
import { jsonText } from "./results";
import { armUrl } from "./writes";

const DEFAULT_WAIT_S = 300;
const MAX_WAIT_S = 1800;
const DEFAULT_POLL_S = 10;
const MAX_POLL_S = 60;

const ENDED = new Map([
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["canceled", "Canceled"],
  ["cancelled", "Canceled"],
]);

/** Where the operation stands: its `status` (Azure-AsyncOperation), else a 202 runs on and anything else is done. */
export function stateOf(reply: ArmReply): string {
  const told = str(obj(reply.body)["status"]);
  if (told !== "") return ENDED.get(told.toLowerCase()) ?? told;
  return reply.status === 202 ? "InProgress" : "Succeeded";
}

/** Seconds a Retry-After asks for (a number or an HTTP date), else the default; at least 1, at most 60. */
export function retryAfterSeconds(value: string | undefined, now: number): number {
  if (value === undefined || value.trim() === "") return DEFAULT_POLL_S;
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : (Date.parse(value) - now) / 1000;
  if (!Number.isFinite(seconds)) return DEFAULT_POLL_S;
  return Math.max(1, Math.min(MAX_POLL_S, Math.ceil(seconds)));
}

type Poll = { ended: string } | { waitS: number; state: string; reply: ArmReply | null };

async function pollOnce(kit: Kit, arm: ArmClient, path: string, tenant: string): Promise<Poll> {
  const sent = await arm.send(path, { tenant });
  if (!sent.ok) {
    const failure = sent.failure;
    if (failure.kind === "throttled") {
      return {
        waitS: retryAfterSeconds(failure.retryAfter, kit.now()),
        state: "Throttled",
        reply: null,
      };
    }
    if (failure.kind === "failed") {
      return {
        ended: jsonText(
          {
            status: "Failed",
            httpStatus: failure.status,
            code: failure.code,
            message: failure.message,
          },
          "The operation failed.",
        ),
      };
    }
    return { ended: kit.access.explain(failure) };
  }
  const state = stateOf(sent.value);
  if (ENDED.has(state.toLowerCase())) {
    return {
      ended: jsonText(
        { status: state, httpStatus: sent.value.status, body: sent.value.body },
        `The operation ended: ${state}.`,
      ),
    };
  }
  return {
    waitS: retryAfterSeconds(sent.value.headers["retry-after"], kit.now()),
    state,
    reply: sent.value,
  };
}

async function follow(
  kit: Kit,
  arm: ArmClient,
  how: { path: string; tenant: string; waitS: number },
  ctx: ExtensionToolContext,
): Promise<string> {
  const deadline = kit.now() + how.waitS * 1000;
  for (;;) {
    const poll = await pollOnce(kit, arm, how.path, how.tenant);
    if ("ended" in poll) return poll.ended;
    const left = deadline - kit.now();
    if (left <= 0) {
      return jsonText(
        { status: poll.state, body: poll.reply?.body ?? null },
        `Still running after ${how.waitS} s: call azure_wait_operation again with the same url to keep waiting.`,
      );
    }
    await kit.sleep(Math.min(poll.waitS * 1000, left), ctx.signal);
    if (ctx.signal.aborted)
      return "Stopped waiting: the call was cancelled. The operation itself runs on.";
  }
}

export function waitTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_wait_operation",
    description:
      "Waits for an Azure operation that azure_api, azure_put_resource or azure_delete_resource said is still running: polls its https://management.azure.com operation URL (at the pace its Retry-After asks) until Succeeded, Failed or Canceled, and returns the final status and body; after the timeout it says it is still running. A read: runs at once.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The operation URL the call answered with." },
        timeoutSeconds: {
          type: "number",
          description: `How long to wait (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}).`,
        },
        tenant: {
          type: "string",
          description: "The tenant to poll in; left out, the URL's subscription's.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      const url = armUrl(arg(args, "url"));
      if (typeof url === "string") return url;
      const given = args["timeoutSeconds"];
      const waitS =
        typeof given === "number" && Number.isFinite(given)
          ? Math.max(0, Math.min(MAX_WAIT_S, given))
          : DEFAULT_WAIT_S;
      return withReach(kit, (arm, reach) => {
        const tenant = arg(args, "tenant") || tenantFor(kit, reach, subscriptionOf(url.pathname));
        return follow(kit, arm, { path: `${url.pathname}${url.search}`, tenant, waitS }, ctx);
      });
    },
  };
}

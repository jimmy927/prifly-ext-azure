/** What every tool is built from, and the small helpers they share. */

import type { ConfirmSpec } from "@prifly/extension-api";
import type { Access } from "./access";
import type { ArmClient, ArmResult } from "./arm";
import type { Subscription } from "./azure";
import type { AzureContext, Reach } from "./context";
import type { SpecLibrary } from "./specs";

export type Kit = {
  context: AzureContext;
  access: Access;
  /** `api.confirm`; absent on a prifly that cannot ask, and then nothing is changed. */
  confirm: ((spec: ConfirmSpec) => Promise<boolean>) | undefined;
  /** The azure-rest-api-specs reader of `azure_api_docs`. */
  specs: SpecLibrary;
  now: () => number;
  /** Waits `ms`, or less when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export function arg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

/** Run `body` with the account's client and what it reaches, or say why not (starting a sign-in where one is missing). */
export async function withReach(
  kit: Kit,
  body: (arm: ArmClient, reach: Reach[]) => Promise<string>,
): Promise<string> {
  const client = kit.context.client();
  if (!client.ok) return kit.access.explain(client.failure);
  const reach = await kit.context.reach(client.value);
  if (!reach.ok) return kit.access.explain(reach.failure);
  return body(client.value, reach.value);
}

export function answer<T>(kit: Kit, result: ArmResult<T>, render: (value: T) => string): string {
  return result.ok ? render(result.value) : kit.access.explain(result.failure);
}

/** The tenant a subscription is in, "" (the account's own) when it is not among the reached. */
export function tenantFor(kit: Kit, reach: Reach[], subscription: string): string {
  return kit.context.tenantOf(reach, subscription)?.id ?? "";
}

const NO_SUBSCRIPTIONS =
  "No Azure subscriptions are reachable with this sign-in, so there is nothing to ask. Check azure_tenants for a tenant that needs a fresh sign-in, or sign in with an account that has a subscription.";

/**
 * The subscriptions a tool with an optional `subscription` works on: the one
 * given (blank counts as not given), else every one the account reaches.
 * Text instead when there is none, so no `/subscriptions//…` is ever sent.
 */
export function subscriptionsToAsk(
  reach: readonly Reach[],
  given: string,
): Subscription[] | string {
  const all = reach.flatMap((each) => each.subscriptions).filter((sub) => sub.id !== "");
  const wanted = given.trim();
  if (wanted !== "")
    return [
      all.find((sub) => sub.id === wanted) ?? { id: wanted, name: wanted, state: "", tenant: "" },
    ];
  return all.length === 0 ? NO_SUBSCRIPTIONS : all;
}

/** Text when an ARM path has an empty subscription segment (`/subscriptions//…`), else null. */
export function emptySubscriptionSegment(path: string): string | null {
  return /\/subscriptions\/(?:%20|\s)*\//i.test(path.split("?")[0] ?? "")
    ? "The path has an empty subscription id (/subscriptions//…). Find the id with azure_subscriptions."
    : null;
}

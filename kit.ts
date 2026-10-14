/** What every tool is built from, and the small helpers they share. */

import type { ConfirmSpec } from "@prifly/extension-api";
import type { Access } from "./access";
import type { ArmClient, ArmResult } from "./arm";
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

/**
 * The one line Settings → Extensions shows for Azure (`api.status`):
 * "Connected · 3 subscriptions (Northwind Retail, Contoso Labs)", or why it is
 * not. Read at most every fifteen minutes; a sign-in a tool started refreshes
 * it at once.
 */

import type { ArmFailure } from "./arm";
import type { AzureContext } from "./context";
import { failureText } from "./results";

export const STATUS_MS = 15 * 60 * 1000;

export function offlineText(failure: ArmFailure): string {
  switch (failure.kind) {
    case "not-connected":
      return "Not connected: no Microsoft account; ask a session for anything in Azure to connect one";
    case "not-granted":
      return `Not connected: Azure access not granted on ${failure.account}; ask a session for anything in Azure to grant it`;
    case "needs-sign-in":
      return failure.tenant === null
        ? `Not connected: the sign-in for ${failure.account} ended`
        : `Connected, but tenant ${failure.tenant} needs a fresh sign-in`;
    default:
      return `Could not read Azure: ${failureText(failure).slice(0, 160)}`;
  }
}

export class StatusLine {
  private readonly set: ((text: string) => void) | undefined;
  private readonly context: AzureContext;
  private readonly now: () => number;
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    set: ((text: string) => void) | undefined,
    context: AzureContext,
    now: () => number = Date.now,
  ) {
    this.set = set;
    this.context = context;
    this.now = now;
  }

  /** Read and show the line, unless it was read less than fifteen minutes ago (`force` reads anyway). */
  async refresh(force = false): Promise<void> {
    if (this.set === undefined) return;
    const at = this.now();
    if (!force && at - this.last < STATUS_MS) return;
    this.last = at;
    this.set(await this.text());
  }

  private async text(): Promise<string> {
    const client = this.context.client();
    if (!client.ok) return offlineText(client.failure);
    const reach = await this.context.reach(client.value);
    if (!reach.ok) return offlineText(reach.failure);
    const count = reach.value.reduce((sum, each) => sum + each.subscriptions.length, 0);
    const names = reach.value.map((each) => each.tenant.name).join(", ");
    return `Connected · ${count} subscription${count === 1 ? "" : "s"}${names === "" ? "" : ` (${names})`}`;
  }
}

/**
 * What the tools and the status line share: the account Azure is reached
 * through, and the tenants and subscriptions it reaches (kept ten minutes, so
 * a run of tool calls does not list them again each time).
 */

import type { ExtensionConnectionsApi } from "@prifly/extension-api";
import { ArmClient, type ArmFailure, type ArmResult, pickConnection } from "./arm";
import { type Subscription, subscriptions, type Tenant, tenants } from "./azure";

const KEEP_MS = 10 * 60 * 1000;

/** A tenant the account reaches, and its subscriptions or why they could not be read. */
export type Reach = {
  tenant: Tenant;
  subscriptions: Subscription[];
  failure: ArmFailure | null;
};

type Kept = { at: number; connection: string; reach: Reach[] };

export class AzureContext {
  readonly connections: () => ExtensionConnectionsApi | undefined;
  private readonly now: () => number;
  /** Per connection: tenants whose sign-in alone ended, as far as this extension saw. */
  private readonly dead = new Map<string, Set<string>>();
  private kept: Kept | null = null;

  constructor(
    connections: () => ExtensionConnectionsApi | undefined,
    now: () => number = Date.now,
  ) {
    this.connections = connections;
    this.now = now;
  }

  /** The ARM client of the chosen account, or why there is none. */
  client(): ArmResult<ArmClient> {
    const connections = this.connections();
    if (connections === undefined) return { ok: false, failure: { kind: "not-connected" } };
    const chosen = pickConnection(connections);
    if (!chosen.ok) return chosen;
    const id = chosen.value.id;
    const dead = this.dead.get(id) ?? new Set<string>();
    this.dead.set(id, dead);
    return { ok: true, value: new ArmClient(connections, chosen.value, dead) };
  }

  /** A tenant (or, `tenant` null, the whole account) was signed in to again: try it once more. */
  revived(connection: string, tenant: string | null): void {
    if (tenant === null) this.dead.delete(connection);
    else this.dead.get(connection)?.delete(tenant);
    this.kept = null;
  }

  /** Every tenant the account reaches, each with its subscriptions; one tenant's failure is kept on it. */
  async reach(arm: ArmClient): Promise<ArmResult<Reach[]>> {
    const held = this.kept;
    if (held !== null && held.connection === arm.connection.id && this.now() - held.at < KEEP_MS) {
      return { ok: true, value: held.reach };
    }
    const listed = await tenants(arm);
    if (!listed.ok) return listed;
    const reach: Reach[] = [];
    for (const tenant of listed.value) {
      const subs = await subscriptions(arm, tenant.id);
      reach.push({
        tenant,
        subscriptions: subs.ok ? subs.value : [],
        failure: subs.ok ? null : subs.failure,
      });
    }
    this.kept = { at: this.now(), connection: arm.connection.id, reach };
    return { ok: true, value: reach };
  }

  /** The tenant of a subscription, by id. */
  tenantOf(reach: readonly Reach[], subscription: string): Tenant | null {
    return (
      reach.find((each) => each.subscriptions.some((sub) => sub.id === subscription))?.tenant ??
      null
    );
  }
}

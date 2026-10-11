/**
 * The light background work: failed deployments, checked every fifteen
 * minutes a few resource groups at a time, and the status-bar chip that says
 * which account and tenant Azure is read as.
 *
 * Failures from the last 24 hours light the launcher and fill the board's
 * first column; each one that is new since the last round is a notice. The
 * first round only learns what is there, so starting prifly is not a burst of
 * old notices.
 */

import type { Decoration, ExtensionApi } from "@prifly/extension-api";
import type { ArmClient, ArmFailure } from "./arm";
import { type Deployment, deployments, resourceGraph } from "./azure";
import type { AzureContext, Reach } from "./context";

export const LAUNCHER = "resource";
export const ROUND_MS = 15 * 60 * 1000;
/** Resource groups read per round: the rest wait for the next, in turn. */
export const GROUPS_PER_ROUND = 25;
const SUBSCRIPTIONS_WATCHED = 5;
const RECENT_MS = 24 * 60 * 60 * 1000;

type Group = { subscription: string; name: string; tenant: string };

/** A Resource Graph row of `resourcecontainers` as a group; none when it lacks a name or subscription. */
function groupOf(row: Record<string, unknown>, tenant: string): Group[] {
  const name = typeof row["name"] === "string" ? row["name"] : "";
  const subscription = typeof row["subscriptionId"] === "string" ? row["subscriptionId"] : "";
  return name === "" || subscription === "" ? [] : [{ subscription, name, tenant }];
}

export class Watcher {
  private readonly api: ExtensionApi;
  private readonly context: AzureContext;
  private readonly now: () => number;
  private failures = new Map<string, Deployment>();
  private readonly told = new Set<string>();
  private offset = 0;
  private rounds = 0;

  constructor(api: ExtensionApi, context: AzureContext, now: () => number = Date.now) {
    this.api = api;
    this.context = context;
    this.now = now;
  }

  /** The failed deployments of the last 24 hours, newest first. */
  failed(): Deployment[] {
    return [...this.failures.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async round(): Promise<void> {
    const client = this.context.client();
    if (!client.ok) {
      this.chip(null, [], client.failure);
      this.api.flag(LAUNCHER, null);
      return;
    }
    const reach = await this.context.reach(client.value);
    if (!reach.ok) {
      this.chip(client.value, [], reach.failure);
      return;
    }
    this.chip(client.value, reach.value, null);
    const groups = await this.groups(client.value, reach.value);
    const scanned = this.slice(groups);
    for (const group of scanned) await this.scan(client.value, group);
    this.prune(groups);
    this.rounds += 1;
    this.light();
  }

  /** Every resource group of the watched subscriptions, in a stable order. */
  private async groups(arm: ArmClient, reach: Reach[]): Promise<Group[]> {
    const out: Group[] = [];
    for (const each of reach) {
      const subs = each.subscriptions
        .filter((sub) => sub.state === "Enabled")
        .slice(0, SUBSCRIPTIONS_WATCHED);
      if (subs.length === 0) continue;
      const listed = await resourceGraph(arm, {
        query:
          "resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' | project name, subscriptionId | order by subscriptionId asc, name asc",
        subscriptions: subs.map((sub) => sub.id),
        tenant: each.tenant.id,
        top: 1000,
      });
      if (listed.ok) out.push(...listed.value.rows.flatMap((row) => groupOf(row, each.tenant.id)));
    }
    return out;
  }

  /** This round's share of the groups, going round. */
  private slice(groups: Group[]): Group[] {
    if (groups.length <= GROUPS_PER_ROUND) return groups;
    const start = this.offset % groups.length;
    this.offset = start + GROUPS_PER_ROUND;
    return [...groups, ...groups].slice(start, start + GROUPS_PER_ROUND);
  }

  private async scan(arm: ArmClient, group: Group): Promise<void> {
    const listed = await deployments(arm, {
      subscription: group.subscription,
      group: group.name,
      tenant: group.tenant,
      failedOnly: true,
      top: 10,
    });
    if (!listed.ok) return;
    for (const [id, held] of this.failures) {
      if (held.subscription === group.subscription && held.resourceGroup === group.name) {
        this.failures.delete(id);
      }
    }
    const since = this.now() - RECENT_MS;
    for (const deployment of listed.value) {
      if (Date.parse(deployment.timestamp) >= since) this.failures.set(deployment.id, deployment);
    }
  }

  /** Forget failures that aged out or whose group is gone. */
  private prune(groups: Group[]): void {
    const known = new Set(groups.map((group) => `${group.subscription}/${group.name}`));
    const since = this.now() - RECENT_MS;
    for (const [id, held] of this.failures) {
      const gone = !known.has(`${held.subscription}/${held.resourceGroup}`);
      if (gone || Date.parse(held.timestamp) < since) this.failures.delete(id);
    }
  }

  /** The launcher's glow, and a notice for each failure new since the last round. */
  private light(): void {
    const failed = this.failed();
    for (const deployment of failed) {
      if (this.told.has(deployment.id)) continue;
      this.told.add(deployment.id);
      if (this.rounds > 1) {
        const why = deployment.error === "" ? "" : `: ${deployment.error}`;
        this.api.notify(
          `Azure deployment ${deployment.name} failed in ${deployment.resourceGroup}${why}`,
          { tone: "warning" },
        );
      }
    }
    const first = failed[0];
    this.api.flag(
      LAUNCHER,
      first === undefined
        ? null
        : {
            tone: "warning",
            hint:
              failed.length === 1
                ? `1 failed deployment in ${first.resourceGroup}`
                : `${failed.length} failed deployments`,
          },
    );
  }

  private chip(arm: ArmClient | null, reach: Reach[], failure: ArmFailure | null): void {
    const shown = chipOf(arm, reach, failure, this.context);
    this.api.show({}, shown === null ? [] : [shown]);
  }
}

/** The status-bar chip: who Azure is read as, and in which tenant; null when nothing is connected. */
export function chipOf(
  arm: ArmClient | null,
  reach: Reach[],
  failure: ArmFailure | null,
  context: AzureContext,
): Decoration | null {
  const base = { key: "azure", icon: "azure" as const, url: "https://portal.azure.com/" };
  if (failure?.kind === "not-connected") return null;
  if (failure?.kind === "not-granted") {
    return {
      ...base,
      label: "Azure · grant access",
      tone: "muted",
      details: [
        `${failure.account} has not granted Azure access yet.`,
        "Grant it from From an Azure resource….",
      ],
    };
  }
  if (failure?.kind === "needs-sign-in" && failure.tenant === null) {
    return {
      ...base,
      label: "Azure · sign in again",
      tone: "warning",
      details: [`The Microsoft sign-in for ${failure.account} ended.`],
    };
  }
  const account = arm?.connection.account ?? "";
  const shown = context.shown(reach);
  const tenant = shown === null ? null : context.tenantOf(reach, shown.id);
  const dead = arm?.tenantsNeedingSignIn() ?? [];
  const label =
    dead.length > 0
      ? `Azure · ${account} · ${dead.length} tenant${dead.length === 1 ? "" : "s"} to sign in`
      : `Azure · ${account}${tenant === null ? "" : ` · ${tenant.name}`}`;
  const details = [
    `Read as ${account}.`,
    ...reach.map(
      (each) =>
        `${each.tenant.name}: ${each.subscriptions.length} subscription${each.subscriptions.length === 1 ? "" : "s"}${dead.includes(each.tenant.id) ? " (sign in again)" : ""}`,
    ),
  ];
  return {
    ...base,
    label,
    tone: dead.length > 0 || failure !== null ? "warning" : "good",
    details,
  };
}

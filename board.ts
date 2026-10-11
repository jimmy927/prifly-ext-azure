/**
 * The launcher "From an Azure resource…": a board of the shown subscription's
 * resources, one column per resource group, after a first column of the
 * deployments that failed in the last day. Its setup rows grant Azure access,
 * sign a tenant in again and switch subscription; a picked resource starts a
 * session that knows it (`describe.ts`).
 *
 * `choices` is asked on every keystroke, so the resources are kept two
 * minutes and filtered here.
 */

import type {
  ExtensionConnectionsApi,
  LabelColour,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchItem,
} from "@prifly/extension-api";
import { ARM_SCOPE, type ArmClient, type ArmFailure } from "./arm";
import { resourceGraph, type Subscription } from "./azure";
import type { AzureContext, Reach } from "./context";
import { describeDeployment, describeResource } from "./describe";
import { failureText } from "./results";
import type { Watcher } from "./watch";

const KEEP_MS = 2 * 60 * 1000;
const RESOURCES_SHOWN = 300;
const OTHER_SUBSCRIPTIONS = 10;

type Resource = {
  id: string;
  name: string;
  type: string;
  group: string;
  location: string;
  tags: string;
};
type Kept = { at: number; subscription: string; resources: Resource[] };

function setupRow(key: string, title: string, detail: string): LaunchChoice {
  return { key, title, detail, tone: "muted" };
}

/** A stripe per kind of resource, so a column reads at a glance. */
function stripeOf(type: string): LabelColour {
  const family = type.toLowerCase().split("/")[0] ?? "";
  const colours: Record<string, LabelColour> = {
    "microsoft.web": "blue",
    "microsoft.sql": "purple",
    "microsoft.dbforpostgresql": "purple",
    "microsoft.storage": "yellow",
    "microsoft.keyvault": "orange",
    "microsoft.network": "green",
    "microsoft.compute": "red",
    "microsoft.containerservice": "pink",
  };
  return colours[family] ?? "grey";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tagsOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, tag]) => `${key}=${str(tag)}`)
    .slice(0, 3)
    .join(" ");
}

/** The rows a launcher shows instead of a board, when Azure cannot be read. */
function failureRows(failure: ArmFailure): LaunchChoice[] {
  switch (failure.kind) {
    case "not-connected":
      return [
        setupRow(
          "setup:none",
          "Connect a Microsoft account first",
          "In prifly's Vault → Connections; then come back here.",
        ),
      ];
    case "not-granted":
      return [
        setupRow(
          "setup:retry",
          "Azure access is not granted",
          `${failure.account} has not granted it yet, so nothing of Azure is read.`,
        ),
        setupRow(
          "setup:grant",
          "Grant Azure access",
          `${failure.account} signs in once more and approves reading Azure.`,
        ),
      ];
    case "needs-sign-in":
      return [
        setupRow(
          "setup:signin",
          `Sign in again as ${failure.account}`,
          "The Microsoft sign-in ended.",
        ),
      ];
    default:
      return [setupRow("setup:retry", "Azure could not be read", failureText(failure))];
  }
}

export class Board {
  private readonly context: AzureContext;
  private readonly watcher: Watcher;
  private readonly connections: () => ExtensionConnectionsApi | undefined;
  private readonly now: () => number;
  private kept: Kept | null = null;

  constructor(
    context: AzureContext,
    watcher: Watcher,
    connections: () => ExtensionConnectionsApi | undefined,
    now: () => number = Date.now,
  ) {
    this.context = context;
    this.watcher = watcher;
    this.connections = connections;
    this.now = now;
  }

  async choices(query: string): Promise<LaunchBoard | LaunchChoice[]> {
    const client = this.context.client();
    if (!client.ok) return failureRows(client.failure);
    const reach = await this.context.reach(client.value);
    if (!reach.ok) return failureRows(reach.failure);
    const shown = this.context.shown(reach.value);
    if (shown === null) {
      return [
        setupRow(
          "setup:retry",
          "No subscription",
          `${client.value.connection.account} reaches no Azure subscription.`,
        ),
      ];
    }
    const resources = await this.resources(client.value, reach.value, shown);
    if (!resources.ok) return failureRows(resources.failure);
    return this.boardOf(client.value, reach.value, shown, resources.value, query);
  }

  private async resources(arm: ArmClient, reach: Reach[], shown: Subscription) {
    const held = this.kept;
    if (held !== null && held.subscription === shown.id && this.now() - held.at < KEEP_MS) {
      return { ok: true as const, value: held.resources };
    }
    const read = await resourceGraph(arm, {
      query:
        "resources | project id, name, type, resourceGroup, location, tags | order by resourceGroup asc, name asc",
      subscriptions: [shown.id],
      tenant: this.context.tenantOf(reach, shown.id)?.id ?? "",
      top: RESOURCES_SHOWN,
    });
    if (!read.ok) return read;
    const resources = read.value.rows.map((row) => ({
      id: str(row["id"]),
      name: str(row["name"]),
      type: str(row["type"]),
      group: str(row["resourceGroup"]),
      location: str(row["location"]),
      tags: tagsOf(row["tags"]),
    }));
    this.kept = { at: this.now(), subscription: shown.id, resources };
    return { ok: true as const, value: resources };
  }

  private boardOf(
    arm: ArmClient,
    reach: Reach[],
    shown: Subscription,
    resources: Resource[],
    query: string,
  ): LaunchBoard {
    const wanted = query.trim().toLowerCase();
    const hit = (...words: string[]) =>
      wanted === "" || words.join(" ").toLowerCase().includes(wanted);
    const failed = this.watcher.failed().filter((each) => each.subscription === shown.id);
    const groups = [...new Set(resources.map((each) => each.group))];
    const items: LaunchChoice[] = [
      ...failed
        .filter((each) => hit(each.name, each.resourceGroup, each.error))
        .map((each) => ({
          key: `dep:${each.id}`,
          title: `${each.name} · deployment failed`,
          group: "failed",
          sub: "Microsoft.Resources/deployments",
          detail: each.error === "" ? each.resourceGroup : each.error,
          tone: "critical" as const,
          stripes: ["red" as const],
          badges: { due: each.timestamp.slice(11, 16), dueLate: true },
        })),
      ...resources
        .filter((each) => hit(each.name, each.type, each.group, each.location, each.tags))
        .map((each) => ({
          key: `res:${each.id}`,
          title: each.name,
          group: each.group,
          sub: each.type,
          detail: [each.location, each.tags].filter((part) => part !== "").join(" · "),
          tone: "info" as const,
          stripes: [stripeOf(each.type)],
        })),
    ];
    return {
      columns: [
        { id: "failed", name: "Failed deployments" },
        ...groups.map((group) => ({ id: group, name: group })),
      ],
      items,
      actions: this.setupRows(arm, reach, shown),
    };
  }

  private setupRows(arm: ArmClient, reach: Reach[], shown: Subscription): LaunchChoice[] {
    const tenant = this.context.tenantOf(reach, shown.id);
    const others = reach
      .flatMap((each) => each.subscriptions)
      .filter((sub) => sub.id !== shown.id && sub.state === "Enabled")
      .slice(0, OTHER_SUBSCRIPTIONS)
      .map((sub) => setupRow(`setup:sub:${sub.id}`, `Show ${sub.name}`, sub.id));
    const named = new Map(reach.map((each) => [each.tenant.id, each.tenant.name]));
    const dead = arm
      .tenantsNeedingSignIn()
      .map((id) =>
        setupRow(
          `setup:signin:${id}`,
          `Sign in again to ${named.get(id) ?? id}`,
          "That tenant asks for a fresh sign-in.",
        ),
      );
    return [
      setupRow(
        "setup:shown",
        `${tenant?.name ?? "Azure"} · ${shown.name}`,
        `Read as ${arm.connection.account}`,
      ),
      ...dead,
      ...others,
    ];
  }

  /** A picked row: a setup step (no session; the board lists again), or a session. */
  async launch(key: string): Promise<Launch> {
    if (key.startsWith("setup:")) return { prompt: "", message: await this.setup(key) };
    const described = await this.describe(key);
    return { prompt: described.markdown, name: described.name };
  }

  /** A card opened on the board: the same text a session would start with. */
  async open(key: string): Promise<LaunchItem> {
    const described = await this.describe(key);
    return { title: described.title, url: described.url, markdown: described.markdown };
  }

  private async describe(key: string) {
    const client = this.context.client();
    if (!client.ok) throw new Error(failureText(client.failure));
    const reach = await this.context.reach(client.value);
    if (!reach.ok) throw new Error(failureText(reach.failure));
    const id = key.slice(4);
    return key.startsWith("dep:")
      ? describeDeployment(client.value, this.context, reach.value, id)
      : describeResource(client.value, this.context, reach.value, id, this.now());
  }

  private async setup(key: string): Promise<string> {
    if (key.startsWith("setup:sub:")) {
      this.context.pick(key.slice("setup:sub:".length));
      this.kept = null;
      return "Showing that subscription.";
    }
    const connections = this.connections();
    const client = connections === undefined ? null : connections.list("microsoft")[0];
    if (connections === undefined || client === undefined || client === null) {
      return "Connect a Microsoft account in prifly's Vault → Connections first.";
    }
    if (key === "setup:grant") return this.signIn(connections, [ARM_SCOPE], client.id, null);
    if (key === "setup:signin") return this.signIn(connections, [], client.id, null);
    if (key.startsWith("setup:signin:")) {
      return this.signIn(connections, [], client.id, key.slice("setup:signin:".length));
    }
    this.context.forget();
    this.kept = null;
    return "";
  }

  private async signIn(
    connections: ExtensionConnectionsApi,
    scopes: string[],
    connection: string,
    tenant: string | null,
  ): Promise<string> {
    // `tenant` is read by a prifly that signs in at one tenant; an older one signs the account in whole.
    const options = tenant === null ? { connection } : { connection, tenant };
    const signed = await connections.signIn("microsoft", scopes, options);
    if (!signed.ok) return signed.message;
    this.context.revived(connection, tenant);
    this.kept = null;
    return tenant === null ? `Signed in as ${signed.account}.` : `Signed in again to ${tenant}.`;
  }
}

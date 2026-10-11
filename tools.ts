/**
 * The tools every session sees as `mcp__prifly__azure_*`. Read-only: nothing
 * here changes Azure. Each answers text — JSON for rows, a sentence for a
 * failure (`results.ts`) — and never throws for what ARM said.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import type { ArmClient, ArmResult } from "./arm";
import { costs, resource, resourceGraph, subscriptionOf } from "./azure";
import type { AzureContext, Reach } from "./context";
import { failureText } from "./results";

/** Longer answers are cut here, with a note: a session's context is not a dump. */
const MAX_TEXT = 60_000;

function text(value: unknown, note = ""): string {
  const body = JSON.stringify(value, null, 1);
  const cut =
    body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n… cut at ${MAX_TEXT} characters` : body;
  return note === "" ? cut : `${note}\n${cut}`;
}

function arg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

/** Run `body` with the account's client and what it reaches, or say why not. */
async function withReach(
  context: AzureContext,
  body: (arm: ArmClient, reach: Reach[]) => Promise<string>,
): Promise<string> {
  const client = context.client();
  if (!client.ok) return failureText(client.failure);
  const reach = await context.reach(client.value);
  if (!reach.ok) return failureText(reach.failure);
  return body(client.value, reach.value);
}

function answer<T>(result: ArmResult<T>, render: (value: T) => string): string {
  return result.ok ? render(result.value) : failureText(result.failure);
}

/** The tenant a subscription is in, "" (the account's own) when it is not among the reached. */
function tenantFor(context: AzureContext, reach: Reach[], subscription: string): string {
  return context.tenantOf(reach, subscription)?.id ?? "";
}

function tenantsTool(context: AzureContext): ExtensionTool {
  return {
    name: "azure_tenants",
    description:
      "Lists the Azure tenants the reader's Microsoft account reaches, with how many subscriptions each gives and whether a tenant needs a fresh sign-in.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: () =>
      withReach(context, async (arm, reach) => {
        const dead = new Set(arm.tenantsNeedingSignIn());
        return text(
          reach.map((each) => ({
            tenant: each.tenant.id,
            name: each.tenant.name,
            domain: each.tenant.domain,
            subscriptions: each.subscriptions.length,
            ...(dead.has(each.tenant.id) || each.failure !== null
              ? {
                  problem:
                    each.failure === null ? "needs a fresh sign-in" : failureText(each.failure),
                }
              : {}),
          })),
          `Signed in as ${arm.connection.account}.`,
        );
      }),
  };
}

function subscriptionsTool(context: AzureContext): ExtensionTool {
  return {
    name: "azure_subscriptions",
    description:
      "Lists the Azure subscriptions the reader can reach, across every tenant (or one tenant, by id): name, id, state and tenant.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", description: "A tenant id to list only its subscriptions." },
      },
      additionalProperties: false,
    },
    call: (args) =>
      withReach(context, async (_arm, reach) => {
        const only = arg(args, "tenant");
        const rows = reach
          .filter((each) => only === "" || each.tenant.id === only)
          .flatMap((each) =>
            each.subscriptions.map((sub) => ({ ...sub, tenantName: each.tenant.name })),
          );
        return text(rows);
      }),
  };
}

function queryTool(context: AzureContext): ExtensionTool {
  return {
    name: "azure_query",
    description:
      "Runs an Azure Resource Graph query (KQL) over the reader's resources, e.g. `resources | where type =~ 'microsoft.web/sites' | project name, resourceGroup, location`. Tables: resources, resourcecontainers, advisorresources, healthresources and the rest of Resource Graph's. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        kql: { type: "string", description: "The Resource Graph query." },
        subscriptions: {
          type: "array",
          items: { type: "string" },
          description:
            "Subscription ids to query; left out, every one the account reaches in the tenant.",
        },
        tenant: {
          type: "string",
          description: "The tenant to query in; left out, the subscriptions' or the account's own.",
        },
        top: { type: "number", description: "At most this many rows (default 200, at most 5000)." },
      },
      required: ["kql"],
      additionalProperties: false,
    },
    call: (args) =>
      withReach(context, async (arm, reach) => {
        const kql = arg(args, "kql");
        if (kql === "") return "Give a KQL query in `kql`.";
        const subs = Array.isArray(args["subscriptions"])
          ? args["subscriptions"].filter((each): each is string => typeof each === "string")
          : [];
        const tenant = arg(args, "tenant") || tenantFor(context, reach, subs[0] ?? "");
        const top =
          typeof args["top"] === "number"
            ? Math.max(1, Math.min(5000, Math.floor(args["top"])))
            : 200;
        const result = await resourceGraph(arm, { query: kql, subscriptions: subs, tenant, top });
        return answer(result, (value) =>
          text(
            value.rows,
            `${value.rows.length} rows${value.truncated ? `, more exist: raise top or narrow the query` : ""}.`,
          ),
        );
      }),
  };
}

function getTool(context: AzureContext): ExtensionTool {
  return {
    name: "azure_get",
    description:
      "Reads one Azure resource whole by its ARM id (/subscriptions/…/resourceGroups/…/providers/…), with the newest stable api-version unless one is given.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The resource's ARM id." },
        apiVersion: { type: "string", description: "An api-version to read it with." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    call: (args) =>
      withReach(context, async (arm, reach) => {
        const id = arg(args, "id");
        if (!id.startsWith("/subscriptions/"))
          return "Give the resource's ARM id, starting /subscriptions/.";
        const tenant = tenantFor(context, reach, subscriptionOf(id));
        return answer(await resource(arm, id, arg(args, "apiVersion"), tenant), (value) =>
          text(value),
        );
      }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function costTool(context: AzureContext, now: () => number): ExtensionTool {
  return {
    name: "azure_cost",
    description:
      "Actual Azure cost of one subscription over a period (default the last 30 days): one row a day, or one row per resource group, service or resource with groupBy.",
    inputSchema: {
      type: "object",
      properties: {
        subscription: { type: "string", description: "The subscription id." },
        from: { type: "string", description: "First day, YYYY-MM-DD." },
        to: { type: "string", description: "Last day, YYYY-MM-DD." },
        groupBy: { type: "string", enum: ["ResourceGroup", "ServiceName", "ResourceId"] },
      },
      required: ["subscription"],
      additionalProperties: false,
    },
    call: (args) =>
      withReach(context, async (arm, reach) => {
        const subscription = arg(args, "subscription");
        const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const from = arg(args, "from") || day(now() - 30 * DAY_MS);
        const to = arg(args, "to") || day(now());
        const tenant = tenantFor(context, reach, subscription);
        const result = await costs(arm, {
          subscription,
          from,
          to,
          groupBy: arg(args, "groupBy"),
          tenant,
        });
        return answer(result, (value) =>
          text(value, `Actual cost of ${subscription}, ${from} to ${to}.`),
        );
      }),
  };
}

export function azureTools(context: AzureContext, now: () => number = Date.now): ExtensionTool[] {
  return [
    tenantsTool(context),
    subscriptionsTool(context),
    queryTool(context),
    getTool(context),
    costTool(context, now),
  ];
}

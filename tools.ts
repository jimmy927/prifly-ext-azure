/**
 * The tools every session sees as `mcp__prifly__azure_*`. The reads here run
 * at once; the writes (`writes.ts`) ask on a confirm card first. Each answers
 * text — JSON for rows, a sentence for a failure — and never throws for what
 * ARM said.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { costs, resource, resourceGraph, subscriptionOf } from "./azure";
import { docsTool } from "./docs";
import {
  answer,
  arg,
  emptySubscriptionSegment,
  type Kit,
  subscriptionsToAsk,
  tenantFor,
  withReach,
} from "./kit";
import { failureText, jsonText } from "./results";
import { waitTool } from "./wait";
import { apiTool, deleteTool, putTool } from "./writes";

function tenantsTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_tenants",
    description:
      "Lists the Azure tenants the reader's Microsoft account reaches, with how many subscriptions each gives and whether a tenant needs a fresh sign-in.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: () =>
      withReach(kit, async (arm, reach) => {
        const dead = new Set(arm.tenantsNeedingSignIn());
        return jsonText(
          reach.map((each) => ({
            tenant: each.tenant.id,
            name: each.tenant.name,
            domain: each.tenant.domain,
            subscriptions: each.subscriptions.length,
            ...(dead.has(each.tenant.id) || each.failure !== null
              ? {
                  problem: `${
                    each.failure === null ? "needs a fresh sign-in" : failureText(each.failure)
                  } Call azure_subscriptions with this tenant to open its sign-in page.`,
                }
              : {}),
          })),
          `Signed in as ${arm.connection.account}.`,
        );
      }),
  };
}

function subscriptionsTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_subscriptions",
    description:
      "Lists the Azure subscriptions the reader can reach, across every tenant (or one tenant, by id): name, id, state and tenant. Given a tenant whose sign-in ended, it opens that tenant's sign-in page.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", description: "A tenant id to list only its subscriptions." },
      },
      additionalProperties: false,
    },
    call: (args) =>
      withReach(kit, async (_arm, reach) => {
        const only = arg(args, "tenant");
        const failed = reach.find((each) => each.tenant.id === only)?.failure ?? null;
        if (only !== "" && failed !== null) return kit.access.explain(failed);
        const rows = reach
          .filter((each) => only === "" || each.tenant.id === only)
          .flatMap((each) =>
            each.subscriptions.map((sub) => ({ ...sub, tenantName: each.tenant.name })),
          );
        return jsonText(rows);
      }),
  };
}

function queryTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_query",
    description:
      "Runs an Azure Resource Graph query (KQL) over the reader's resources, e.g. `resources | where type =~ 'microsoft.compute/virtualmachines' | project name, resourceGroup, location`. Tables: resources, resourcecontainers, advisorresources, healthresources and the rest of Resource Graph's. A read: runs at once.",
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
      withReach(kit, async (arm, reach) => {
        const kql = arg(args, "kql");
        if (kql === "") return "Give a KQL query in `kql`.";
        const subs = Array.isArray(args["subscriptions"])
          ? args["subscriptions"]
              .filter((each): each is string => typeof each === "string")
              .map((each) => each.trim())
              .filter((each) => each !== "")
          : [];
        const tenant = arg(args, "tenant") || tenantFor(kit, reach, subs[0] ?? "");
        const top =
          typeof args["top"] === "number"
            ? Math.max(1, Math.min(5000, Math.floor(args["top"])))
            : 200;
        const result = await resourceGraph(arm, { query: kql, subscriptions: subs, tenant, top });
        return answer(kit, result, (value) =>
          jsonText(
            value.rows,
            `${value.rows.length} rows${value.truncated ? `, more exist: raise top or narrow the query` : ""}.`,
          ),
        );
      }),
  };
}

function getTool(kit: Kit): ExtensionTool {
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
      withReach(kit, async (arm, reach) => {
        const id = arg(args, "id");
        if (!id.startsWith("/subscriptions/"))
          return "Give the resource's ARM id, starting /subscriptions/.";
        const empty = emptySubscriptionSegment(id);
        if (empty !== null) return empty;
        const tenant = tenantFor(kit, reach, subscriptionOf(id));
        return answer(kit, await resource(arm, id, arg(args, "apiVersion"), tenant), (value) =>
          jsonText(value),
        );
      }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function costTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_cost",
    description:
      "Actual Azure cost (the billing so far) over a period (default the last 30 days): one row a day, or one row per resource group, service or resource with groupBy. Of one subscription, or, with no subscription given, of every subscription the account reaches (one block each, headed by its name and id).",
    inputSchema: {
      type: "object",
      properties: {
        subscription: {
          type: "string",
          description: "The subscription id; left out, every subscription the account reaches.",
        },
        from: { type: "string", description: "First day, YYYY-MM-DD." },
        to: { type: "string", description: "Last day, YYYY-MM-DD." },
        groupBy: { type: "string", enum: ["ResourceGroup", "ServiceName", "ResourceId"] },
      },
      additionalProperties: false,
    },
    call: (args) =>
      withReach(kit, async (arm, reach) => {
        const asked = subscriptionsToAsk(reach, arg(args, "subscription"));
        if (typeof asked === "string") return asked;
        const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const from = arg(args, "from") || day(kit.now() - 30 * DAY_MS);
        const to = arg(args, "to") || day(kit.now());
        const blocks: string[] = [];
        for (const sub of asked) {
          const result = await costs(arm, {
            subscription: sub.id,
            from,
            to,
            groupBy: arg(args, "groupBy"),
            tenant: tenantFor(kit, reach, sub.id),
          });
          blocks.push(
            answer(kit, result, (value) =>
              jsonText(value, `Actual cost of ${sub.id}, ${from} to ${to}.`),
            ),
          );
        }
        const [only] = blocks;
        if (blocks.length === 1 && only !== undefined) return only;
        return blocks
          .map((block, index) => `## ${asked[index]?.name} (${asked[index]?.id})\n${block}`)
          .join("\n\n");
      }),
  };
}

export function azureTools(kit: Kit): ExtensionTool[] {
  return [
    tenantsTool(kit),
    subscriptionsTool(kit),
    queryTool(kit),
    getTool(kit),
    costTool(kit),
    putTool(kit),
    deleteTool(kit),
    apiTool(kit),
    waitTool(kit),
    docsTool(kit),
  ];
}

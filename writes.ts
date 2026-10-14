/**
 * The tools that can change Azure, and the one that reaches any ARM endpoint.
 * Every PUT, PATCH and DELETE, and every POST not on `READ_POSTS`, is shown on
 * a confirm card first (`api.confirm`) with its method, full URL and body;
 * cancelled, nothing is sent and the tool answers `CANCELLED`.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { ARM, ARM_METHODS, type ArmClient, type ArmMethod, type ArmReply } from "./arm";
import { apiVersionFor, subscriptionOf, typeOf } from "./azure";
import { arg, emptySubscriptionSegment, type Kit, tenantFor, withReach } from "./kit";
import { jsonText } from "./results";

export const CANCELLED = "Not done: you cancelled";

/** POSTs that only read, and so run without a card: Resource Graph and Cost Management queries. */
export const READ_POSTS: readonly RegExp[] = [
  /\/providers\/microsoft\.resourcegraph\/resources$/i,
  /\/providers\/microsoft\.costmanagement\/(query|forecast)$/i,
];

/** Whether a call changes something, and so waits for the reader's Confirm. */
export function needsConfirm(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return false;
  if (verb !== "POST") return true;
  const bare = (path.split("?")[0] ?? "").replace(/\/+$/, "");
  return !READ_POSTS.some((pattern) => pattern.test(bare));
}

/** An ARM path or a full https://management.azure.com URL as a URL; anything else, why not. */
export function armUrl(given: string): URL | string {
  const raw = given.trim();
  let url: URL;
  try {
    if (raw.startsWith("/")) url = new URL(`${ARM}${raw}`);
    else if (/^https:\/\//i.test(raw)) url = new URL(raw);
    else return "Give an ARM path starting with / or a full https://management.azure.com URL.";
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return `Not a URL: ${raw}`;
  }
  if (url.protocol !== "https:" || url.host.toLowerCase() !== "management.azure.com") {
    return `Only Azure Resource Manager (https://management.azure.com) is reached here, not ${url.host}.`;
  }
  return emptySubscriptionSegment(url.pathname) ?? url;
}

/** The URL of the operation an accepted call runs on, "" when it finished at once. */
function operationOf(reply: ArmReply): string {
  if (reply.status !== 201 && reply.status !== 202) return "";
  return reply.headers["azure-asyncoperation"] ?? reply.headers["location"] ?? "";
}

function replyText(reply: ArmReply): string {
  const operation = operationOf(reply);
  const retryAfter = reply.headers["retry-after"];
  const head =
    operation === ""
      ? `Azure answered ${reply.status}.`
      : `Azure answered ${reply.status}: accepted and still running. Follow it with azure_wait_operation, url ${operation}`;
  return jsonText(
    {
      status: reply.status,
      ...(operation === "" ? {} : { operation }),
      ...(retryAfter === undefined ? {} : { retryAfter }),
      body: reply.body,
    },
    head,
  );
}

type Call = { method: ArmMethod; url: URL; body: unknown; tenant: string };

/** Send one call, asking first when it changes something. */
async function send(
  kit: Kit,
  arm: ArmClient,
  call: Call,
  card: { title: string; summary: string },
): Promise<string> {
  const path = `${call.url.pathname}${call.url.search}`;
  if (needsConfirm(call.method, call.url.pathname)) {
    if (kit.confirm === undefined) {
      return "Not done: this prifly cannot show a confirm card for a change (update prifly), so nothing was sent.";
    }
    const body =
      call.body === undefined ? "(no body)" : (JSON.stringify(call.body, null, 2) ?? "null");
    const details = `${call.method} ${call.url.toString()}\n\n${body}`;
    if (!(await kit.confirm({ ...card, details }))) return CANCELLED;
  }
  const sent = await arm.send(path, {
    method: call.method,
    tenant: call.tenant,
    ...(call.body === undefined ? {} : { body: call.body }),
  });
  return sent.ok ? replyText(sent.value) : kit.access.explain(sent.failure);
}

function bodyArg(args: Record<string, unknown>): unknown {
  return "body" in args && args["body"] !== null ? args["body"] : undefined;
}

export function apiTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_api",
    description:
      "Calls any Azure Resource Manager endpoint with the reader's Microsoft connection: method, an ARM path (/subscriptions/…) or full https://management.azure.com URL, api-version, query and JSON body. GET and HEAD, and Resource Graph and Cost Management query POSTs, run at once; every other call (PUT, PATCH, DELETE, any other POST, listKeys included) is shown to the reader on a confirm card first and is not sent if they cancel. A 201 or 202 with an operation URL is still running: follow it with azure_wait_operation. Use azure_api_docs first to find the api-version and body shape of an unfamiliar call.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...ARM_METHODS], description: "Default GET." },
        path: {
          type: "string",
          description: "An ARM path starting with /, or a full https://management.azure.com URL.",
        },
        apiVersion: {
          type: "string",
          description: "The api-version; needed unless the path already has one.",
        },
        query: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean"] },
          description: 'More query parameters, e.g. {"$filter": "…"}.',
        },
        body: { description: "The JSON body, for PUT, PATCH and POST." },
        tenant: {
          type: "string",
          description: "The tenant to call in; left out, the path's subscription's.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    call: async (args) => {
      const method = (arg(args, "method") || "GET").toUpperCase();
      const known = ARM_METHODS.find((each) => each === method);
      if (known === undefined) return `method must be one of ${ARM_METHODS.join(", ")}.`;
      const url = armUrl(arg(args, "path"));
      if (typeof url === "string") return url;
      const query = args["query"];
      if (typeof query === "object" && query !== null) {
        for (const [name, value] of Object.entries(query))
          url.searchParams.set(name, String(value));
      }
      const version = arg(args, "apiVersion");
      if (version !== "") url.searchParams.set("api-version", version);
      if (!url.searchParams.has("api-version")) {
        return "Give apiVersion: azure_api_docs finds the newest one for a provider and resource type.";
      }
      return withReach(kit, (arm, reach) => {
        const tenant = arg(args, "tenant") || tenantFor(kit, reach, subscriptionOf(url.pathname));
        const call = { method: known, url, body: bodyArg(args), tenant };
        return send(kit, arm, call, {
          title: "Azure API call",
          summary: `${known} ${url.pathname}`,
        });
      });
    },
  };
}

/** "Microsoft.Storage/storageAccounts mystore in rg-data": what a card names. */
function named(id: string): string {
  const kind = typeOf(id);
  const name =
    id
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? id;
  const group = /\/resourcegroups\/([^/]+)/i.exec(id)?.[1];
  const what = kind === null ? "" : `${kind.namespace}/${kind.type} `;
  return `${what}${name}${group === undefined ? "" : ` in ${group}`}`;
}

const ID_PROPERTY = {
  type: "string",
  description: "The resource's ARM id, /subscriptions/…/resourceGroups/…/providers/….",
};
const VERSION_PROPERTY = {
  type: "string",
  description:
    "The api-version; left out, the newest stable one ARM lists for the type. azure_api_docs shows the body it takes.",
};

/** A change to one resource by its id: the card, then the call. */
function resourceChange(
  kit: Kit,
  args: Record<string, unknown>,
  method: "PUT" | "DELETE",
  card: (id: string) => { title: string; summary: string },
): Promise<string> {
  return withReach(kit, async (arm, reach) => {
    const id = arg(args, "id");
    const empty = emptySubscriptionSegment(id);
    if (empty !== null) return empty;
    const tenant = tenantFor(kit, reach, subscriptionOf(id));
    const given = arg(args, "apiVersion");
    const version = given === "" ? await apiVersionFor(arm, id, tenant) : null;
    if (version !== null && !version.ok) return kit.access.explain(version.failure);
    const url = armUrl(id);
    if (typeof url === "string") return url;
    url.searchParams.set("api-version", version?.value ?? given);
    const body = method === "PUT" ? args["body"] : undefined;
    return send(kit, arm, { method, url, body, tenant }, card(id));
  });
}

export function putTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_put_resource",
    description:
      "Creates or updates one Azure resource (ARM PUT) by its id, with the JSON body the resource type takes (location, sku, kind, properties, tags…). The reader sees the call on a confirm card first; cancelled, nothing is sent. A 201 or 202 with an operation URL is still running: follow it with azure_wait_operation.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID_PROPERTY,
        apiVersion: VERSION_PROPERTY,
        body: { type: "object", description: "The resource as ARM takes it." },
      },
      required: ["id", "body"],
      additionalProperties: false,
    },
    call: async (args) => {
      if (!arg(args, "id").startsWith("/subscriptions/")) {
        return "Give the resource's ARM id, starting /subscriptions/.";
      }
      const body = args["body"];
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return "Give the resource's JSON as an object in body.";
      }
      return resourceChange(kit, args, "PUT", (id) => ({
        title: "Create or update an Azure resource",
        summary: `Create or update ${named(id)}`,
      }));
    },
  };
}

export function deleteTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_delete_resource",
    description:
      "Deletes one Azure resource (ARM DELETE) by its id. The reader sees the call on a confirm card first; cancelled, nothing is sent. A 202 with an operation URL is still running: follow it with azure_wait_operation.",
    inputSchema: {
      type: "object",
      properties: { id: ID_PROPERTY, apiVersion: VERSION_PROPERTY },
      required: ["id"],
      additionalProperties: false,
    },
    call: async (args) => {
      if (!arg(args, "id").startsWith("/subscriptions/")) {
        return "Give the resource's ARM id, starting /subscriptions/.";
      }
      return resourceChange(kit, args, "DELETE", (id) => ({
        title: "Delete an Azure resource",
        summary: `Delete ${named(id)}`,
      }));
    },
  };
}

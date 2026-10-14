/**
 * What this extension reads from Azure, each one ARM call or a short run of
 * them, read tolerantly: a field ARM leaves out reads as "" rather than
 * failing the whole answer.
 */

import type { ArmClient, ArmResult } from "./arm";

export type Tenant = { id: string; name: string; domain: string };
export type Subscription = { id: string; name: string; state: string; tenant: string };

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mapped<T, U>(result: ArmResult<T>, map: (value: T) => U): ArmResult<U> {
  return result.ok ? { ok: true, value: map(result.value) } : result;
}

/** The tenants the account reaches, its home tenant among them. */
export async function tenants(arm: ArmClient): Promise<ArmResult<Tenant[]>> {
  const listed = await arm.list("/tenants?api-version=2022-12-01");
  return mapped(listed, (rows) =>
    rows.map((row) => {
      const each = obj(row);
      return {
        id: str(each["tenantId"]),
        name: str(each["displayName"]) || str(each["defaultDomain"]) || str(each["tenantId"]),
        domain: str(each["defaultDomain"]),
      };
    }),
  );
}

/** The subscriptions one tenant gives the account. */
export async function subscriptions(
  arm: ArmClient,
  tenant: string,
): Promise<ArmResult<Subscription[]>> {
  const listed = await arm.list("/subscriptions?api-version=2022-12-01", { tenant });
  return mapped(listed, (rows) =>
    rows.map((row) => {
      const each = obj(row);
      return {
        id: str(each["subscriptionId"]),
        name: str(each["displayName"]),
        state: str(each["state"]),
        tenant: str(each["tenantId"]) || tenant,
      };
    }),
  );
}

export type GraphQuery = { query: string; subscriptions: string[]; tenant: string; top: number };

/** A Resource Graph (KQL) query, every page up to `top` rows; `truncated` when there were more. */
export async function resourceGraph(
  arm: ArmClient,
  ask: GraphQuery,
): Promise<ArmResult<{ rows: Json[]; truncated: boolean }>> {
  const rows: Json[] = [];
  let skipToken = "";
  for (;;) {
    const options: Json = {
      resultFormat: "objectArray",
      $top: Math.min(1000, ask.top - rows.length),
    };
    if (skipToken !== "") options["$skipToken"] = skipToken;
    const body: Json = { query: ask.query, options };
    if (ask.subscriptions.length > 0) body["subscriptions"] = ask.subscriptions;
    const page = await arm.request(
      "/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
      {
        method: "POST",
        tenant: ask.tenant,
        body,
      },
    );
    if (!page.ok) return page;
    const answer = obj(page.value);
    const data = Array.isArray(answer["data"]) ? answer["data"] : [];
    rows.push(...data.map(obj));
    skipToken = str(answer["$skipToken"]);
    if (skipToken === "" || rows.length >= ask.top) {
      return { ok: true, value: { rows: rows.slice(0, ask.top), truncated: skipToken !== "" } };
    }
  }
}

/** The provider namespace and resource type an ARM id names: `Microsoft.Web`, `sites/slots`. */
export function typeOf(id: string): { namespace: string; type: string } | null {
  const parts = id.split("/").filter((part) => part !== "");
  const at = parts.map((part) => part.toLowerCase()).lastIndexOf("providers");
  const namespace = parts[at + 1];
  if (at < 0 || namespace === undefined) return null;
  const rest = parts.slice(at + 2);
  const type = rest.filter((_, index) => index % 2 === 0).join("/");
  return type === "" ? null : { namespace, type };
}

/** The subscription an ARM id is in, or "". */
export function subscriptionOf(id: string): string {
  return /\/subscriptions\/([^/]+)/i.exec(id)?.[1] ?? "";
}

/** The newest stable api-version ARM offers for the type `id` names (preview only when nothing else). */
export async function apiVersionFor(
  arm: ArmClient,
  id: string,
  tenant: string,
): Promise<ArmResult<string>> {
  const kind = typeOf(id);
  if (kind === null) {
    // A subscription or a resource group: no provider to ask.
    const group = /\/resourcegroups\/[^/]+\/?$/i.test(id);
    return { ok: true, value: group ? "2021-04-01" : "2022-12-01" };
  }
  const sub = subscriptionOf(id);
  const read = await arm.request(
    `/subscriptions/${sub}/providers/${kind.namespace}?api-version=2021-04-01`,
    { tenant },
  );
  if (!read.ok) return read;
  const types = Array.isArray(obj(read.value)["resourceTypes"])
    ? (obj(read.value)["resourceTypes"] as unknown[])
    : [];
  const match = types
    .map(obj)
    .find((each) => str(each["resourceType"]).toLowerCase() === kind.type.toLowerCase());
  const versions = Array.isArray(match?.["apiVersions"])
    ? (match["apiVersions"] as unknown[]).map(str)
    : [];
  const chosen = [...versions].sort().reverse();
  const stable = chosen.find((version) => !version.includes("preview")) ?? chosen[0];
  if (stable === undefined) {
    return {
      ok: false,
      failure: {
        kind: "failed",
        status: 404,
        code: "NoApiVersion",
        message: `ARM lists no api-version for ${kind.namespace}/${kind.type}.`,
      },
    };
  }
  return { ok: true, value: stable };
}

/** One resource read whole, by its ARM id. */
export async function resource(
  arm: ArmClient,
  id: string,
  apiVersion: string,
  tenant: string,
): Promise<ArmResult<Json>> {
  const version =
    apiVersion === ""
      ? await apiVersionFor(arm, id, tenant)
      : { ok: true as const, value: apiVersion };
  if (!version.ok) return version;
  const read = await arm.request(`${id}?api-version=${encodeURIComponent(version.value)}`, {
    tenant,
  });
  return mapped(read, obj);
}

export type CostAsk = {
  subscription: string;
  from: string;
  to: string;
  groupBy: string;
  tenant: string;
};

/** Actual cost over a period: one row a day, or one per group (`ResourceGroup`, `ServiceName`). */
export async function costs(
  arm: ArmClient,
  ask: CostAsk,
): Promise<ArmResult<{ columns: string[]; rows: unknown[][] }>> {
  const dataset: Json = {
    granularity: ask.groupBy === "" ? "Daily" : "None",
    aggregation: { totalCost: { name: "Cost", function: "Sum" } },
  };
  if (ask.groupBy !== "") dataset["grouping"] = [{ type: "Dimension", name: ask.groupBy }];
  const read = await arm.request(
    `/subscriptions/${ask.subscription}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
    {
      method: "POST",
      tenant: ask.tenant,
      body: {
        type: "ActualCost",
        timeframe: "Custom",
        timePeriod: { from: ask.from, to: ask.to },
        dataset,
      },
    },
  );
  return mapped(read, (value) => {
    const properties = obj(obj(value)["properties"]);
    const columns = Array.isArray(properties["columns"])
      ? properties["columns"].map((column) => str(obj(column)["name"]))
      : [];
    const rows = Array.isArray(properties["rows"]) ? properties["rows"].filter(Array.isArray) : [];
    return { columns, rows: rows as unknown[][] };
  });
}

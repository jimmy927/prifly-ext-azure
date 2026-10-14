/**
 * A fake Azure Resource Manager behind a fake `api.connections`, for this
 * extension's tests. Two tenants — Northwind (the account's own) and Contoso
 * (a guest tenant) — with a subscription each, ARM's own payload shapes, a
 * storage account to create and delete, and switches for what goes wrong: a
 * tenant whose sign-in ended, a 429, an ARM error body. Every request is kept
 * with the tenant it was sent for, and every sign-in asked for.
 */

import type {
  ExtensionConnection,
  ExtensionConnectionsApi,
  ExtensionFetchOptions,
} from "@prifly/extension-api";
import { ARM_SCOPE } from "../arm";

export const HOME = "t-home";
export const GUEST = "t-guest";
export const SUB_PROD = "sub-prod";
export const SUB_GUEST = "sub-guest";
export const APP_ID = `/subscriptions/${SUB_PROD}/resourceGroups/rg-shop-prod/providers/Microsoft.Web/sites/app-checkout-api`;
export const STORAGE_ID = `/subscriptions/${SUB_PROD}/resourceGroups/rg-data/providers/Microsoft.Storage/storageAccounts/stdata`;
export const ASYNC_OP = `https://management.azure.com/subscriptions/${SUB_PROD}/providers/Microsoft.Storage/locations/westeurope/asyncoperations/op-1?api-version=2023-05-01`;
export const LOCATION_OP = `https://management.azure.com/subscriptions/${SUB_PROD}/providers/Microsoft.Storage/locations/westeurope/operationresults/op-2?api-version=2023-05-01`;

export type Sent = { method: string; path: string; tenant: string; body: unknown };

export type FakeArmOptions = {
  /** The account's granted scopes; left out, User.Read and Azure. */
  scopes?: string[];
  /** No Microsoft account at all. */
  none?: boolean;
  /** The whole account's sign-in ended. */
  ended?: boolean;
  /** Tenants whose sign-in ended; `fetch` answers needsSignIn for them. */
  deadTenants?: string[];
  /** An older prifly: needsSignIn carries no tenant. */
  oldHost?: boolean;
  /** Answer a path (method + path, query included) with this instead, before the fake's own. */
  override?: (sent: Sent) => Response | null;
};

export type FakeArm = {
  connections: ExtensionConnectionsApi;
  sent: Sent[];
  signIns: { scopes: string[]; options: Record<string, unknown> }[];
  /** Paths sent, without query, in order. */
  paths: () => string[];
  /** The requests that were not GET. */
  writes: () => Sent[];
};

const json = (value: unknown, init?: ResponseInit) => Response.json(value, init);

function tenants(): Response {
  return json({
    value: [
      { tenantId: HOME, displayName: "Northwind Retail", defaultDomain: "northwind.example" },
      { tenantId: GUEST, displayName: "Contoso Labs", defaultDomain: "contoso.example" },
    ],
  });
}

function subscriptions(tenant: string): Response {
  const sub =
    tenant === GUEST
      ? {
          subscriptionId: SUB_GUEST,
          displayName: "Contoso Sandbox",
          state: "Enabled",
          tenantId: GUEST,
        }
      : {
          subscriptionId: SUB_PROD,
          displayName: "Shop Production",
          state: "Enabled",
          tenantId: HOME,
        };
  return json({ value: [sub] });
}

const RESOURCES = [
  {
    id: APP_ID,
    name: "app-checkout-api",
    type: "microsoft.web/sites",
    resourceGroup: "rg-shop-prod",
    location: "westeurope",
    tags: { env: "prod" },
  },
  {
    id: `/subscriptions/${SUB_PROD}/resourceGroups/rg-shop-prod/providers/Microsoft.Sql/servers/sql-shop-prod`,
    name: "sql-shop-prod",
    type: "microsoft.sql/servers",
    resourceGroup: "rg-shop-prod",
    location: "westeurope",
    tags: {},
  },
];

function storage(sent: Sent): Response {
  if (sent.method === "PUT") {
    return json(
      { id: STORAGE_ID, name: "stdata", properties: { provisioningState: "Creating" } },
      { status: 201, headers: { "Azure-AsyncOperation": ASYNC_OP, "Retry-After": "5" } },
    );
  }
  if (sent.method === "DELETE") {
    return new Response(null, { status: 202, headers: { Location: LOCATION_OP } });
  }
  return json({ id: STORAGE_ID, name: "stdata", properties: { provisioningState: "Succeeded" } });
}

function route(sent: Sent): Response {
  const path = sent.path.split("?")[0] ?? "";
  if (path === "/tenants") return tenants();
  if (path === "/subscriptions") return subscriptions(sent.tenant);
  if (path === "/providers/Microsoft.ResourceGraph/resources") {
    return json({ data: RESOURCES, totalRecords: RESOURCES.length });
  }
  if (path.endsWith("/providers/Microsoft.Web")) {
    return json({
      resourceTypes: [
        { resourceType: "sites", apiVersions: ["2025-01-01-preview", "2024-04-01", "2023-12-01"] },
      ],
    });
  }
  if (path.endsWith("/providers/Microsoft.Storage")) {
    return json({
      resourceTypes: [
        { resourceType: "storageAccounts", apiVersions: ["2023-05-01", "2023-01-01"] },
      ],
    });
  }
  if (path === APP_ID)
    return json({
      id: APP_ID,
      name: "app-checkout-api",
      location: "westeurope",
      properties: { state: "Running" },
    });
  if (path === STORAGE_ID) return storage(sent);
  if (path.endsWith("/listKeys")) return json({ keys: [{ keyName: "key1", value: "secret" }] });
  if (path.endsWith("/providers/Microsoft.CostManagement/query")) {
    return json({
      properties: { columns: [{ name: "Cost" }, { name: "UsageDate" }], rows: [[12.5, 20261010]] },
    });
  }
  if (path.endsWith("/providers/Microsoft.CostManagement/forecast")) {
    return json({ properties: { columns: [{ name: "Cost" }], rows: [[40]] } });
  }
  return json(
    { error: { code: "ResourceNotFound", message: `No ${path} in the fake.` } },
    { status: 404 },
  );
}

export function fakeArm(options: FakeArmOptions = {}): FakeArm {
  const sent: Sent[] = [];
  const signIns: FakeArm["signIns"] = [];
  const dead = new Set(options.deadTenants ?? []);
  let ended = options.ended === true;
  let none = options.none === true;
  const scopes = options.scopes ?? ["User.Read", ARM_SCOPE];
  const account: ExtensionConnection = {
    id: "ms-1",
    provider: "microsoft",
    account: "jimmy@northwind.example",
    client: "prifly",
    scopes,
    state: "ok",
  };
  const connections: ExtensionConnectionsApi = {
    list: () =>
      none
        ? []
        : [
            {
              ...account,
              scopes: [...account.scopes],
              state: ended ? "needs-sign-in" : "ok",
              tenantsNeedingSignIn: options.oldHost === true ? undefined : [...dead],
            } as ExtensionConnection,
          ],
    async fetch(_id, request, how: ExtensionFetchOptions = {}) {
      const url = new URL(typeof request === "string" ? request : request.url);
      const tenant = how.tenant ?? "";
      if (dead.has(tenant)) {
        const gone = { connection: account.id, provider: "microsoft", account: account.account };
        return { needsSignIn: options.oldHost === true ? gone : { ...gone, tenant } };
      }
      const body = typeof how.body === "string" ? JSON.parse(how.body) : null;
      const one: Sent = {
        method: how.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        tenant,
        body,
      };
      sent.push(one);
      return options.override?.(one) ?? route(one);
    },
    async token() {
      return { token: "fake" };
    },
    async signIn(_provider, asked, how = {}) {
      signIns.push({ scopes: [...asked], options: { ...how } });
      for (const scope of asked) if (!account.scopes.includes(scope)) account.scopes.push(scope);
      const tenant = (how as { tenant?: string }).tenant;
      if (tenant !== undefined) dead.delete(tenant);
      ended = false;
      none = false;
      return { ok: true, connection: account.id, account: account.account };
    },
  };
  return {
    connections,
    sent,
    signIns,
    paths: () => sent.map((each) => each.path.split("?")[0] ?? ""),
    writes: () => sent.filter((each) => each.method !== "GET"),
  };
}

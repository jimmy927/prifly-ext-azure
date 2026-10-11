/**
 * A fake Azure Resource Manager behind a fake `api.connections`, for this
 * extension's tests. Two tenants — Northwind (the account's own) and Contoso
 * (a guest tenant) — with a subscription each, ARM's own payload shapes, and
 * switches for what goes wrong: a tenant whose sign-in ended, a 429, an ARM
 * error body. Every request is kept with the tenant it was sent for.
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
export const DEPLOY_ID = `/subscriptions/${SUB_PROD}/resourceGroups/rg-shop-prod/providers/Microsoft.Resources/deployments/checkout-api-2026`;

export type Sent = { method: string; path: string; tenant: string; body: unknown };

export type FakeArmOptions = {
  /** The account's granted scopes; left out, User.Read and Azure. */
  scopes?: string[];
  /** No Microsoft account at all. */
  none?: boolean;
  /** Tenants whose sign-in ended; `fetch` answers needsSignIn for them. */
  deadTenants?: string[];
  /** An older prifly: needsSignIn carries no tenant. */
  oldHost?: boolean;
  /** Answer a path (method + path, query included) with this instead, before the fake's own. */
  override?: (sent: Sent) => Response | null;
  /** The deployment failures, by resource group; read on every request, so a test may change it. */
  failures?: () => Record<string, { name: string; timestamp: string; message: string }[]>;
};

export type FakeArm = {
  connections: ExtensionConnectionsApi;
  sent: Sent[];
  signIns: { scopes: string[]; options: Record<string, unknown> }[];
  /** Paths sent, without query, in order. */
  paths: () => string[];
};

const json = (value: unknown) => Response.json(value);

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
  {
    id: `/subscriptions/${SUB_PROD}/resourceGroups/rg-signing/providers/Microsoft.CodeSigning/codeSigningAccounts/ts-signing`,
    name: "ts-signing",
    type: "microsoft.codesigning/codesigningaccounts",
    resourceGroup: "rg-signing",
    location: "westeurope",
    tags: {},
  },
];

function graph(body: unknown): Response {
  const query = String((body as { query?: unknown }).query ?? "");
  if (query.startsWith("resourcecontainers")) {
    return json({
      data: [
        { name: "rg-shop-prod", subscriptionId: SUB_PROD },
        { name: "rg-signing", subscriptionId: SUB_PROD },
      ],
    });
  }
  return json({ data: RESOURCES, totalRecords: RESOURCES.length });
}

function deploymentList(path: string, failures: FakeArmOptions["failures"]): Response {
  const group = /resourcegroups\/([^/]+)/i.exec(path)?.[1] ?? "";
  const failedOnly = path.includes("provisioningState");
  const failed = (failures?.()[group] ?? []).map((each) => ({
    id: `/subscriptions/${SUB_PROD}/resourceGroups/${group}/providers/Microsoft.Resources/deployments/${each.name}`,
    name: each.name,
    properties: {
      provisioningState: "Failed",
      timestamp: each.timestamp,
      error: {
        code: "DeploymentFailed",
        message: "outer",
        details: [{ code: "Conflict", message: each.message }],
      },
    },
  }));
  const ok = failedOnly
    ? []
    : [
        {
          id: "ok-1",
          name: "nightly",
          properties: { provisioningState: "Succeeded", timestamp: "2026-10-10T02:00:00Z" },
        },
      ];
  return json({ value: [...failed, ...ok] });
}

function route(sent: Sent, options: FakeArmOptions): Response {
  const path = sent.path.split("?")[0] ?? "";
  if (path === "/tenants") return tenants();
  if (path === "/subscriptions") return subscriptions(sent.tenant);
  if (path === "/providers/Microsoft.ResourceGraph/resources") return graph(sent.body);
  if (path.endsWith("/providers/Microsoft.Resources/deployments"))
    return deploymentList(sent.path, options.failures);
  if (path.endsWith("/operations"))
    return json({
      value: [
        {
          properties: {
            provisioningState: "Failed",
            targetResource: { id: APP_ID },
            statusMessage: { error: { code: "Conflict", message: "plan at its limit" } },
          },
        },
      ],
    });
  if (path.endsWith("/providers/Microsoft.Web")) {
    return json({
      resourceTypes: [
        { resourceType: "sites", apiVersions: ["2025-01-01-preview", "2024-04-01", "2023-12-01"] },
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
  if (path === DEPLOY_ID)
    return json({
      id: DEPLOY_ID,
      name: "checkout-api-2026",
      properties: { provisioningState: "Failed" },
    });
  if (path.endsWith("/eventtypes/management/values")) {
    return json({
      value: [
        {
          eventTimestamp: "2026-10-11T08:40:00Z",
          operationName: { localizedValue: "Update website" },
          status: { value: "Failed" },
          caller: "ci@northwind.example",
        },
      ],
    });
  }
  if (path.endsWith("/providers/Microsoft.CostManagement/query")) {
    return json({
      properties: { columns: [{ name: "Cost" }, { name: "UsageDate" }], rows: [[12.5, 20261010]] },
    });
  }
  return Response.json(
    { error: { code: "ResourceNotFound", message: `No ${path} in the fake.` } },
    { status: 404 },
  );
}

export function fakeArm(options: FakeArmOptions = {}): FakeArm {
  const sent: Sent[] = [];
  const signIns: FakeArm["signIns"] = [];
  const dead = new Set(options.deadTenants ?? []);
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
      options.none === true
        ? []
        : [
            {
              ...account,
              scopes: [...account.scopes],
              tenantsNeedingSignIn: options.oldHost === true ? undefined : [...dead],
            } as ExtensionConnection,
          ],
    async fetch(_id, request, how: ExtensionFetchOptions = {}) {
      const url = new URL(typeof request === "string" ? request : request.url);
      const tenant = how.tenant ?? "";
      if (dead.has(tenant)) {
        const ended = { connection: account.id, provider: "microsoft", account: account.account };
        return { needsSignIn: options.oldHost === true ? ended : { ...ended, tenant } };
      }
      const body = typeof how.body === "string" ? JSON.parse(how.body) : null;
      const one: Sent = {
        method: how.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        tenant,
        body,
      };
      sent.push(one);
      return options.override?.(one) ?? route(one, options);
    },
    async token() {
      return { token: "fake" };
    },
    async signIn(_provider, asked, how = {}) {
      signIns.push({ scopes: [...asked], options: { ...how } });
      for (const scope of asked) if (!account.scopes.includes(scope)) account.scopes.push(scope);
      const tenant = (how as { tenant?: string }).tenant;
      if (tenant !== undefined) dead.delete(tenant);
      return { ok: true, connection: account.id, account: account.account };
    },
  };
  return {
    connections,
    sent,
    signIns,
    paths: () => sent.map((each) => each.path.split("?")[0] ?? ""),
  };
}

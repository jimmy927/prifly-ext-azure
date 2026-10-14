import { afterEach, expect, test } from "bun:test";
import type { ExtensionModule } from "@prifly/extension-api";
import { Access } from "../access";
import { ARM_SCOPE } from "../arm";
import { typeOf } from "../azure";
import { AzureContext } from "../context";
import * as extension from "../index";
import { fakeApi } from "./fake-api";
import { APP_ID, fakeArm, GUEST, HOME, SUB_GUEST, SUB_PROD } from "./fake-arm";
import { harness } from "./harness";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

let stop: (() => void) | undefined;
afterEach(() => stop?.());

test("activate registers the read, write, raw API and docs tools", async () => {
  const fake = fakeApi({ connections: fakeArm({ none: true }).connections });
  stop = (await module.activate(fake.api)) ?? undefined;
  expect(fake.tools().map((tool) => tool.name)).toEqual([
    "azure_tenants",
    "azure_subscriptions",
    "azure_query",
    "azure_get",
    "azure_cost",
    "azure_put_resource",
    "azure_delete_resource",
    "azure_api",
    "azure_wait_operation",
    "azure_api_docs",
  ]);
  expect(fake.shown).toEqual([]);
  expect(fake.flags.size).toBe(0);
  await Bun.sleep(1);
  expect(fake.statuses).toEqual([
    "Not connected: no Microsoft account; ask a session for anything in Azure to connect one",
  ]);
});

test("a sign-in a tool started refreshes the status line once it goes through", async () => {
  const arm = fakeArm({ scopes: ["User.Read"] });
  const fake = fakeApi({ connections: arm.connections });
  stop = (await module.activate(fake.api)) ?? undefined;
  await Bun.sleep(1);
  expect(await fake.callTool("azure_tenants", {})).toContain("opened the Microsoft page");
  await Bun.sleep(1);
  expect(fake.statuses.at(-1)).toBe("Connected · 2 subscriptions (Northwind Retail, Contoso Labs)");
});

test("with no Microsoft account, a tool says so and opens the sign-in to connect one", async () => {
  const { call, arm, kit } = harness({ none: true });
  const text = await call("azure_tenants", {});
  expect(text).toContain("No Microsoft account is connected");
  expect(text).toContain("opened the Microsoft page to connect a Microsoft account");
  await kit.access.settled();
  expect(arm.signIns).toEqual([{ scopes: [ARM_SCOPE], options: {} }]);
});

test("without the Azure grant, a tool opens the grant sign-in itself and sends nothing", async () => {
  const { call, arm, kit } = harness({ scopes: ["User.Read"] });
  const text = await call("azure_subscriptions", {});
  expect(text).toContain("Azure access is not granted on jimmy@northwind.example yet.");
  expect(text).toContain("opened the Microsoft page to grant Azure access");
  expect(arm.sent).toEqual([]);
  await kit.access.settled();
  expect(arm.signIns).toEqual([{ scopes: [ARM_SCOPE], options: { connection: "ms-1" } }]);
  // Granted now: the next call goes through.
  expect(await call("azure_subscriptions", {})).toContain("Shop Production");
});

test("a second call while the sign-in page is open does not open another", async () => {
  const arm = fakeArm({ scopes: ["User.Read"] });
  let finish: () => void = () => undefined;
  const held = {
    ...arm.connections,
    signIn: (...asked: Parameters<typeof arm.connections.signIn>) =>
      new Promise<Awaited<ReturnType<typeof arm.connections.signIn>>>((resolve) => {
        finish = () => resolve(arm.connections.signIn(...asked));
      }),
  };
  const context = new AzureContext(() => held);
  const access = new Access(context);
  const failure = { kind: "not-granted", connection: "ms-1", account: "a@b" } as const;
  expect(access.explain(failure)).toContain("opened the Microsoft page");
  expect(access.explain(failure)).toContain("is already open in the reader's browser");
  finish();
  await access.settled();
  expect(arm.signIns).toHaveLength(1);
});

test("an ended sign-in of the whole account opens a sign-in for it again", async () => {
  const { call, arm, kit } = harness({ ended: true });
  expect(await call("azure_get", { id: APP_ID })).toContain("The Microsoft sign-in for jimmy");
  await kit.access.settled();
  expect(arm.signIns).toEqual([{ scopes: [], options: { connection: "ms-1" } }]);
});

test("tenants and subscriptions are read per tenant, each with its own tenant's token", async () => {
  const { call, arm } = harness();
  const text = await call("azure_subscriptions", {});
  expect(text).toContain("Shop Production");
  expect(text).toContain("Contoso Sandbox");
  const subscriptionCalls = arm.sent.filter((each) => each.path.startsWith("/subscriptions?"));
  expect(subscriptionCalls.map((each) => each.tenant)).toEqual([HOME, GUEST]);
});

test("a guest tenant needing sign-in is named, and asking for it opens its sign-in", async () => {
  const { call, arm, kit } = harness({ deadTenants: [GUEST] });
  const text = await call("azure_tenants", {});
  expect(text).toContain('"name": "Northwind Retail"');
  expect(text).toMatch(/Contoso Labs[\s\S]*"subscriptions": 0[\s\S]*ended in tenant t-guest only/);
  expect(arm.signIns).toEqual([]);
  expect(await call("azure_subscriptions", {})).toContain("Shop Production");
  expect(await call("azure_subscriptions", { tenant: GUEST })).toContain(
    "opened the Microsoft page to sign jimmy@northwind.example in again to tenant t-guest",
  );
  await kit.access.settled();
  expect(arm.signIns).toEqual([{ scopes: [], options: { connection: "ms-1", tenant: GUEST } }]);
});

test("an older prifly that names no tenant still marks only the tenant asked for", async () => {
  const { call } = harness({ deadTenants: [GUEST], oldHost: true });
  expect(await call("azure_tenants", {})).toContain("ended in tenant t-guest only");
});

test("azure_query posts the KQL to Resource Graph without a confirm card", async () => {
  const { call, arm, fake } = harness({}, { confirm: false });
  const text = await call("azure_query", {
    kql: "resources | project name",
    subscriptions: [SUB_PROD],
    top: 2,
  });
  expect(text).toStartWith("2 rows.");
  const posted = arm.sent.find((each) =>
    each.path.startsWith("/providers/Microsoft.ResourceGraph"),
  );
  expect(posted).toMatchObject({
    method: "POST",
    tenant: HOME,
    body: { query: "resources | project name", subscriptions: [SUB_PROD], options: { $top: 2 } },
  });
  expect(fake.confirms).toEqual([]);
});

test("azure_query follows $skipToken until top, and says when more exist", async () => {
  let page = 0;
  const { call, arm } = harness({
    override: (sent) => {
      if (!sent.path.startsWith("/providers/Microsoft.ResourceGraph")) return null;
      page += 1;
      return Response.json({ data: [{ n: page }], $skipToken: `after-${page}` });
    },
  });
  const text = await call("azure_query", { kql: "resources", top: 2 });
  expect(text).toStartWith("2 rows, more exist");
  const posts = arm.sent.filter((each) =>
    each.path.startsWith("/providers/Microsoft.ResourceGraph"),
  );
  expect(posts.map((each) => (each.body as { options: Record<string, unknown> }).options)).toEqual([
    { resultFormat: "objectArray", $top: 2 },
    { resultFormat: "objectArray", $top: 1, $skipToken: "after-1" },
  ]);
});

test("azure_get reads a resource with the newest stable api-version its provider lists", async () => {
  const { call, arm } = harness();
  const text = await call("azure_get", { id: APP_ID });
  expect(text).toContain('"state": "Running"');
  expect(arm.sent.at(-1)?.path).toBe(`${APP_ID}?api-version=2024-04-01`);
});

test("an ARM error comes back as its status, code and message", async () => {
  const { call } = harness();
  const missing = `/subscriptions/${SUB_PROD}/resourceGroups/rg/providers/Microsoft.Web/sites/gone`;
  const text = await call("azure_get", { id: missing, apiVersion: "2024-04-01" });
  expect(text).toStartWith("Azure answered 404 ResourceNotFound: No ");
});

test("a 429 is passed on with its Retry-After, not retried", async () => {
  const { call, arm } = harness({
    override: (sent) =>
      sent.path.includes("CostManagement")
        ? new Response("", { status: 429, headers: { "Retry-After": "30" } })
        : null,
  });
  const text = await call("azure_cost", { subscription: SUB_PROD });
  expect(text).toBe("Azure is throttling these requests; retry after 30 s.");
  expect(arm.sent.filter((each) => each.path.includes("CostManagement"))).toHaveLength(1);
});

test("azure_cost asks for daily actual cost, or one row per group, without a confirm card", async () => {
  const { call, arm, fake } = harness({}, { confirm: false });
  const text = await call("azure_cost", {
    subscription: SUB_PROD,
    from: "2026-10-01",
    to: "2026-10-10",
    groupBy: "ResourceGroup",
  });
  expect(text).toContain("Actual cost of sub-prod, 2026-10-01 to 2026-10-10.");
  const asked = arm.sent.find((each) => each.path.includes("CostManagement"));
  expect(asked?.body).toMatchObject({
    type: "ActualCost",
    timePeriod: { from: "2026-10-01", to: "2026-10-10" },
    dataset: { granularity: "None", grouping: [{ type: "Dimension", name: "ResourceGroup" }] },
  });
  expect(fake.confirms).toEqual([]);
});

test("an ARM id names its provider and nested type", () => {
  expect(typeOf(APP_ID)).toEqual({ namespace: "Microsoft.Web", type: "sites" });
  expect(typeOf(`${APP_ID}/slots/staging`)).toEqual({
    namespace: "Microsoft.Web",
    type: "sites/slots",
  });
  expect(typeOf(`/subscriptions/${SUB_PROD}/resourceGroups/rg`)).toBeNull();
});

const costRequests = (arm: { sent: { path: string; tenant: string }[] }) =>
  arm.sent.filter((each) => each.path.includes("CostManagement"));

const NO_SUBS = (sent: { path: string }) =>
  sent.path.startsWith("/subscriptions?") ? Response.json({ value: [] }) : null;

test("azure_cost with no subscription and one reachable asks that subscription only", async () => {
  const { call, arm } = harness({ deadTenants: [GUEST] });
  const text = await call("azure_cost", {});
  expect(text).toContain(`Actual cost of ${SUB_PROD},`);
  expect(costRequests(arm).map((each) => each.path)).toEqual([
    `/subscriptions/${SUB_PROD}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
  ]);
});

test("azure_cost with no subscription and two reachable answers one block each", async () => {
  const { call, arm } = harness();
  const text = await call("azure_cost", {});
  expect(text).toContain(`## Shop Production (${SUB_PROD})`);
  expect(text).toContain(`## Contoso Sandbox (${SUB_GUEST})`);
  expect(costRequests(arm).map((each) => each.path.split("/")[2])).toEqual([SUB_PROD, SUB_GUEST]);
  expect(costRequests(arm).map((each) => each.tenant)).toEqual([HOME, GUEST]);
});

test("azure_cost with no reachable subscription says so and sends no cost request", async () => {
  const { call, arm } = harness({ override: NO_SUBS });
  const text = await call("azure_cost", {});
  expect(text).toStartWith("No Azure subscriptions are reachable with this sign-in");
  expect(costRequests(arm)).toEqual([]);
});

test("an empty or blank subscription counts as not given", async () => {
  for (const subscription of ["", "   "]) {
    const { call, arm } = harness();
    const text = await call("azure_cost", { subscription });
    expect(text).toContain(`## Contoso Sandbox (${SUB_GUEST})`);
    expect(costRequests(arm)).toHaveLength(2);
    expect(arm.sent.some((each) => each.path.startsWith("/subscriptions//"))).toBe(false);
  }
});

test("azure_query drops blank subscription ids instead of posting them", async () => {
  const { call, arm } = harness();
  await call("azure_query", { kql: "resources", subscriptions: ["", "  ", SUB_PROD] });
  const posted = arm.sent.find((each) =>
    each.path.startsWith("/providers/Microsoft.ResourceGraph"),
  );
  expect(posted?.body).toMatchObject({ subscriptions: [SUB_PROD] });
  await call("azure_query", { kql: "resources", subscriptions: [" "] });
  const last = arm.sent.at(-1);
  expect(last?.path).toStartWith("/providers/Microsoft.ResourceGraph");
  expect(last?.body).toMatchObject({ query: "resources" });
  expect(last?.body).not.toHaveProperty("subscriptions");
});

test("a path with an empty subscription segment is refused by every tool that takes one", async () => {
  const bad = "/subscriptions//resourceGroups/rg/providers/Microsoft.Web/sites/x";
  const { call, arm, fake } = harness({}, { confirm: true });
  const operation =
    "https://management.azure.com/subscriptions//providers/X/operationresults/1?api-version=1";
  const asks: [string, Record<string, unknown>][] = [
    ["azure_get", { id: bad }],
    ["azure_put_resource", { id: bad, body: {}, apiVersion: "2024-04-01" }],
    ["azure_delete_resource", { id: bad, apiVersion: "2024-04-01" }],
    ["azure_api", { path: bad, apiVersion: "2024-04-01" }],
    ["azure_wait_operation", { url: operation }],
  ];
  for (const [name, args] of asks) {
    expect(await call(name, args)).toContain("empty subscription id");
  }
  expect(fake.confirms).toEqual([]);
  expect(arm.sent.some((each) => each.path.includes("/subscriptions//"))).toBe(false);
});

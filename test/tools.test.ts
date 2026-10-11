import { afterEach, expect, test } from "bun:test";
import type { ExtensionModule, ExtensionToolContext } from "@prifly/extension-api";
import { typeOf } from "../azure";
import { AzureContext } from "../context";
import * as extension from "../index";
import { azureTools } from "../tools";
import { fakeApi } from "./fake-api";
import { APP_ID, type FakeArmOptions, fakeArm, GUEST, HOME, SUB_PROD } from "./fake-arm";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

let stop: (() => void) | undefined;
afterEach(() => stop?.());

const CTX: ExtensionToolContext = {
  session: "fake-session",
  pick: async () => null,
  signal: new AbortController().signal,
};

/** The tools over a fake ARM, without the watcher's rounds sending requests beside them. */
function activated(options: FakeArmOptions = {}) {
  const arm = fakeArm(options);
  const tools = azureTools(new AzureContext(() => arm.connections));
  const callTool = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((each) => each.name === name);
    if (tool === undefined) throw new Error(`No tool ${name}`);
    return tool.call(args, CTX);
  };
  return { fake: { callTool }, arm };
}

test("activate registers the five read-only tools and nothing that writes", async () => {
  const fake = fakeApi({ connections: fakeArm({ none: true }).connections });
  stop = (await module.activate(fake.api)) ?? undefined;
  expect(fake.tools().map((tool) => tool.name)).toEqual([
    "azure_tenants",
    "azure_subscriptions",
    "azure_query",
    "azure_get",
    "azure_cost",
  ]);
});

test("with no Microsoft account, a tool says to connect one", async () => {
  const { fake } = activated({ none: true });
  expect(await fake.callTool("azure_tenants", {})).toContain("No Microsoft account is connected");
});

test("without Azure access granted, a tool says where to grant it and sends nothing", async () => {
  const { fake, arm } = activated({ scopes: ["User.Read"] });
  expect(await fake.callTool("azure_subscriptions", {})).toContain("pick Grant Azure access");
  expect(arm.sent).toEqual([]);
});

test("tenants and subscriptions are read per tenant, each with its own tenant's token", async () => {
  const { fake, arm } = activated();
  const text = await fake.callTool("azure_subscriptions", {});
  expect(text).toContain("Shop Production");
  expect(text).toContain("Contoso Sandbox");
  const subscriptionCalls = arm.sent.filter((each) => each.path.startsWith("/subscriptions?"));
  expect(subscriptionCalls.map((each) => each.tenant)).toEqual([HOME, GUEST]);
});

test("a guest tenant needing sign-in is named, and the home tenant still answers", async () => {
  const { fake } = activated({ deadTenants: [GUEST] });
  const text = await fake.callTool("azure_tenants", {});
  expect(text).toContain('"name": "Northwind Retail"');
  expect(text).toMatch(/Contoso Labs[\s\S]*"subscriptions": 0[\s\S]*ended in tenant t-guest only/);
  expect(await fake.callTool("azure_subscriptions", {})).toContain("Shop Production");
});

test("an older prifly that names no tenant still marks only the tenant asked for", async () => {
  const { fake } = activated({ deadTenants: [GUEST], oldHost: true });
  expect(await fake.callTool("azure_tenants", {})).toContain("ended in tenant t-guest only");
});

test("azure_query posts the KQL to Resource Graph for the subscriptions, in their tenant", async () => {
  const { fake, arm } = activated();
  const text = await fake.callTool("azure_query", {
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
});

test("azure_query follows $skipToken until top, and says when more exist", async () => {
  let page = 0;
  const { fake, arm } = activated({
    override: (sent) => {
      if (!sent.path.startsWith("/providers/Microsoft.ResourceGraph")) return null;
      page += 1;
      return Response.json({ data: [{ n: page }], $skipToken: `after-${page}` });
    },
  });
  const text = await fake.callTool("azure_query", { kql: "resources", top: 2 });
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
  const { fake, arm } = activated();
  const text = await fake.callTool("azure_get", { id: APP_ID });
  expect(text).toContain('"state": "Running"');
  expect(arm.sent.at(-1)?.path).toBe(`${APP_ID}?api-version=2024-04-01`);
});

test("an ARM error comes back as its status, code and message", async () => {
  const { fake } = activated();
  const missing = `/subscriptions/${SUB_PROD}/resourceGroups/rg/providers/Microsoft.Web/sites/gone`;
  const text = await fake.callTool("azure_get", { id: missing, apiVersion: "2024-04-01" });
  expect(text).toStartWith("Azure answered 404 ResourceNotFound: No ");
});

test("a 429 is passed on with its Retry-After, not retried", async () => {
  const { fake, arm } = activated({
    override: (sent) =>
      sent.path.includes("CostManagement")
        ? new Response("", { status: 429, headers: { "Retry-After": "30" } })
        : null,
  });
  const text = await fake.callTool("azure_cost", { subscription: SUB_PROD });
  expect(text).toBe("Azure is throttling these requests; retry after 30 s.");
  expect(arm.sent.filter((each) => each.path.includes("CostManagement"))).toHaveLength(1);
});

test("azure_cost asks for daily actual cost, or one row per group", async () => {
  const { fake, arm } = activated();
  const text = await fake.callTool("azure_cost", {
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
});

test("an ARM id names its provider and nested type", () => {
  expect(typeOf(APP_ID)).toEqual({ namespace: "Microsoft.Web", type: "sites" });
  expect(typeOf(`${APP_ID}/slots/staging`)).toEqual({
    namespace: "Microsoft.Web",
    type: "sites/slots",
  });
  expect(typeOf(`/subscriptions/${SUB_PROD}/resourceGroups/rg`)).toBeNull();
});

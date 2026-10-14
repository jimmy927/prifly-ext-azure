import { expect, test } from "bun:test";
import type { ConfirmSpec } from "@prifly/extension-api";
import { needsConfirm } from "../writes";
import { ASYNC_OP, LOCATION_OP, type Sent, STORAGE_ID, SUB_PROD } from "./fake-arm";
import { harness } from "./harness";

const BODY = { location: "westeurope", sku: { name: "Standard_LRS" }, kind: "StorageV2" };

type WriteCase = {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
};

/** Every way a tool can change something; each must wait for Confirm. */
const WRITES: WriteCase[] = [
  {
    name: "azure_api PUT",
    tool: "azure_api",
    args: { method: "PUT", path: STORAGE_ID, apiVersion: "2023-05-01", body: BODY },
    method: "PUT",
    path: STORAGE_ID,
  },
  {
    name: "azure_api PATCH",
    tool: "azure_api",
    args: {
      method: "PATCH",
      path: `https://management.azure.com${STORAGE_ID}`,
      apiVersion: "2023-05-01",
      body: { tags: { env: "prod" } },
    },
    method: "PATCH",
    path: STORAGE_ID,
  },
  {
    name: "azure_api DELETE",
    tool: "azure_api",
    args: { method: "DELETE", path: `${STORAGE_ID}?api-version=2023-05-01` },
    method: "DELETE",
    path: STORAGE_ID,
  },
  {
    name: "azure_api POST listKeys",
    tool: "azure_api",
    args: { method: "post", path: `${STORAGE_ID}/listKeys`, apiVersion: "2023-05-01" },
    method: "POST",
    path: `${STORAGE_ID}/listKeys`,
  },
  {
    name: "azure_api POST of an action not on the read list",
    tool: "azure_api",
    args: {
      method: "POST",
      path: `/subscriptions/${SUB_PROD}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1/restart`,
      apiVersion: "2024-07-01",
    },
    method: "POST",
    path: `/subscriptions/${SUB_PROD}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1/restart`,
  },
  {
    name: "azure_put_resource",
    tool: "azure_put_resource",
    args: { id: STORAGE_ID, apiVersion: "2023-05-01", body: BODY },
    method: "PUT",
    path: STORAGE_ID,
  },
  {
    name: "azure_delete_resource",
    tool: "azure_delete_resource",
    args: { id: STORAGE_ID, apiVersion: "2023-05-01" },
    method: "DELETE",
    path: STORAGE_ID,
  },
];

const isTheWrite = (each: WriteCase) => (sent: Sent) =>
  sent.method === each.method && (sent.path.split("?")[0] ?? "") === each.path;

for (const each of WRITES) {
  test(`${each.name}: cancelled on the card, nothing is sent`, async () => {
    const { call, arm, fake } = harness({}, { confirm: false });
    expect(await call(each.tool, each.args)).toBe("Not done: you cancelled");
    expect(fake.confirms).toHaveLength(1);
    expect(arm.sent.filter(isTheWrite(each))).toEqual([]);
  });

  test(`${each.name}: the card comes first and shows method, full URL and body`, async () => {
    let sentAtCard = -1;
    const harnessed = harness(
      {},
      {
        confirm: () => {
          sentAtCard = harnessed.arm.sent.filter(isTheWrite(each)).length;
          return true;
        },
      },
    );
    const { call, arm, fake } = harnessed;
    await call(each.tool, each.args);
    expect(sentAtCard).toBe(0);
    expect(arm.sent.filter(isTheWrite(each))).toHaveLength(1);
    const card = fake.confirms[0] as ConfirmSpec;
    expect(card.details).toStartWith(`${each.method} https://management.azure.com${each.path}?`);
    expect(card.details).toContain("api-version=");
    const body = each.args["body"];
    if (body !== undefined) expect(card.details).toContain(JSON.stringify(body, null, 2));
    else expect(card.details).toContain("(no body)");
  });
}

test("without api.confirm (an older prifly), a write is refused and nothing is sent", async () => {
  const { call, arm, kit } = harness();
  kit.confirm = undefined;
  const text = await call("azure_delete_resource", { id: STORAGE_ID, apiVersion: "2023-05-01" });
  expect(text).toStartWith("Not done: this prifly cannot show a confirm card");
  expect(arm.writes()).toEqual([]);
});

test("Resource Graph and Cost Management query and forecast POSTs through azure_api do not confirm", async () => {
  const { call, arm, fake } = harness({}, { confirm: false });
  await call("azure_api", {
    method: "POST",
    path: "/providers/Microsoft.ResourceGraph/resources",
    apiVersion: "2022-10-01",
    body: { query: "resources" },
  });
  await call("azure_api", {
    method: "POST",
    path: `/subscriptions/${SUB_PROD}/providers/Microsoft.CostManagement/query`,
    apiVersion: "2023-11-01",
    body: { type: "ActualCost", timeframe: "MonthToDate" },
  });
  const text = await call("azure_api", {
    method: "POST",
    path: `/subscriptions/${SUB_PROD}/providers/Microsoft.CostManagement/forecast`,
    apiVersion: "2023-11-01",
    body: { type: "Usage" },
  });
  expect(text).toStartWith("Azure answered 200.");
  expect(fake.confirms).toEqual([]);
  expect(arm.writes().map((each) => each.path.split("?")[0])).toEqual([
    "/providers/Microsoft.ResourceGraph/resources",
    `/subscriptions/${SUB_PROD}/providers/Microsoft.CostManagement/query`,
    `/subscriptions/${SUB_PROD}/providers/Microsoft.CostManagement/forecast`,
  ]);
});

test("a GET through azure_api runs at once with its query", async () => {
  const { call, arm, fake } = harness({}, { confirm: false });
  const text = await call("azure_api", {
    path: STORAGE_ID,
    apiVersion: "2023-05-01",
    query: { $expand: "geoReplicationStats" },
  });
  expect(text).toContain('"provisioningState": "Succeeded"');
  expect(fake.confirms).toEqual([]);
  expect(arm.sent.at(-1)?.path).toBe(
    `${STORAGE_ID}?%24expand=geoReplicationStats&api-version=2023-05-01`,
  );
});

test("the read list is narrow: only exact query endpoints skip the card", () => {
  expect(needsConfirm("GET", STORAGE_ID)).toBe(false);
  expect(needsConfirm("POST", "/providers/Microsoft.ResourceGraph/resources")).toBe(false);
  expect(needsConfirm("POST", "/providers/Microsoft.ResourceGraph/resources/x")).toBe(true);
  expect(needsConfirm("POST", "/providers/Microsoft.CostManagement/exports/x/run")).toBe(true);
  expect(needsConfirm("PUT", "/providers/Microsoft.ResourceGraph/resources")).toBe(true);
});

test("azure_api refuses any host but management.azure.com and a missing api-version", async () => {
  const { call, arm } = harness();
  expect(
    await call("azure_api", { path: "https://graph.microsoft.com/v1.0/me", apiVersion: "1" }),
  ).toContain("Only Azure Resource Manager");
  expect(
    await call("azure_api", {
      path: "https://management.azure.com@evil.example/x",
      apiVersion: "1",
    }),
  ).toContain("Only Azure Resource Manager");
  expect(await call("azure_api", { path: STORAGE_ID })).toStartWith("Give apiVersion");
  expect(arm.sent).toEqual([]);
});

test("a PUT that Azure accepts as still running answers with its operation URL", async () => {
  const { call } = harness();
  const text = await call("azure_put_resource", { id: STORAGE_ID, body: BODY });
  expect(text).toStartWith(
    `Azure answered 201: accepted and still running. Follow it with azure_wait_operation, url ${ASYNC_OP}`,
  );
  expect(text).toContain('"operation"');
});

test("azure_put_resource with no api-version takes the newest stable one, shown on the card", async () => {
  const { call, fake } = harness();
  await call("azure_put_resource", { id: STORAGE_ID, body: BODY });
  expect(fake.confirms[0]?.details).toContain(`${STORAGE_ID}?api-version=2023-05-01`);
  expect(fake.confirms[0]?.summary).toBe(
    "Create or update Microsoft.Storage/storageAccounts stdata in rg-data",
  );
});

test("a DELETE accepted with a Location header answers with that URL", async () => {
  const { call } = harness();
  const text = await call("azure_delete_resource", { id: STORAGE_ID, apiVersion: "2023-05-01" });
  expect(text).toContain(`url ${LOCATION_OP}`);
});

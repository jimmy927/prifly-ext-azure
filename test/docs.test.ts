import { expect, test } from "bun:test";
import { MAX_DOCS } from "../docs";
import { type Fetcher, GITHUB_API, RAW } from "../specs";
import { harness } from "./harness";

const PROVIDER_DIR = `${RAW}specification/storage/resource-manager/Microsoft.Storage/`;
const ACCOUNT =
  "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{accountName}";
const COMMON = "../../../../../common-types/resource-management/v5/types.json";

const HUGE_BODY = {
  properties: Object.fromEntries(
    Array.from({ length: 3000 }, (_, index) => [
      `field${index}`,
      { type: "string", description: `Field number ${index} of a very wide object.` },
    ]),
  ),
};

const LATEST = {
  swagger: "2.0",
  paths: {
    [ACCOUNT]: {
      put: {
        operationId: "StorageAccounts_Create",
        summary: "Creates a new storage account.",
        "x-ms-long-running-operation": true,
        "x-ms-long-running-operation-options": { "final-state-via": "location" },
        parameters: [
          { $ref: "#/parameters/AccountName" },
          { $ref: `${COMMON}#/parameters/SubscriptionIdParameter` },
          {
            name: "parameters",
            in: "body",
            required: true,
            schema: { $ref: "#/definitions/StorageAccountCreateParameters" },
          },
        ],
        responses: { "200": {}, "202": {} },
        "x-ms-examples": { Create: { $ref: "./examples/StorageAccountCreate.json" } },
      },
      get: { operationId: "StorageAccounts_GetProperties", responses: { "200": {} } },
      delete: { operationId: "StorageAccounts_Delete", responses: { "200": {}, "204": {} } },
    },
    [`${ACCOUNT}/listKeys`]: {
      post: { operationId: "StorageAccounts_ListKeys", summary: "Lists the access keys." },
    },
    [`${ACCOUNT}/huge`]: {
      put: {
        operationId: "StorageAccounts_Huge",
        parameters: [{ name: "body", in: "body", schema: HUGE_BODY }],
      },
    },
    "/subscriptions/{subscriptionId}/providers/Microsoft.Storage/storageAccounts": {
      get: { operationId: "StorageAccounts_List" },
    },
  },
  parameters: {
    AccountName: { name: "accountName", in: "path", required: true, type: "string" },
  },
  definitions: {
    StorageAccountCreateParameters: {
      required: ["sku", "kind", "location"],
      allOf: [{ $ref: `${COMMON}#/definitions/Resource` }],
      properties: {
        sku: { $ref: "#/definitions/Sku" },
        kind: { type: "string", enum: ["StorageV2", "BlobStorage"] },
        location: { type: "string" },
        properties: { $ref: "#/definitions/Props" },
      },
    },
    Sku: { required: ["name"], properties: { name: { type: "string" } } },
    Props: {
      properties: { child: { $ref: "#/definitions/Props" }, httpsOnly: { type: "boolean" } },
    },
  },
};

const COMMON_TYPES = {
  parameters: {
    SubscriptionIdParameter: { name: "subscriptionId", in: "path", required: true, type: "string" },
  },
  definitions: {
    Resource: {
      properties: {
        id: { type: "string", readOnly: true },
        tags: { type: "object", additionalProperties: { type: "string" } },
      },
    },
  },
};

function fixtures(overrides: Record<string, () => Response> = {}) {
  const files: Record<string, unknown> = {
    [`${GITHUB_API}/contents/specification/storage/resource-manager?ref=main`]: [
      { name: "Microsoft.Storage", type: "dir", sha: "sha-storage" },
      { name: "readme.md", type: "file", sha: "x" },
    ],
    [`${GITHUB_API}/git/trees/sha-storage?recursive=1`]: {
      truncated: false,
      tree: [
        { path: "stable", type: "tree" },
        { path: "stable/2023-01-01/storage.json", type: "blob" },
        { path: "stable/2023-05-01/storage.json", type: "blob" },
        { path: "stable/2023-05-01/examples/StorageAccountCreate.json", type: "blob" },
        { path: "preview/2025-06-01-preview/storage.json", type: "blob" },
      ],
    },
    [`${PROVIDER_DIR}stable/2023-05-01/storage.json`]: LATEST,
    [`${PROVIDER_DIR}stable/2023-01-01/storage.json`]: { paths: {} },
    [`${PROVIDER_DIR}preview/2025-06-01-preview/storage.json`]: { paths: {} },
    [`${RAW}specification/common-types/resource-management/v5/types.json`]: COMMON_TYPES,
    [`${GITHUB_API}/contents/specification?ref=main`]: [{ name: "storage", type: "dir", sha: "s" }],
  };
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    const override = overrides[url];
    if (override !== undefined) return override();
    return url in files ? Response.json(files[url]) : new Response("Not Found", { status: 404 });
  };
  return { fetcher, asked };
}

test("reads the newest stable api-version and writes out the operation with its refs resolved", async () => {
  const { fetcher, asked } = fixtures();
  const { call } = harness({}, { fetcher });
  const text = await call("azure_api_docs", {
    provider: "Microsoft.Storage",
    resourceType: "storageAccounts",
    operation: "create",
  });
  expect(text).toStartWith("Microsoft.Storage (specification/storage), api-version 2023-05-01.");
  const [op] = JSON.parse(text.slice(text.indexOf("\n") + 1));
  expect(op).toMatchObject({
    operationId: "StorageAccounts_Create",
    method: "PUT",
    path: ACCOUNT,
    apiVersion: "2023-05-01",
    longRunning: "location",
    responses: ["200", "202"],
    examples: [`${PROVIDER_DIR}stable/2023-05-01/examples/StorageAccountCreate.json`],
  });
  expect(op.parameters).toContainEqual({
    name: "subscriptionId",
    in: "path",
    required: true,
    type: "string",
  });
  expect(op.parameters).toContainEqual({
    name: "accountName",
    in: "path",
    required: true,
    type: "string",
  });
  // The body: merged allOf, read-only id left out, the recursion named rather than followed.
  expect(op.body.required).toEqual(["sku", "kind", "location"]);
  expect(op.body.properties.sku).toEqual({
    required: ["name"],
    properties: { name: { type: "string" } },
  });
  expect(op.body.properties.tags).toBeDefined();
  expect(op.body.properties.id).toBeUndefined();
  expect(op.body.properties.properties.properties.child.note).toContain("recursive");
  expect(asked).not.toContain(`${PROVIDER_DIR}preview/2025-06-01-preview/storage.json`);
  expect(asked).not.toContain(`${PROVIDER_DIR}stable/2023-01-01/storage.json`);
});

test("a given api-version is read instead of the newest", async () => {
  const { fetcher, asked } = fixtures();
  const { call } = harness({}, { fetcher });
  const text = await call("azure_api_docs", {
    provider: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
  });
  expect(text).toContain("api-version 2023-01-01");
  expect(asked).toContain(`${PROVIDER_DIR}stable/2023-01-01/storage.json`);
});

test("many matches are listed to narrow, and an operationId is written out exactly", async () => {
  const { fetcher } = fixtures();
  const { call } = harness({}, { fetcher });
  const listed = await call("azure_api_docs", {
    provider: "Microsoft.Storage",
    resourceType: "storageAccounts",
  });
  expect(listed).toContain("6 operations match");
  expect(listed).toContain('"operationId": "StorageAccounts_List"');
  const keys = await call("azure_api_docs", {
    provider: "Microsoft.Storage",
    operation: "StorageAccounts_ListKeys",
  });
  expect(keys).toContain('"method": "POST"');
  expect(keys).toContain(`"path": "${ACCOUNT}/listKeys"`);
  const words = await call("azure_api_docs", {
    provider: "Microsoft.Storage",
    operation: "post list keys",
  });
  expect(words).toContain('"operationId": "StorageAccounts_ListKeys"');
});

test("a huge schema is trimmed to a bounded answer", async () => {
  const { fetcher } = fixtures();
  const { call } = harness({}, { fetcher });
  const text = await call("azure_api_docs", {
    provider: "Microsoft.Storage",
    operation: "StorageAccounts_Huge",
  });
  expect(text).toContain(`… cut at ${MAX_DOCS} characters`);
  expect(text.length).toBeLessThan(MAX_DOCS + 400);
});

test("GitHub's listings are read once and kept for the next call", async () => {
  const { fetcher, asked } = fixtures();
  const { call } = harness({}, { fetcher });
  await call("azure_api_docs", { provider: "Microsoft.Storage", operation: "create" });
  await call("azure_api_docs", { provider: "Microsoft.Storage", operation: "delete" });
  expect(asked.filter((url) => url.startsWith(GITHUB_API))).toHaveLength(2);
});

test("a provider with no folder says how to name its service", async () => {
  const { fetcher } = fixtures();
  const { call } = harness({}, { fetcher });
  const text = await call("azure_api_docs", { provider: "Microsoft.Nothing" });
  expect(text).toStartWith("No folder for Microsoft.Nothing");
  expect(text).toContain("Give service");
});

test("GitHub's rate limit is said as such", async () => {
  const { fetcher } = fixtures({
    [`${GITHUB_API}/contents/specification/storage/resource-manager?ref=main`]: () =>
      new Response("rate limited", { status: 403 }),
  });
  const { call } = harness({}, { fetcher });
  expect(await call("azure_api_docs", { provider: "Microsoft.Storage" })).toContain("60 an hour");
});

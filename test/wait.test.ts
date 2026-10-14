import { expect, test } from "bun:test";
import { retryAfterSeconds } from "../wait";
import { ASYNC_OP, LOCATION_OP } from "./fake-arm";
import { harness } from "./harness";

/** A clock the fake sleep moves on, so a timeout runs in no time. */
function clock() {
  let now = Date.parse("2026-10-14T10:00:00Z");
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}

const opPath = (url: string) => url.slice("https://management.azure.com".length).split("?")[0];

test("polls an Azure-AsyncOperation URL at its Retry-After pace until Succeeded", async () => {
  const time = clock();
  const answers = [
    Response.json({ status: "InProgress" }, { headers: { "Retry-After": "3" } }),
    Response.json({ status: "InProgress" }, { headers: { "Retry-After": "7" } }),
    Response.json({ status: "Succeeded", properties: { output: 1 } }),
  ];
  const { call, arm } = harness(
    {
      override: (sent) =>
        sent.path.startsWith(opPath(ASYNC_OP) ?? "") ? (answers.shift() ?? null) : null,
    },
    time,
  );
  const text = await call("azure_wait_operation", { url: ASYNC_OP });
  expect(text).toStartWith("The operation ended: Succeeded.");
  expect(text).toContain('"output": 1');
  expect(time.slept).toEqual([3000, 7000]);
  expect(arm.sent.filter((each) => each.path.startsWith(opPath(ASYNC_OP) ?? ""))).toHaveLength(3);
});

test("a Location URL is done once it stops answering 202", async () => {
  const time = clock();
  const answers = [
    new Response(null, { status: 202, headers: { "Retry-After": "2" } }),
    new Response(null, { status: 204 }),
  ];
  const { call } = harness(
    {
      override: (sent) =>
        sent.path.startsWith(opPath(LOCATION_OP) ?? "") ? (answers.shift() ?? null) : null,
    },
    time,
  );
  const text = await call("azure_wait_operation", { url: LOCATION_OP });
  expect(text).toStartWith("The operation ended: Succeeded.");
  expect(text).toContain('"httpStatus": 204');
});

test("a Failed operation is returned with its error", async () => {
  const { call } = harness(
    {
      override: (sent) =>
        sent.path.startsWith(opPath(ASYNC_OP) ?? "")
          ? Response.json({ status: "Failed", error: { code: "Conflict", message: "name taken" } })
          : null,
    },
    clock(),
  );
  const text = await call("azure_wait_operation", { url: ASYNC_OP });
  expect(text).toStartWith("The operation ended: Failed.");
  expect(text).toContain("name taken");
});

test("after the timeout it says the operation is still running", async () => {
  const time = clock();
  const { call } = harness(
    {
      override: (sent) =>
        sent.path.startsWith(opPath(ASYNC_OP) ?? "")
          ? Response.json({ status: "Running" }, { headers: { "Retry-After": "10" } })
          : null,
    },
    time,
  );
  const text = await call("azure_wait_operation", { url: ASYNC_OP, timeoutSeconds: 25 });
  expect(text).toStartWith("Still running after 25 s");
  expect(time.slept).toEqual([10000, 10000, 5000]);
});

test("only management.azure.com operation URLs are polled", async () => {
  const { call, arm } = harness();
  const text = await call("azure_wait_operation", { url: "https://example.com/op?api-version=1" });
  expect(text).toContain("Only Azure Resource Manager");
  expect(arm.sent).toEqual([]);
});

test("Retry-After reads seconds or a date, and is kept between 1 and 60 s", () => {
  const now = Date.parse("2026-10-14T10:00:00Z");
  expect(retryAfterSeconds("5", now)).toBe(5);
  expect(retryAfterSeconds(undefined, now)).toBe(10);
  expect(retryAfterSeconds("0", now)).toBe(1);
  expect(retryAfterSeconds("3600", now)).toBe(60);
  expect(retryAfterSeconds(new Date(now + 20_000).toUTCString(), now)).toBe(20);
});

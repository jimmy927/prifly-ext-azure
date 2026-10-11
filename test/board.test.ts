import { expect, test } from "bun:test";
import type { LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { ARM_SCOPE } from "../arm";
import { Board } from "../board";
import { AzureContext } from "../context";
import { LAUNCHER, Watcher } from "../watch";
import { fakeApi } from "./fake-api";
import { APP_ID, DEPLOY_ID, type FakeArmOptions, fakeArm, GUEST, SUB_GUEST } from "./fake-arm";

const NOW = Date.parse("2026-10-11T09:00:00Z");

type Failures = Record<string, { name: string; timestamp: string; message: string }[]>;

function setUp(options: FakeArmOptions = {}, failures: Failures = {}) {
  let held = failures;
  const arm = fakeArm({ ...options, failures: () => held });
  const fake = fakeApi({ connections: arm.connections });
  const context = new AzureContext(
    () => arm.connections,
    () => NOW,
  );
  const watcher = new Watcher(fake.api, context, () => NOW);
  const board = new Board(
    context,
    watcher,
    () => arm.connections,
    () => NOW,
  );
  const setFailures = (next: Failures) => {
    held = next;
  };
  return { arm, fake, context, watcher, board, setFailures };
}

function isBoard(value: LaunchBoard | LaunchChoice[]): value is LaunchBoard {
  return !Array.isArray(value);
}

const FAILED = {
  name: "checkout-api-2026",
  timestamp: "2026-10-11T08:42:00Z",
  message: "plan at its limit",
};

test("the first round learns the failures without a notice; a new one later is told once", async () => {
  const run = setUp({}, { "rg-shop-prod": [FAILED] });
  await run.watcher.round();
  expect(run.fake.notices).toEqual([]);
  expect(run.fake.flags.get(LAUNCHER)).toEqual({
    tone: "warning",
    hint: "1 failed deployment in rg-shop-prod",
  });

  const second = {
    ...FAILED,
    name: "signing-2026",
    timestamp: "2026-10-11T08:50:00Z",
    message: "quota",
  };
  run.setFailures({ "rg-shop-prod": [FAILED], "rg-signing": [second] });
  await run.watcher.round();
  await run.watcher.round();
  expect(run.fake.notices).toEqual([
    {
      text: "Azure deployment signing-2026 failed in rg-signing: Conflict: quota",
      tone: "warning",
      session: undefined,
    },
  ]);
  expect(run.fake.flags.get(LAUNCHER)).toEqual({ tone: "warning", hint: "2 failed deployments" });
});

test("a failure older than a day is not shown; none left puts the launcher's glow out", async () => {
  const run = setUp({}, { "rg-shop-prod": [{ ...FAILED, timestamp: "2026-10-09T08:00:00Z" }] });
  await run.watcher.round();
  expect(run.watcher.failed()).toEqual([]);
  expect(run.fake.flags.get(LAUNCHER)).toBeNull();
});

test("without Azure access the watch reads nothing and puts nothing in the status bar", async () => {
  const run = setUp({ scopes: ["User.Read"] });
  await run.watcher.round();
  expect(run.arm.sent).toEqual([]);
  expect(run.fake.shown.length).toBeGreaterThan(0);
  expect(run.fake.shown.every((each) => each.statusBar.length === 0)).toBe(true);
});

test("the status bar stays empty when access is fine and when a tenant needs signing in", async () => {
  for (const options of [{}, { deadTenants: [GUEST] }]) {
    const run = setUp(options);
    await run.watcher.round();
    expect(run.fake.shown.length).toBeGreaterThan(0);
    expect(run.fake.shown.every((each) => each.statusBar.length === 0)).toBe(true);
  }
});

test("the board: failed deployments first, a column per resource group, setup rows above", async () => {
  const run = setUp({ deadTenants: [GUEST] }, { "rg-shop-prod": [FAILED] });
  await run.watcher.round();
  const board = await run.board.choices("");
  if (!isBoard(board)) throw new Error("expected a board");
  expect(board.columns.map((column) => column.id)).toEqual([
    "failed",
    "rg-shop-prod",
    "rg-signing",
  ]);
  expect(board.items[0]).toMatchObject({
    key: `dep:${DEPLOY_ID}`,
    group: "failed",
    tone: "critical",
  });
  expect(board.items.map((item) => item.title)).toContain("app-checkout-api");
  expect(board.actions?.map((row) => row.title)).toEqual([
    "Northwind Retail · Shop Production",
    "Sign in again to Contoso Labs",
  ]);
  const narrowed = await run.board.choices("sql");
  if (!isBoard(narrowed)) throw new Error("expected a board");
  expect(narrowed.items.map((item) => item.title)).toEqual(["sql-shop-prod"]);
});

test("without Azure access the launcher offers Grant Azure access, which asks for the ARM scope", async () => {
  const run = setUp({ scopes: ["User.Read"] });
  expect(await run.board.choices("")).toMatchObject([
    { key: "setup:retry", title: "Azure access is not granted", tone: "muted" },
    { key: "setup:grant", title: "Grant Azure access" },
  ]);
  const launched = await run.board.launch("setup:grant");
  expect(launched).toEqual({ prompt: "", message: "Signed in as jimmy@northwind.example." });
  expect(run.arm.signIns).toEqual([{ scopes: [ARM_SCOPE], options: { connection: "ms-1" } }]);
  const board = await run.board.choices("");
  expect(isBoard(board)).toBe(true);
});

test("with access granted the board carries no grant-access line", async () => {
  const run = setUp();
  const board = await run.board.choices("");
  if (!isBoard(board)) throw new Error("expected a board");
  const rows = [...board.items, ...(board.actions ?? [])];
  expect(rows.some((row) => row.key === "setup:grant" || row.title.includes("not granted"))).toBe(
    false,
  );
});

test("signing a tenant in again asks for that tenant, and the board reads it again", async () => {
  const run = setUp({ deadTenants: [GUEST] });
  expect(await run.board.launch(`setup:signin:${GUEST}`)).toMatchObject({ prompt: "" });
  expect(run.arm.signIns).toEqual([{ scopes: [], options: { connection: "ms-1", tenant: GUEST } }]);
  const board = await run.board.choices("");
  if (!isBoard(board)) throw new Error("expected a board");
  expect(board.actions?.map((row) => row.title)).toContain("Show Contoso Sandbox");
});

test("picking another subscription shows it", async () => {
  const run = setUp();
  await run.board.choices("");
  await run.board.launch(`setup:sub:${SUB_GUEST}`);
  const board = await run.board.choices("");
  if (!isBoard(board)) throw new Error("expected a board");
  expect(board.actions?.[0]?.title).toBe("Contoso Labs · Contoso Sandbox");
  const graphCalls = run.arm.sent.filter((each) =>
    each.path.startsWith("/providers/Microsoft.ResourceGraph"),
  );
  expect(graphCalls.at(-1)).toMatchObject({ tenant: GUEST, body: { subscriptions: [SUB_GUEST] } });
});

test("the subscription setting wins over the first enabled one", async () => {
  const run = setUp();
  run.context.useSetting("contoso sandbox");
  const board = await run.board.choices("");
  if (!isBoard(board)) throw new Error("expected a board");
  expect(board.actions?.[0]?.title).toBe("Contoso Labs · Contoso Sandbox");
});

test("a picked resource starts a session knowing it, its group's deployments and its last day", async () => {
  const run = setUp();
  const launched = await run.board.launch(`res:${APP_ID}`);
  expect(launched.name).toBe("app-checkout-api");
  expect(launched.prompt).toContain(`\`${APP_ID}\``);
  expect(launched.prompt).toContain("Tenant: Northwind Retail");
  expect(launched.prompt).toContain('"state": "Running"');
  expect(launched.prompt).toContain("## Recent deployments of rg-shop-prod");
  expect(launched.prompt).toContain("nightly: Succeeded");
  expect(launched.prompt).toContain("Update website: Failed by ci@northwind.example");
  expect(launched.prompt).toContain("do not use the az CLI");
});

test("a failed deployment opens as a card with what failed in it", async () => {
  const run = setUp();
  const card = await run.board.open(`dep:${DEPLOY_ID}`);
  expect(card.title).toBe("checkout-api-2026 failed");
  expect(card.url).toBe(`https://portal.azure.com/#@northwind.example/resource${DEPLOY_ID}`);
  expect(card.markdown).toContain("## Failed operations");
  expect(card.markdown).toContain("plan at its limit");
});

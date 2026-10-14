import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AzureContext } from "../context";
import { STATUS_MS, StatusLine } from "../status";
import { fakeArm } from "./fake-arm";

const ROOT = join(import.meta.dir, "..");

test("the manifest has no launcher, settings or board, and names its session prompt", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "prifly-extension.json"), "utf8"));
  expect(manifest.launch).toBeUndefined();
  expect(manifest.settings).toBeUndefined();
  expect(manifest.panels).toBeUndefined();
  expect(manifest.prompt).toBe("prompt.md");
  const prompt = readFileSync(join(ROOT, manifest.prompt), "utf8");
  for (const tool of [
    "azure_api",
    "azure_api_docs",
    "azure_wait_operation",
    "azure_put_resource",
  ]) {
    expect(prompt).toContain(tool);
  }
});

test("no source shows chips, flags a launcher or answers a board", () => {
  const sources = readdirSync(ROOT).filter((name) => name.endsWith(".ts"));
  expect(sources.length).toBeGreaterThan(5);
  for (const name of sources) {
    const text = readFileSync(join(ROOT, name), "utf8");
    expect({ name, show: /\bapi\.show\s*\(/.test(text) }).toEqual({ name, show: false });
    expect({ name, flag: /\bapi\.flag\s*\(/.test(text) }).toEqual({ name, flag: false });
    expect({ name, board: /export function (choices|launch|open)\b/.test(text) }).toEqual({
      name,
      board: false,
    });
  }
});

test("the status line says what is connected, and is read at most every 15 minutes", async () => {
  let now = Date.parse("2026-10-14T10:00:00Z");
  const arm = fakeArm();
  const lines: string[] = [];
  const status = new StatusLine(
    (text) => lines.push(text),
    new AzureContext(
      () => arm.connections,
      () => now,
    ),
    () => now,
  );
  await status.refresh();
  expect(lines).toEqual(["Connected · 2 subscriptions (Northwind Retail, Contoso Labs)"]);
  const sentFirst = arm.sent.length;
  now += STATUS_MS - 1;
  await status.refresh();
  expect(lines).toHaveLength(1);
  expect(arm.sent.length).toBe(sentFirst);
  now += 1;
  await status.refresh();
  expect(lines).toHaveLength(2);
  await status.refresh(true);
  expect(lines).toHaveLength(3);
});

test("the status line says why it is not connected", async () => {
  const lines: string[] = [];
  const none = fakeArm({ none: true });
  await new StatusLine(
    (text) => lines.push(text),
    new AzureContext(() => none.connections),
  ).refresh();
  const bare = fakeArm({ scopes: ["User.Read"] });
  await new StatusLine(
    (text) => lines.push(text),
    new AzureContext(() => bare.connections),
  ).refresh();
  expect(lines[0]).toStartWith("Not connected: no Microsoft account");
  expect(lines[1]).toStartWith(
    "Not connected: Azure access not granted on jimmy@northwind.example",
  );
});

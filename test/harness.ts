/**
 * The tools over a fake ARM and a fake `api`, without `activate`'s timer:
 * what a test calls, and what it looks at afterwards (the requests ARM got,
 * the confirm cards shown, the sign-ins asked for).
 */

import type { ConfirmSpec, ExtensionToolContext } from "@prifly/extension-api";
import { Access } from "../access";
import { AzureContext } from "../context";
import type { Kit } from "../kit";
import { type Fetcher, SpecLibrary } from "../specs";
import { azureTools } from "../tools";
import { fakeApi } from "./fake-api";
import { type FakeArmOptions, fakeArm } from "./fake-arm";

export const CTX: ExtensionToolContext = {
  session: "fake-session",
  scratchpad: process.cwd(),
  pick: async () => null,
  signal: new AbortController().signal,
};

const NO_NETWORK: Fetcher = async (url) => {
  throw new Error(`No network in tests: ${url}`);
};

export type HarnessOptions = {
  confirm?: boolean | ((spec: ConfirmSpec) => boolean);
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export function harness(options: FakeArmOptions = {}, how: HarnessOptions = {}) {
  const arm = fakeArm(options);
  const fake = fakeApi({
    connections: arm.connections,
    ...(how.confirm === undefined ? {} : { confirm: how.confirm }),
  });
  const now = how.now ?? Date.now;
  const context = new AzureContext(() => arm.connections, now);
  const kit: Kit = {
    context,
    access: new Access(context),
    confirm: fake.api.confirm,
    specs: new SpecLibrary(how.fetcher ?? NO_NETWORK),
    now,
    sleep: how.sleep ?? (async () => undefined),
  };
  const tools = azureTools(kit);
  const call = (name: string, args: Record<string, unknown>, ctx: ExtensionToolContext = CTX) => {
    const tool = tools.find((each) => each.name === name);
    if (tool === undefined) throw new Error(`No tool ${name}`);
    return tool.call(args, ctx);
  };
  return { arm, fake, kit, call };
}

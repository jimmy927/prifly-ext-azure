/**
 * The Azure extension: what prifly imports. `activate` registers the
 * `azure_*` tools — reads that run at once, writes that wait for the reader's
 * Confirm on a card — and keeps the one status line of Settings → Extensions.
 * No board, launcher or chip: a session is asked in plain words and answers
 * through the tools. Types come from `@prifly/extension-api` with
 * `import type`, so nothing of it is loaded at run time.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { Access } from "./access";
import { AzureContext } from "./context";
import { type Kit, sleep } from "./kit";
import { SpecLibrary } from "./specs";
import { STATUS_MS, StatusLine } from "./status";
import { azureTools } from "./tools";

export function activate(api: ExtensionApi): () => void {
  const context = new AzureContext(() => api.connections);
  const status = new StatusLine(
    api.status === undefined ? undefined : (text) => api.status?.(text),
    context,
  );
  const refresh = (force = false) => {
    status.refresh(force).catch((error: unknown) => {
      api.log("status_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  };
  const kit: Kit = {
    context,
    access: new Access(context, () => refresh(true)),
    confirm:
      api.confirm === undefined
        ? undefined
        : (spec) => api.confirm?.(spec) ?? Promise.resolve(false),
    specs: new SpecLibrary(),
    now: Date.now,
    sleep,
  };
  // Absent on an older prifly: optional, like every part added after the first version.
  api.tools?.register(azureTools(kit));
  refresh();
  const timer = setInterval(() => refresh(), STATUS_MS);
  api.log("activated", { connections: api.connections === undefined ? "absent" : "present" });
  return () => clearInterval(timer);
}

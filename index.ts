/**
 * The Azure extension: what prifly imports. `activate` registers the
 * read-only `azure_*` tools and starts the fifteen-minute watch of failed
 * deployments; `choices`, `open` and `launch` answer the launcher
 * "From an Azure resource…". Types come from `@prifly/extension-api` with
 * `import type`, so nothing of it is loaded at run time.
 */

import type {
  ExtensionApi,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchItem,
  SettingValues,
} from "@prifly/extension-api";
import { Board } from "./board";
import { AzureContext } from "./context";
import { azureTools } from "./tools";
import { ROUND_MS, Watcher } from "./watch";

type Running = { board: Board; watcher: Watcher };

let running: Running | null = null;

function settingOf(values: SettingValues | undefined): string {
  const value = values?.["subscription"];
  return typeof value === "string" ? value : "";
}

export function activate(api: ExtensionApi): () => void {
  const context = new AzureContext(() => api.connections);
  context.useSetting(settingOf(api.settings));
  api.onSettings?.((values) => context.useSetting(settingOf(values)));
  const watcher = new Watcher(api, context);
  const board = new Board(context, watcher, () => api.connections);
  running = { board, watcher };
  // Absent on an older prifly: optional, like every part added after the first version.
  api.tools?.register(azureTools(context));
  const round = () => {
    watcher.round().catch((error: unknown) => {
      api.log("watch_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  };
  round();
  const timer = setInterval(round, ROUND_MS);
  api.log("activated", { connections: api.connections === undefined ? "absent" : "present" });
  return () => {
    clearInterval(timer);
    running = null;
  };
}

function current(): Running {
  if (running === null) throw new Error("The Azure extension is not running.");
  return running;
}

export function choices(_launchId: string, query: string): Promise<LaunchBoard | LaunchChoice[]> {
  return current().board.choices(query);
}

export function open(_launchId: string, key: string): Promise<LaunchItem> {
  return current().board.open(key);
}

export function launch(_launchId: string, key: string): Promise<Launch> {
  return current().board.launch(key);
}

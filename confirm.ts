/**
 * The text of a confirm card for one Azure change, in the three parts the card
 * has: a plain `summary` sentence, the key settings as `content`, and the
 * technical request (method, URL, resource id, JSON) folded under `details`.
 * `summary` and `content` carry no raw URL and no JSON.
 */

import type { ConfirmSpec } from "@prifly/extension-api";
import { obj, str } from "./azure";
import type { Reach } from "./context";

export type CardCall = {
  method: string;
  url: URL;
  body: unknown;
  /** The subscription's display name, "" when not known. */
  subscriptionName: string;
};

/** What an ARM path points at, in the pieces a sentence needs. */
export type Target = {
  /** The resource id (the path without a trailing action). */
  id: string;
  subscription: string;
  group: string;
  namespace: string;
  /** The plain-words type, "storage account"; "" when the path names none. */
  kind: string;
  name: string;
  /** The POST action at the end of the path ("restart", "listKeys"), "" for none. */
  action: string;
};

const KINDS: Record<string, string> = {
  "microsoft.storage/storageaccounts": "storage account",
  "microsoft.compute/virtualmachines": "virtual machine",
  "microsoft.compute/virtualmachinescalesets": "virtual machine scale set",
  "microsoft.compute/disks": "disk",
  "microsoft.network/virtualnetworks": "virtual network",
  "microsoft.network/networksecuritygroups": "network security group",
  "microsoft.network/publicipaddresses": "public IP address",
  "microsoft.web/sites": "web app",
  "microsoft.web/serverfarms": "app service plan",
  "microsoft.sql/servers": "SQL server",
  "microsoft.sql/servers/databases": "SQL database",
  "microsoft.keyvault/vaults": "key vault",
  "microsoft.containerservice/managedclusters": "Kubernetes cluster",
  "microsoft.authorization/roleassignments": "role assignment",
  "microsoft.resources/resourcegroups": "resource group",
  "microsoft.resources/deployments": "deployment",
};

function words(camel: string): string {
  return camel
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function singular(text: string): string {
  if (/ies$/.test(text)) return `${text.slice(0, -3)}y`;
  if (/(ss|us)$/.test(text) || !text.endsWith("s")) return text;
  return text.slice(0, -1);
}

function kindOf(namespace: string, types: string[]): string {
  const known = KINDS[`${namespace}/${types.join("/")}`.toLowerCase()];
  if (known !== undefined) return known;
  const last = types.at(-1);
  return last === undefined ? "" : singular(words(last));
}

export function targetOf(pathname: string): Target {
  const parts = pathname.split("/").filter((part) => part !== "");
  const lower = parts.map((part) => part.toLowerCase());
  const subscription = parts[lower.indexOf("subscriptions") + 1] ?? "";
  const hasSubscription = lower[0] === "subscriptions" && subscription !== "";
  const groupAt = lower.indexOf("resourcegroups");
  const group = groupAt < 0 ? "" : (parts[groupAt + 1] ?? "");
  const providerAt = lower.lastIndexOf("providers");
  const namespace = providerAt < 0 ? "" : (parts[providerAt + 1] ?? "");
  const base = { subscription: hasSubscription ? subscription : "", group, namespace };
  if (namespace !== "") return { ...base, ...providerPart(parts, providerAt, namespace) };
  if (group !== "") return { ...base, ...scopePart(parts, groupAt + 2, "resource group", group) };
  if (hasSubscription) return { ...base, ...scopePart(parts, 2, "subscription", "") };
  return { ...base, id: pathname, kind: "", name: "", action: "" };
}

/** A path under `providers/<namespace>`: type/name pairs, then maybe an action. */
function providerPart(parts: string[], providerAt: number, namespace: string) {
  const rest = parts.slice(providerAt + 2);
  const action = rest.length % 2 === 1 ? (rest.at(-1) ?? "") : "";
  const pairs = action === "" ? rest : rest.slice(0, -1);
  const types = pairs.filter((_, index) => index % 2 === 0);
  return {
    id: `/${parts.slice(0, providerAt + 2 + pairs.length).join("/")}`,
    kind: kindOf(namespace, types),
    name: pairs.at(-1) ?? "",
    action,
  };
}

/** A path that ends at a resource group or a subscription, `scopeLength` segments long, maybe plus an action. */
function scopePart(parts: string[], scopeLength: number, kind: string, name: string) {
  const rest = parts.slice(scopeLength);
  return {
    id: `/${parts.slice(0, scopeLength).join("/")}`,
    kind,
    name,
    action: rest.length === 1 ? (rest[0] ?? "") : "",
  };
}

/** The display name of a subscription among those reached, "" when it is not. */
export function subscriptionNameIn(reach: readonly Reach[], subscription: string): string {
  for (const each of reach) {
    const found = each.subscriptions.find((sub) => sub.id === subscription);
    if (found !== undefined) return found.name;
  }
  return "";
}

function article(kind: string): string {
  return /^[aeiou]/i.test(kind) ? "an" : "a";
}

/** "the storage account 'mydata'", "the subscription", or a fallback when the path names nothing. */
function subject(target: Target): string {
  if (target.kind === "") {
    return target.namespace === "" ? "an Azure resource" : `the ${target.namespace} provider`;
  }
  return target.name === "" ? `the ${target.kind}` : `the ${target.kind} '${target.name}'`;
}

function place(target: Target, subscriptionName: string): string {
  const group =
    target.group === "" || target.kind === "resource group"
      ? ""
      : ` in resource group '${target.group}'`;
  return `${group}${subscriptionName === "" ? "" : ` (subscription '${subscriptionName}')`}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The short title of the card: "Create or update a storage account". */
function titleOf(method: string, target: Target): string {
  const thing = target.kind === "" ? "Azure resource" : target.kind;
  const what = `${article(thing)} ${thing}`;
  if (method === "DELETE") return `Delete ${what}`;
  if (method === "PUT") return `Create or update ${what}`;
  if (method === "PATCH") return `Update ${what}`;
  return target.action === "" ? `Change ${what}` : `Run '${target.action}' on ${what}`;
}

function summaryOf(method: string, target: Target, subscriptionName: string): string {
  const verb =
    method === "DELETE"
      ? "Deletes"
      : method === "PUT"
        ? "Creates or updates"
        : method === "PATCH"
          ? "Updates"
          : target.action === ""
            ? "Sends a change to"
            : `Runs the action '${target.action}' on`;
  return `${verb} ${subject(target)}${place(target, subscriptionName)}.`;
}

const MAX_LINES = 14;
const MAX_VALUE = 80;

function trimmed(text: string): string {
  return text.length <= MAX_VALUE ? text : `${text.slice(0, MAX_VALUE - 1)}…`;
}

/** A value as one short phrase: no URL, no resource id, no JSON. */
function shown(value: unknown): string {
  if (typeof value === "string") {
    const text = value
      .replace(/https?:\/\/([^/\s]+)\S*/gi, "$1")
      .replace(/\/subscriptions\/\S+/gi, (id) => id.split("/").filter(Boolean).at(-1) ?? id);
    return trimmed(text);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every((each) => typeof each !== "object" || each === null)) {
      return trimmed(value.map(shown).join(", "));
    }
    return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  }
  return String(value);
}

function label(path: string[]): string {
  const text = path.map(words).join(" ");
  return capital(text);
}

/** Every leaf of `value` as ("label", "value"), nested keys joined into the label. */
function flatten(value: Record<string, unknown>, path: string[], out: [string, string][]): void {
  for (const [key, each] of Object.entries(value)) {
    const here = [...path, key];
    if (each === null || each === undefined) continue;
    if (typeof each === "object" && !Array.isArray(each)) {
      const inner = obj(each);
      if (Object.keys(inner).length === 0) continue;
      flatten(inner, here, out);
    } else {
      out.push([label(here), shown(each)]);
    }
  }
}

/** The key settings of a create/update body as "Label: value" lines, most important first. */
export function settingsLines(body: unknown): string[] {
  const root = obj(body);
  const lines: [string, string][] = [];
  const take = (key: string, name: string) => {
    const value = root[key];
    if (typeof value === "string" && value !== "") lines.push([name, shown(value)]);
  };
  take("location", "Location");
  const sku = obj(root["sku"]);
  const skuText = [str(sku["name"]), str(sku["tier"]), str(sku["capacity"])]
    .filter((part) => part !== "")
    .join(", ");
  if (skuText !== "") lines.push(["SKU", skuText]);
  take("kind", "Kind");
  const tags = Object.entries(obj(root["tags"])).map(([key, each]) => `${key}=${shown(each)}`);
  if (tags.length > 0) lines.push(["Tags", trimmed(tags.join(", "))]);
  const identity = str(obj(root["identity"])["type"]);
  if (identity !== "") lines.push(["Identity", identity]);
  const rest = { ...root };
  for (const key of ["location", "sku", "kind", "tags", "identity", "name", "id", "type"]) {
    delete rest[key];
  }
  const more: [string, string][] = [];
  const properties = obj(rest["properties"]);
  delete rest["properties"];
  flatten(properties, [], more);
  flatten(rest, [], more);
  lines.push(...more);
  const shownLines = lines.slice(0, MAX_LINES).map(([name, value]) => `${name}: ${value}`);
  const hidden = lines.length - shownLines.length;
  if (hidden > 0)
    shownLines.push(`… and ${hidden} more ${hidden === 1 ? "setting" : "settings"} (see Details)`);
  return shownLines;
}

function contentOf(method: string, target: Target, body: unknown): string {
  if (method === "DELETE") {
    const everything = target.kind === "resource group" ? " and every resource in it" : "";
    return `This removes ${subject(target)}${everything}. This cannot be undone.`;
  }
  const lines = settingsLines(body);
  if (lines.length === 0) return "No settings are given in the request.";
  return lines.join("\n");
}

function detailsOf(call: CardCall, target: Target): string {
  const body =
    call.body === undefined ? "(no body)" : (JSON.stringify(call.body, null, 2) ?? "null");
  return [
    `Method: ${call.method}`,
    `URL: ${call.url.toString()}`,
    `Resource id: ${target.id}`,
    "",
    "Body:",
    body,
  ].join("\n");
}

/** The whole card for one change. */
export function cardFor(call: CardCall): ConfirmSpec {
  const target = targetOf(call.url.pathname);
  return {
    title: titleOf(call.method, target),
    summary: summaryOf(call.method, target, call.subscriptionName),
    content: contentOf(call.method, target, call.body),
    details: detailsOf(call, target),
  };
}

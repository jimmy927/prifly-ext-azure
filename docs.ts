/**
 * `azure_api_docs`: an operation of Azure Resource Manager as Azure's own
 * OpenAPI specs describe it (github.com/Azure/azure-rest-api-specs), so a
 * session finds the api-version, path, method, parameters and body of a call
 * before making it with `azure_api` — and a changed API is a prompt away, not
 * a new plugin.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { type Json, obj, str } from "./azure";
import { arg, type Kit } from "./kit";
import { jsonText } from "./results";
import { Resolver } from "./schema";
import {
  DocsError,
  type Provider,
  pickFiles,
  type SpecFile,
  type SpecLibrary,
  versionsOf,
} from "./specs";

/** An answer is cut here: the session needs the call's shape, not the whole spec. */
export const MAX_DOCS = 30_000;
/** Matches written out whole, at most; past it they are listed for the session to narrow. */
const MAX_DETAILED = 4;
const LIST_MAX = 80;
const METHODS = ["get", "put", "patch", "post", "delete", "head"];

type Operation = {
  path: string;
  method: string;
  operationId: string;
  summary: string;
  op: Json;
  shared: unknown[];
  file: SpecFile;
};

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function operationsOf(spec: Json, file: SpecFile): Operation[] {
  const out: Operation[] = [];
  for (const bucket of ["paths", "x-ms-paths"]) {
    for (const [path, item] of Object.entries(obj(spec[bucket]))) {
      const shared = list(obj(item)["parameters"]);
      for (const method of METHODS) {
        const op = obj(item)[method];
        if (typeof op !== "object" || op === null) continue;
        const each = obj(op);
        const summary = str(each["summary"]) || str(each["description"]);
        out.push({
          path,
          method,
          operationId: str(each["operationId"]),
          summary,
          op: each,
          shared,
          file,
        });
      }
    }
  }
  return out;
}

/** Whether `path` is of the resource type (`storageAccounts`, `sites/slots`), or an action or child one step below it. */
export function ofType(path: string, provider: string, type: string): boolean {
  const parts = path.split("/").filter((part) => part !== "");
  const at = parts.findIndex(
    (part, index) =>
      part.toLowerCase() === "providers" &&
      parts[index + 1]?.toLowerCase() === provider.toLowerCase(),
  );
  if (at < 0) return false;
  const names = parts.slice(at + 2).filter((part) => !part.startsWith("{"));
  const have = names.join("/").toLowerCase();
  const want = type.toLowerCase().replace(/^\/+|\/+$/g, "");
  return (
    have === want || (have.startsWith(`${want}/`) && names.length === want.split("/").length + 1)
  );
}

/** The operations a keyword names: an operationId exactly, else every word in its id or summary (an HTTP method word, its method). */
export function matching(ops: Operation[], keyword: string): Operation[] {
  const exact = ops.filter((op) => op.operationId.toLowerCase() === keyword.toLowerCase());
  if (exact.length > 0) return exact;
  const words = keyword
    .toLowerCase()
    .split(/[\s_/]+/)
    .filter((word) => word !== "");
  const method = words.find((word) => METHODS.includes(word));
  const rest = words.filter((word) => word !== method);
  return ops.filter((op) => {
    if (method !== undefined && op.method !== method) return false;
    const text = `${op.operationId} ${op.summary}`.toLowerCase();
    return rest.every((word) => text.includes(word));
  });
}

async function detail(specs: SpecLibrary, op: Operation, depth: number): Promise<Json> {
  const params = new Resolver(specs, false);
  const bodies = new Resolver(specs, true);
  const parameters: Json[] = [];
  let body: unknown;
  for (const each of [...op.shared, ...list(op.op["parameters"])]) {
    const found = await params.parameter(each, op.file.url);
    const one = obj(found.node);
    if (one["in"] === "body") {
      body = await bodies.schema(one["schema"], found.base, depth);
      continue;
    }
    parameters.push({
      name: str(one["name"]),
      in: str(one["in"]),
      ...(one["required"] === true ? { required: true } : {}),
      ...(str(one["type"]) === "" ? {} : { type: str(one["type"]) }),
      ...(Array.isArray(one["enum"]) ? { enum: one["enum"].slice(0, 20) } : {}),
    });
  }
  const lro = obj(op.op["x-ms-long-running-operation-options"]);
  const examples = Object.values(obj(op.op["x-ms-examples"]))
    .map((each) => str(obj(each)["$ref"]))
    .filter((ref) => ref !== "")
    .slice(0, 2)
    .map((ref) => new URL(ref, op.file.url).toString());
  return {
    operationId: op.operationId,
    method: op.method.toUpperCase(),
    path: op.path,
    apiVersion: op.file.version,
    ...(op.summary === "" ? {} : { summary: op.summary.slice(0, 400) }),
    ...(op.op["x-ms-long-running-operation"] === true
      ? { longRunning: str(lro["final-state-via"]) || true }
      : {}),
    parameters,
    ...(body === undefined ? {} : { body }),
    responses: Object.keys(obj(op.op["responses"])),
    ...(examples.length === 0 ? {} : { examples }),
    spec: op.file.url,
  };
}

function listing(ops: Operation[]): Json[] {
  return ops.slice(0, LIST_MAX).map((op) => ({
    operationId: op.operationId,
    method: op.method.toUpperCase(),
    path: op.path,
    ...(op.summary === "" ? {} : { summary: op.summary.slice(0, 100) }),
  }));
}

type Ask = {
  provider: string;
  type: string;
  operation: string;
  apiVersion: string;
  service: string;
};

async function written(specs: SpecLibrary, ops: Operation[], head: string): Promise<string> {
  // The deepest `$ref` opening that still fits, so a small schema is shown whole and a big one shallower.
  for (const depth of [6, 5, 4, 3, 2, 1]) {
    const details = [];
    for (const op of ops) details.push(await detail(specs, op, depth));
    const shown = JSON.stringify(details, null, 1);
    if (shown.length <= MAX_DOCS || depth === 1) return jsonText(details, head, MAX_DOCS);
  }
  return head;
}

function headOf(found: Provider, files: SpecFile[]): string {
  const versions = [...new Set(files.map((file) => file.version))].join(", ");
  const groups = [...new Set(files.map((file) => file.group).filter((group) => group !== ""))];
  return `${found.name} (specification/${found.service}), api-version ${versions}${groups.length > 0 ? ` across ${groups.join(", ")}` : ""}${found.truncated ? "; GitHub cut the file list, so some files may be missing" : ""}.`;
}

export async function apiDocs(specs: SpecLibrary, ask: Ask): Promise<string> {
  const found = await specs.provider(ask.provider, ask.service);
  const files = pickFiles(found.files, ask.apiVersion);
  if (files.length === 0) {
    return `No ${ask.apiVersion === "" ? "" : `${ask.apiVersion} `}spec of ${found.name} found. Its api-versions: ${versionsOf(found.files).slice(0, 25).join(", ") || "none"}.`;
  }
  const ops: Operation[] = [];
  for (const file of files) ops.push(...operationsOf(obj(await specs.json(file.url)), file));
  const typed = ask.type === "" ? ops : ops.filter((op) => ofType(op.path, found.name, ask.type));
  const matches = ask.operation === "" ? typed : matching(typed, ask.operation);
  const head = headOf(found, files);
  if (matches.length === 0) {
    return jsonText(
      listing(typed.length > 0 ? typed : ops),
      `${head} Nothing matches ${[ask.type, ask.operation].filter((each) => each !== "").join(" / ")}; these are its operations${typed.length > 0 ? " of that type" : ""}:`,
      MAX_DOCS,
    );
  }
  if (matches.length > MAX_DETAILED) {
    return jsonText(
      listing(matches),
      `${head} ${matches.length} operations match${matches.length > LIST_MAX ? ` (the first ${LIST_MAX} shown)` : ""}: give operation (an operationId, or words such as "put" or "list keys") to see one whole.`,
      MAX_DOCS,
    );
  }
  return written(specs, matches, head);
}

export function docsTool(kit: Kit): ExtensionTool {
  return {
    name: "azure_api_docs",
    description:
      'Looks up an Azure Resource Manager operation in Azure\'s own OpenAPI specs (github.com/Azure/azure-rest-api-specs): the newest stable api-version of the provider, and the operation\'s path, HTTP method, parameters, request body schema (read-only properties left out) and whether it is long-running. Give the provider and resource type (Microsoft.Storage, storageAccounts) and an operationId or words ("create", "put", "list keys"); with few words it lists the type\'s operations. Use it before an unfamiliar azure_api or azure_put_resource call. A read: runs at once.',
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "The resource provider namespace, e.g. Microsoft.Compute; Microsoft.Compute/virtualMachines also works.",
        },
        resourceType: {
          type: "string",
          description: "The resource type, e.g. virtualMachines or sites/slots.",
        },
        operation: {
          type: "string",
          description:
            'An operationId (StorageAccounts_Create) or words in it or its summary ("create", "get", "list keys").',
        },
        apiVersion: {
          type: "string",
          description: "A given api-version instead of the newest stable.",
        },
        service: {
          type: "string",
          description:
            "The folder under specification/ when it is not the provider's name (cosmos-db for Microsoft.DocumentDB).",
        },
      },
      required: ["provider"],
      additionalProperties: false,
    },
    call: async (args) => {
      const [namespace = "", ...rest] = arg(args, "provider").split("/");
      let type = arg(args, "resourceType") || rest.join("/");
      if (type.toLowerCase().startsWith(`${namespace.toLowerCase()}/`))
        type = type.slice(namespace.length + 1);
      if (namespace === "")
        return "Give provider, the resource provider namespace (Microsoft.Storage).";
      try {
        return await apiDocs(kit.specs, {
          provider: namespace,
          type,
          operation: arg(args, "operation"),
          apiVersion: arg(args, "apiVersion"),
          service: arg(args, "service"),
        });
      } catch (error) {
        if (error instanceof DocsError) return error.message;
        if (error instanceof TypeError || error instanceof SyntaxError) {
          return `Could not read the Azure specs from GitHub: ${error.message}`;
        }
        throw error;
      }
    },
  };
}

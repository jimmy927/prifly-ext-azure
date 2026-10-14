/**
 * An OpenAPI schema of an Azure spec made readable for a session: `$ref`s
 * resolved (in the same file, or in another file of the specs repository such
 * as common-types) to a bounded depth, `allOf` merged into one object,
 * descriptions shortened and, for a request body, the read-only properties
 * left out since a PUT cannot set them.
 */

import { type Json, obj } from "./azure";
import { RAW, type SpecLibrary } from "./specs";

const DESCRIPTION_MAX = 200;
const ENUM_MAX = 30;
/** `$ref`s resolved for one answer, at most: past it a ref is named, not opened. */
const MAX_REFS = 400;
const SCALARS = [
  "type",
  "format",
  "default",
  "readOnly",
  "x-ms-mutability",
  "x-ms-secret",
  "minimum",
  "maximum",
];

type Found = { node: unknown; base: string };

function pointerKey(part: string): string {
  return decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
}

function short(text: unknown): string | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX)}…` : text;
}

export class Resolver {
  private readonly specs: SpecLibrary;
  /** Leave out read-only properties: for a request body. */
  private readonly writable: boolean;
  private expanded = 0;

  constructor(specs: SpecLibrary, writable: boolean) {
    this.specs = specs;
    this.writable = writable;
  }

  /** The node `ref` points to, in `base`'s file or the one it names; null when it cannot be read. */
  async at(ref: string, base: string): Promise<Found | null> {
    const [file = "", pointer = ""] = ref.split("#");
    const url = file === "" ? base : new URL(file, base).toString();
    if (!url.startsWith(RAW)) return null;
    let node: unknown = await this.specs.json(url).catch(() => null);
    for (const part of pointer.split("/").filter((each) => each !== "")) {
      node = obj(node)[pointerKey(part)];
      if (node === undefined) return null;
    }
    return node === null ? null : { node, base: url };
  }

  /** A parameter, through its `$ref` when it is one. */
  async parameter(node: unknown, base: string): Promise<Found> {
    const ref = obj(node)["$ref"];
    if (typeof ref !== "string") return { node, base };
    return (await this.at(ref, base)) ?? { node: { name: ref.split("/").at(-1) ?? ref }, base };
  }

  /** `node` as a schema, its refs opened `depth` deep. */
  async schema(
    node: unknown,
    base: string,
    depth: number,
    trail: readonly string[] = [],
  ): Promise<unknown> {
    const here = obj(node);
    const ref = here["$ref"];
    if (typeof ref === "string") return this.ref(ref, base, depth, trail);
    const out = await this.own(here, base, depth, trail);
    await this.members(out, here, base, depth, trail);
    return out;
  }

  /** What a schema says of itself: its type and format, description, enum, items and map values. */
  private async own(
    here: Json,
    base: string,
    depth: number,
    trail: readonly string[],
  ): Promise<Json> {
    const out: Json = {};
    for (const key of SCALARS) if (key in here) out[key] = here[key];
    const description = short(here["description"]);
    if (description !== undefined) out["description"] = description;
    if (Array.isArray(here["enum"])) out["enum"] = here["enum"].slice(0, ENUM_MAX);
    if (here["items"] !== undefined)
      out["items"] = await this.schema(here["items"], base, depth, trail);
    const extra = here["additionalProperties"];
    if (typeof extra === "object" && extra !== null) {
      out["additionalProperties"] = await this.schema(extra, base, depth, trail);
    }
    return out;
  }

  /** Its properties and required ones, with those of each `allOf` part merged in. */
  private async members(
    out: Json,
    here: Json,
    base: string,
    depth: number,
    trail: readonly string[],
  ): Promise<void> {
    const properties: Json = {};
    const required = new Set<string>(
      Array.isArray(here["required"]) ? here["required"].map(String) : [],
    );
    const parts = Array.isArray(here["allOf"]) ? here["allOf"] : [];
    const kept: unknown[] = [];
    for (const part of parts) {
      const merged = obj(await this.schema(part, base, depth, trail));
      if (typeof merged["$ref"] === "string") kept.push(merged);
      for (const [name, value] of Object.entries(obj(merged["properties"])))
        properties[name] = value;
      if (Array.isArray(merged["required"]))
        for (const name of merged["required"]) required.add(String(name));
    }
    for (const [name, value] of Object.entries(obj(here["properties"]))) {
      properties[name] = await this.schema(value, base, depth, trail);
    }
    this.finish(out, properties, required, kept);
  }

  private finish(out: Json, properties: Json, required: Set<string>, kept: unknown[]): void {
    for (const [name, value] of Object.entries(properties)) {
      if (this.writable && obj(value)["readOnly"] === true) delete properties[name];
    }
    if (Object.keys(properties).length > 0) out["properties"] = properties;
    const stillThere = [...required].filter((name) => name in properties);
    if (stillThere.length > 0) out["required"] = stillThere;
    if (kept.length > 0) out["allOf"] = kept;
  }

  private async ref(
    ref: string,
    base: string,
    depth: number,
    trail: readonly string[],
  ): Promise<unknown> {
    const name = ref.split("/").at(-1) ?? ref;
    const key = `${ref.startsWith("#") ? base : new URL(ref.split("#")[0] ?? "", base).toString()}#${ref.split("#")[1] ?? ""}`;
    if (trail.includes(key)) return { $ref: name, note: "recursive: the same as above" };
    if (depth <= 0 || this.expanded >= MAX_REFS)
      return { $ref: name, note: "not opened: too deep" };
    const found = await this.at(ref, base);
    if (found === null) return { $ref: name, note: "not found in the specs" };
    this.expanded += 1;
    return this.schema(found.node, found.base, depth - 1, [...trail, key]);
  }
}

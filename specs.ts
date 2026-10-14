/**
 * Reading Azure's own OpenAPI specs from github.com/Azure/azure-rest-api-specs:
 * the folder of a resource provider (`specification/<service>/resource-manager/
 * <Provider>/`), the spec files of its newest stable api-version (per group,
 * where a provider splits its specs into groups such as ComputeRP and DiskRP),
 * and any JSON file a `$ref` points to. Two GitHub API calls find a provider's
 * files (GitHub allows 60 unsigned calls an hour, so both are kept); the files
 * themselves come from raw.githubusercontent.com.
 */

import { obj, str } from "./azure";

const REPO = "Azure/azure-rest-api-specs";
const BRANCH = "main";
export const GITHUB_API = `https://api.github.com/repos/${REPO}`;
export const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
/** Files read for one answer, at most: a provider with many groups is cut here. */
const MAX_FILES = 12;
const MAX_KEPT = 300;

/** Plain HTTP GET; `globalThis.fetch` in prifly, a fake in tests. */
export type Fetcher = (url: string) => Promise<Response>;

export const defaultFetcher: Fetcher = (url) =>
  fetch(url, {
    headers: { "User-Agent": "prifly-ext-azure", Accept: "application/vnd.github+json" },
  });

/** A provider's folder name differs from its namespace for these. */
const SERVICE_OF: Record<string, string> = {
  "microsoft.documentdb": "cosmos-db",
  "microsoft.insights": "monitor",
  "microsoft.costmanagement": "cost-management",
  "microsoft.cache": "redis",
  "microsoft.dbforpostgresql": "postgresql",
  "microsoft.dbformysql": "mysql",
  "microsoft.managedidentity": "msi",
};

export class DocsError extends Error {}

export type SpecFile = {
  /** The folder of a group of specs below the provider, "" when it has none. */
  group: string;
  channel: "stable" | "preview";
  version: string;
  /** The raw.githubusercontent.com URL. */
  url: string;
};

export type Provider = { service: string; name: string; files: SpecFile[]; truncated: boolean };

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export class SpecLibrary {
  private readonly fetcher: Fetcher;
  private readonly kept = new Map<string, Promise<unknown>>();

  constructor(fetcher: Fetcher = defaultFetcher) {
    this.fetcher = fetcher;
  }

  /** One JSON document, kept for later calls; null when GitHub has no such file. */
  json(url: string): Promise<unknown> {
    const held = this.kept.get(url);
    if (held !== undefined) return held;
    if (this.kept.size >= MAX_KEPT) this.kept.clear();
    const read = this.read(url);
    this.kept.set(url, read);
    read.catch(() => this.kept.delete(url));
    return read;
  }

  private async read(url: string): Promise<unknown> {
    const response = await this.fetcher(url);
    if (response.status === 404) return null;
    if (!response.ok) {
      const limited = response.status === 403 || response.status === 429;
      throw new DocsError(
        `GitHub answered ${response.status} for ${url}${limited ? ": its limit for unsigned calls (60 an hour) is likely reached; try again later" : ""}.`,
      );
    }
    return response.json();
  }

  private async folders(path: string): Promise<{ name: string; sha: string }[] | null> {
    const listed = await this.json(`${GITHUB_API}/contents/${path}?ref=${BRANCH}`);
    if (!Array.isArray(listed)) return null;
    return listed
      .map(obj)
      .filter((each) => each["type"] === "dir")
      .map((each) => ({ name: str(each["name"]), sha: str(each["sha"]) }));
  }

  /** Service folders whose names are close to the provider's, when its likely one held nothing. */
  private async closeServices(provider: string, guess: string): Promise<string[]> {
    const all = (await this.folders("specification")) ?? [];
    const short = squash(provider.replace(/^microsoft\./i, ""));
    return all
      .map((each) => each.name)
      .filter((name) => name !== guess && squash(name).length >= 3)
      .filter((name) => squash(name).includes(short) || short.includes(squash(name)))
      .slice(0, 3);
  }

  /** The provider's folder in one service folder, with every spec file under an api-version of it. */
  private async inService(provider: string, service: string): Promise<Provider | null> {
    const dirs = await this.folders(`specification/${service}/resource-manager`);
    const dir = dirs?.find((one) => one.name.toLowerCase() === provider.toLowerCase());
    if (dir === undefined) return null;
    const tree = obj(await this.json(`${GITHUB_API}/git/trees/${dir.sha}?recursive=1`));
    const base = `${RAW}specification/${service}/resource-manager/${dir.name}/`;
    const entries = Array.isArray(tree["tree"]) ? tree["tree"].map(obj) : [];
    const files = entries.flatMap((entry) => specFile(str(entry["path"]), base));
    return { service, name: dir.name, files, truncated: tree["truncated"] === true };
  }

  /** The provider's specs: in `service` when given, else in its likely folder, else in close ones. */
  async provider(provider: string, service = ""): Promise<Provider> {
    const guess =
      service ||
      (SERVICE_OF[provider.toLowerCase()] ?? provider.replace(/^microsoft\./i, "").toLowerCase());
    const tried = [guess];
    const found = await this.inService(provider, guess);
    if (found !== null) return found;
    if (service === "") {
      for (const each of await this.closeServices(provider, guess)) {
        tried.push(each);
        const close = await this.inService(provider, each);
        if (close !== null) return close;
      }
    }
    throw new DocsError(
      `No folder for ${provider} under specification/<service>/resource-manager/ in ${REPO} (looked in ${tried.join(", ")}). Give service, the folder's name under specification/ (for example "cosmos-db" for Microsoft.DocumentDB).`,
    );
  }
}

const SPEC_PATH = /^(?:(.+)\/)?(stable|preview)\/([^/]+)\/([^/]+\.json)$/;

function specFile(path: string, base: string): SpecFile[] {
  const match = SPEC_PATH.exec(path);
  if (match === null) return [];
  const [, group = "", channel, version = ""] = match;
  return [
    { group, channel: channel === "stable" ? "stable" : "preview", version, url: `${base}${path}` },
  ];
}

/**
 * The files of one api-version: `wanted`, else each group's newest stable one
 * (its newest preview only where a group has no stable version).
 */
export function pickFiles(files: SpecFile[], wanted: string): SpecFile[] {
  if (wanted !== "") return files.filter((file) => file.version === wanted).slice(0, MAX_FILES);
  const groups = new Map<string, SpecFile[]>();
  for (const file of files) groups.set(file.group, [...(groups.get(file.group) ?? []), file]);
  const chosen: SpecFile[] = [];
  for (const inGroup of groups.values()) {
    const stable = inGroup.filter((file) => file.channel === "stable");
    const pool = stable.length > 0 ? stable : inGroup;
    const newest = pool
      .map((file) => file.version)
      .sort()
      .at(-1);
    chosen.push(...pool.filter((file) => file.version === newest));
  }
  return chosen.slice(0, MAX_FILES);
}

/** Every api-version the files offer, newest first, each marked stable or preview. */
export function versionsOf(files: SpecFile[]): string[] {
  const seen = new Set(files.map((file) => `${file.version} (${file.channel})`));
  return [...seen].sort().reverse();
}

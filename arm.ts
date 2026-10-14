/**
 * Azure Resource Manager over prifly's Microsoft connection.
 *
 * Every request goes through `api.connections.fetch`, so prifly holds the
 * token and adds it; this module never sees one. What ARM answers comes back
 * as a typed result rather than a throw: a session's tool turns each kind of
 * failure into words the reader can act on (`results.ts`).
 */

import type { ExtensionConnection, ExtensionConnectionsApi } from "@prifly/extension-api";

export const ARM = "https://management.azure.com";
/** The one scope this extension asks for: Azure Resource Manager as the signed-in user. */
export const ARM_SCOPE = "https://management.azure.com/user_impersonation";

/** Why an ARM call gave nothing. */
export type ArmFailure =
  /** The sign-in ended: for the whole connection (`tenant` null), or only in that tenant. */
  | { kind: "needs-sign-in"; connection: string; account: string; tenant: string | null }
  /** Connected, but Azure access was never granted on the account. */
  | { kind: "not-granted"; connection: string; account: string }
  | { kind: "not-connected" }
  | { kind: "throttled"; retryAfter: string }
  | { kind: "failed"; status: number; code: string; message: string };

export type ArmResult<T> = { ok: true; value: T } | { ok: false; failure: ArmFailure };

export const ARM_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"] as const;
export type ArmMethod = (typeof ARM_METHODS)[number];

export type ArmRequest = {
  /** The tenant the token is for; "" for the account's own. */
  tenant?: string;
  method?: ArmMethod;
  body?: unknown;
};

/** A successful answer whole: its status, the headers an async operation is followed by, and its body. */
export type ArmReply = {
  status: number;
  /** `azure-asyncoperation`, `location` and `retry-after`, lower-cased, when ARM sent them. */
  headers: Record<string, string>;
  /** Parsed JSON; the text when it is not JSON; null when empty (a 202 or a 204). */
  body: unknown;
};

const KEPT_HEADERS = ["azure-asyncoperation", "location", "retry-after"];

function bodyOf(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return text;
  }
}

/** What `fetch` answers when a grant ended; `tenant` only from a prifly that ends tenants alone. */
type Ended = { needsSignIn: { account: string; tenant?: unknown } };

function failed(status: number, code: string, message: string): ArmResult<never> {
  return { ok: false, failure: { kind: "failed", status, code, message } };
}

/** ARM's own error body, `{ error: { code, message } }`, or the status alone. */
async function armError(response: Response): Promise<ArmResult<never>> {
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") ?? "";
    return { ok: false, failure: { kind: "throttled", retryAfter } };
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const inner =
    typeof parsed === "object" && parsed !== null && "error" in parsed ? parsed.error : null;
  const field = (name: string) =>
    typeof inner === "object" && inner !== null && name in inner
      ? String((inner as Record<string, unknown>)[name])
      : "";
  return failed(response.status, field("code"), field("message") || text.slice(0, 300));
}

/**
 * One connected Microsoft account, as ARM sees it. `deadTenants` is this
 * extension's own note of tenants whose sign-in alone ended, kept across
 * calls: an older prifly does not say which tenant it was.
 */
export class ArmClient {
  readonly connection: ExtensionConnection;
  private readonly connections: ExtensionConnectionsApi;
  private readonly deadTenants: Set<string>;

  constructor(
    connections: ExtensionConnectionsApi,
    connection: ExtensionConnection,
    deadTenants: Set<string>,
  ) {
    this.connections = connections;
    this.connection = connection;
    this.deadTenants = deadTenants;
  }

  /** Tenants whose sign-in alone ended: prifly's own list where it keeps one, and ours. */
  tenantsNeedingSignIn(): string[] {
    const hosts = (this.connection as { tenantsNeedingSignIn?: unknown }).tenantsNeedingSignIn;
    const fromHost = Array.isArray(hosts) ? hosts.filter((each) => typeof each === "string") : [];
    return [...new Set([...fromHost, ...this.deadTenants])];
  }

  private ended(tenant: string | null): ArmResult<never> {
    const { id, account } = this.connection;
    return { ok: false, failure: { kind: "needs-sign-in", connection: id, account, tenant } };
  }

  /** One ARM call, its body only: `path` is everything after the host, its `api-version` included. */
  async request(path: string, how: ArmRequest = {}): Promise<ArmResult<unknown>> {
    const sent = await this.send(path, how);
    return sent.ok ? { ok: true, value: sent.value.body } : sent;
  }

  /** One ARM call, its status and async-operation headers kept beside the body. */
  async send(path: string, how: ArmRequest = {}): Promise<ArmResult<ArmReply>> {
    const tenant = how.tenant ?? "";
    if (tenant !== "" && this.tenantsNeedingSignIn().includes(tenant)) return this.ended(tenant);
    const init: RequestInit = { method: how.method ?? "GET" };
    if (how.body !== undefined) {
      init.body = JSON.stringify(how.body);
      init.headers = { "Content-Type": "application/json" };
    }
    const answer = await this.connections.fetch(this.connection.id, `${ARM}${path}`, {
      ...init,
      resource: ARM,
      ...(tenant === "" ? {} : { tenant }),
    });
    if ("needsSignIn" in answer) return this.signInEnded(answer, tenant);
    if (!answer.ok) return armError(answer);
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const value = answer.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const body = bodyOf(await answer.text());
    return { ok: true, value: { status: answer.status, headers, body } };
  }

  private signInEnded(answer: Ended, asked: string): ArmResult<never> {
    const told = answer.needsSignIn.tenant;
    const tenant = typeof told === "string" ? told : asked === "" ? null : asked;
    if (tenant !== null) this.deadTenants.add(tenant);
    return this.ended(tenant);
  }

  /** Every page of a listing (`value` and `nextLink`), up to `cap` items. */
  async list(path: string, how: ArmRequest = {}, cap = 1000): Promise<ArmResult<unknown[]>> {
    const items: unknown[] = [];
    let next: string | null = path;
    while (next !== null && items.length < cap) {
      const page = await this.request(next, how);
      if (!page.ok) return page;
      const { value, nextLink } = page.value as { value?: unknown; nextLink?: unknown };
      if (Array.isArray(value)) items.push(...value);
      next =
        typeof nextLink === "string" && nextLink.startsWith(ARM)
          ? nextLink.slice(ARM.length)
          : null;
    }
    return { ok: true, value: items.slice(0, cap) };
  }
}

/**
 * The account Azure is read through: the first Microsoft connection that
 * granted Azure access, else the first one at all (to say it needs granting).
 */
export function pickConnection(
  connections: ExtensionConnectionsApi,
): ArmResult<ExtensionConnection> {
  const all = connections.list("microsoft");
  const granted = all.find((each) => each.scopes.includes(ARM_SCOPE));
  const chosen = granted ?? all[0];
  if (chosen === undefined) return { ok: false, failure: { kind: "not-connected" } };
  const { id, account } = chosen;
  if (chosen.state === "needs-sign-in") {
    return { ok: false, failure: { kind: "needs-sign-in", connection: id, account, tenant: null } };
  }
  if (granted === undefined) {
    return { ok: false, failure: { kind: "not-granted", connection: id, account } };
  }
  return { ok: true, value: chosen };
}

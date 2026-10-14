/** The words a session's tool returns: JSON for what Azure answered, a sentence for why it gave nothing. */

import type { ArmFailure } from "./arm";

/** Longer answers are cut here, with a note: a session's context is not a dump. */
export const MAX_TEXT = 60_000;

/** `value` as indented JSON, after an optional line of `note`, cut at `max` characters. */
export function jsonText(value: unknown, note = "", max = MAX_TEXT): string {
  const body = JSON.stringify(value, null, 1) ?? "null";
  const cut = body.length > max ? `${body.slice(0, max)}\n… cut at ${max} characters` : body;
  return note === "" ? cut : `${note}\n${cut}`;
}

/** Why ARM gave nothing. For a missing sign-in this is the reason only; `access.ts` adds what was done about it. */
export function failureText(failure: ArmFailure): string {
  switch (failure.kind) {
    case "not-connected":
      return "No Microsoft account is connected to prifly.";
    case "not-granted":
      return `Azure access is not granted on ${failure.account} yet.`;
    case "needs-sign-in":
      return failure.tenant === null
        ? `The Microsoft sign-in for ${failure.account} ended.`
        : `The sign-in for ${failure.account} ended in tenant ${failure.tenant} only (it asks for a fresh sign-in, often MFA); other tenants still work.`;
    case "throttled":
      return `Azure is throttling these requests${failure.retryAfter === "" ? "" : `; retry after ${failure.retryAfter} s`}.`;
    case "failed":
      return `Azure answered ${failure.status}${failure.code === "" ? "" : ` ${failure.code}`}: ${failure.message}`;
  }
}

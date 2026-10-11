/** The words a session's tool returns when ARM gave nothing: what happened, and what the reader can do. */

import type { ArmFailure } from "./arm";

export function failureText(failure: ArmFailure): string {
  switch (failure.kind) {
    case "not-connected":
      return "No Microsoft account is connected: connect one in prifly's Vault → Connections, then grant Azure access from the launcher From an Azure resource….";
    case "not-granted":
      return `Azure access is not granted on ${failure.account} yet: open the launcher From an Azure resource… in prifly and pick Grant Azure access.`;
    case "needs-sign-in":
      return failure.tenant === null
        ? `The Microsoft sign-in for ${failure.account} ended: sign in again in prifly's Vault → Connections. Do not retry until the reader has.`
        : `The sign-in for ${failure.account} ended in tenant ${failure.tenant} only (it asks for a fresh sign-in, often MFA): the reader can sign in again there from the launcher From an Azure resource…. Other tenants still work.`;
    case "throttled":
      return `Azure is throttling these requests${failure.retryAfter === "" ? "" : `; retry after ${failure.retryAfter} s`}.`;
    case "failed":
      return `Azure answered ${failure.status}${failure.code === "" ? "" : ` ${failure.code}`}: ${failure.message}`;
  }
}

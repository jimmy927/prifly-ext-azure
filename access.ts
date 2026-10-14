/**
 * When Azure cannot be reached for want of a sign-in, a tool says why and
 * starts the sign-in itself: `api.connections.signIn` opens the Microsoft page
 * in the reader's browser. The tool does not wait for it (the reader may take
 * minutes); the next call after they finish goes through. One sign-in of a
 * kind runs at a time, and one that did not finish is told on the next call.
 */

import { ARM_SCOPE, type ArmFailure } from "./arm";
import type { AzureContext } from "./context";
import { failureText } from "./results";

type SignInAsk = {
  key: string;
  scopes: string[];
  options: { connection?: string; tenant?: string };
  tenant: string | null;
  purpose: string;
};

function askFor(failure: ArmFailure): SignInAsk | null {
  switch (failure.kind) {
    case "not-connected":
      return {
        key: "connect",
        scopes: [ARM_SCOPE],
        options: {},
        tenant: null,
        purpose: "connect a Microsoft account with Azure access",
      };
    case "not-granted":
      return {
        key: `grant:${failure.connection}`,
        scopes: [ARM_SCOPE],
        options: { connection: failure.connection },
        tenant: null,
        purpose: `grant Azure access on ${failure.account}`,
      };
    case "needs-sign-in":
      return failure.tenant === null
        ? {
            key: `sign-in:${failure.connection}`,
            scopes: [],
            options: { connection: failure.connection },
            tenant: null,
            purpose: `sign ${failure.account} in again`,
          }
        : {
            // `tenant` is read by a prifly that signs in at one tenant; an older one signs the account in whole.
            key: `sign-in:${failure.connection}:${failure.tenant}`,
            scopes: [],
            options: { connection: failure.connection, tenant: failure.tenant },
            tenant: failure.tenant,
            purpose: `sign ${failure.account} in again to tenant ${failure.tenant}`,
          };
    default:
      return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Access {
  private readonly context: AzureContext;
  private readonly onSignedIn: () => void;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly unfinished = new Map<string, string>();

  /** `onSignedIn` runs after a sign-in a tool started went through. */
  constructor(context: AzureContext, onSignedIn: () => void = () => undefined) {
    this.context = context;
    this.onSignedIn = onSignedIn;
  }

  /** Why Azure gave nothing; for a missing sign-in, also that its page was opened. */
  explain(failure: ArmFailure): string {
    const reason = failureText(failure);
    const ask = askFor(failure);
    if (ask === null) return reason;
    const connections = this.context.connections();
    if (connections === undefined) {
      return `${reason} This prifly cannot open a sign-in from a tool: connect Microsoft in prifly's Vault → Connections.`;
    }
    if (this.pending.has(ask.key)) {
      return `${reason} The Microsoft page to ${ask.purpose} is already open in the reader's browser: ask them to finish it there, then call the tool again.`;
    }
    const before = this.unfinished.get(ask.key);
    this.unfinished.delete(ask.key);
    const run = connections
      .signIn("microsoft", ask.scopes, ask.options)
      .then(
        (signed) => {
          if (signed.ok) {
            this.context.revived(signed.connection, ask.tenant);
            this.onSignedIn();
            return;
          }
          const admin =
            signed.adminConsentUrl === undefined
              ? ""
              : ` (only the tenant's admin can approve prifly, at ${signed.adminConsentUrl})`;
          this.unfinished.set(ask.key, `${signed.message}${admin}`);
        },
        (error: unknown) => void this.unfinished.set(ask.key, messageOf(error)),
      )
      .finally(() => this.pending.delete(ask.key));
    this.pending.set(ask.key, run);
    const last = before === undefined ? "" : ` The last try did not finish: ${before}.`;
    return `${reason}${last} prifly opened the Microsoft page to ${ask.purpose} in the reader's browser: ask them to finish it there, then call the tool again.`;
  }

  /** Every sign-in started so far has finished (for tests). */
  async settled(): Promise<void> {
    await Promise.all(this.pending.values());
  }
}

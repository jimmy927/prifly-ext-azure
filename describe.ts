/**
 * One resource or one failed deployment written out: as the card prifly
 * opens on the board, and as the first prompt of a session started from it.
 * The session starts knowing the resource, its group's recent deployments
 * and the last day of its Activity Log, so it can begin without asking.
 */

import type { ArmClient } from "./arm";
import { activity, deployments, resource, subscriptionOf } from "./azure";
import type { AzureContext, Reach } from "./context";
import { failureText } from "./results";

const PROPERTIES_MAX = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Described = { title: string; url: string; markdown: string; name: string };

export function portalUrl(id: string, domain: string): string {
  return `https://portal.azure.com/#${domain === "" ? "" : `@${domain}`}/resource${id}`;
}

function groupOf(id: string): string {
  return /\/resourcegroups\/([^/]+)/i.exec(id)?.[1] ?? "";
}

function lastSegment(id: string): string {
  return (
    id
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? id
  );
}

/** A session or worktree name from a resource name: lower-case words joined by hyphens. */
function nameOf(words: string): string {
  return words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function recentDeployments(arm: ArmClient, id: string, tenant: string): Promise<string> {
  const group = groupOf(id);
  if (group === "") return "";
  const listed = await deployments(arm, {
    subscription: subscriptionOf(id),
    group,
    tenant,
    failedOnly: false,
    top: 5,
  });
  if (!listed.ok) return `\n## Recent deployments of ${group}\n\n${failureText(listed.failure)}\n`;
  const lines = listed.value.map(
    (each) =>
      `- ${each.timestamp} ${each.name}: ${each.state}${each.error === "" ? "" : ` (${each.error})`}`,
  );
  return `\n## Recent deployments of ${group}\n\n${lines.join("\n") || "None."}\n`;
}

async function lastDay(arm: ArmClient, id: string, tenant: string, now: number): Promise<string> {
  const since = new Date(now - DAY_MS).toISOString();
  const read = await activity(arm, { id, since, tenant, top: 20 });
  if (!read.ok) return `\n## Activity Log, last 24 hours\n\n${failureText(read.failure)}\n`;
  const lines = read.value.map(
    (each) =>
      `- ${each.at} ${each.operation}: ${each.status}${each.caller === "" ? "" : ` by ${each.caller}`}`,
  );
  return `\n## Activity Log, last 24 hours\n\n${lines.join("\n") || "Nothing."}\n`;
}

const TOOLS_LINE =
  "Use the prifly tools mcp__prifly__azure_get, azure_query, azure_subscriptions and azure_cost to read more; they use the reader's Microsoft connection, so do not use the az CLI. They are read-only: propose any change to Azure for the reader to make.";

/** A resource by its ARM id, written out. */
export async function describeResource(
  arm: ArmClient,
  context: AzureContext,
  reach: Reach[],
  id: string,
  now: number,
): Promise<Described> {
  const tenant = context.tenantOf(reach, subscriptionOf(id));
  const tenantId = tenant?.id ?? "";
  const read = await resource(arm, id, "", tenantId);
  const name = lastSegment(id);
  let facts: string;
  if (read.ok) {
    const { properties, ...top } = read.value;
    const shown = JSON.stringify(properties ?? {}, null, 1);
    const cut = shown.length > PROPERTIES_MAX ? `${shown.slice(0, PROPERTIES_MAX)}\n… cut` : shown;
    facts = `\`\`\`json\n${JSON.stringify(top, null, 1)}\n\`\`\`\n\n## Properties\n\n\`\`\`json\n${cut}\n\`\`\`\n`;
  } else {
    facts = `${failureText(read.failure)}\n`;
  }
  const markdown =
    `# Azure resource ${name}\n\n\`${id}\`\n\nTenant: ${tenant?.name ?? "the account's own"}\n\n${facts}` +
    (await recentDeployments(arm, id, tenantId)) +
    (await lastDay(arm, id, tenantId, now)) +
    `\n${TOOLS_LINE}\n`;
  return { title: name, url: portalUrl(id, tenant?.domain ?? ""), markdown, name: nameOf(name) };
}

async function failedOperations(arm: ArmClient, id: string, tenant: string): Promise<string> {
  const read = await arm.list(`${id}/operations?api-version=2021-04-01`, { tenant }, 50);
  if (!read.ok) return `\n## Failed operations\n\n${failureText(read.failure)}\n`;
  const lines = read.value.flatMap((row) => {
    const properties = (row as { properties?: Record<string, unknown> }).properties ?? {};
    if (properties["provisioningState"] !== "Failed") return [];
    const target = (properties["targetResource"] as { id?: unknown } | undefined)?.id;
    const message = JSON.stringify(properties["statusMessage"] ?? "").slice(0, 600);
    return [`- ${typeof target === "string" ? target : "(no target)"}: ${message}`];
  });
  return `\n## Failed operations\n\n${lines.join("\n") || "None listed."}\n`;
}

/** A deployment by its ARM id, written out with what failed in it. */
export async function describeDeployment(
  arm: ArmClient,
  context: AzureContext,
  reach: Reach[],
  id: string,
): Promise<Described> {
  const tenant = context.tenantOf(reach, subscriptionOf(id));
  const tenantId = tenant?.id ?? "";
  const name = lastSegment(id);
  const read = await arm.request(`${id}?api-version=2021-04-01`, { tenant: tenantId });
  const facts = read.ok
    ? `\`\`\`json\n${JSON.stringify(read.value, null, 1).slice(0, PROPERTIES_MAX)}\n\`\`\`\n`
    : `${failureText(read.failure)}\n`;
  const markdown =
    `# Failed Azure deployment ${name}\n\n\`${id}\`\n\nResource group: ${groupOf(id)}\n\n${facts}` +
    (await failedOperations(arm, id, tenantId)) +
    (await recentDeployments(arm, id, tenantId)) +
    `\nFind why it failed and what would fix it.\n\n${TOOLS_LINE}\n`;
  return {
    title: `${name} failed`,
    url: portalUrl(id, tenant?.domain ?? ""),
    markdown,
    name: nameOf(`${name}-failed`),
  };
}

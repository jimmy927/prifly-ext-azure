# prifly-ext-azure

Your Azure tenants, subscriptions and resources in prifly, read through the
Microsoft account you connected in prifly's Vault → Connections. Nothing to
install and no `az` CLI: every call is Azure Resource Manager over HTTPS, and
prifly holds the token.

Read-only. Nothing here changes Azure.

## What it gives you

- **Tools for every session** (`mcp__prifly__azure_*`):
  - `azure_tenants`: the tenants your account reaches, and any that needs a fresh sign-in.
  - `azure_subscriptions`: subscriptions across every tenant.
  - `azure_query`: a Resource Graph (KQL) query, paged up to `top` rows.
  - `azure_get`: one resource by its ARM id, with the newest stable api-version.
  - `azure_cost`: actual cost of a subscription, daily or grouped by resource group, service or resource.
- **The launcher "From an Azure resource…"**: a board of the shown subscription's resources, one column per resource group, after a column of the deployments that failed in the last day. A picked resource starts a session that already knows it, its group's recent deployments and its last day of Activity Log. Granting Azure access, signing a tenant in again and switching subscription are rows on the same board.
- **A status-bar chip**: which account and tenant Azure is read as, warning when a tenant needs signing in again.
- **A light watch**: every fifteen minutes, failed deployments, 25 resource groups per round. A new failure lights the launcher and shows a notice.

## Access

The manifest asks for one Microsoft scope, `https://management.azure.com/user_impersonation`. It is optional, so connecting a Microsoft account for something else never asks for Azure. Pick **Grant Azure access** on the board when you want it.

A guest tenant that demands a fresh sign-in (MFA, a claims challenge) is cut off alone. Your own tenant keeps working, and the board offers **Sign in again to <tenant>**. On a prifly older than per-tenant sign-in, that row signs the whole account in again.

The setting **Subscription to show** (a name or an id) fixes the board's subscription. Left empty, the board shows the one you last picked there, else the first enabled one.

## Develop

```sh
bun install
bun test && bun run typecheck && bun run check
```

The types come from `@prifly/extension-api`, at a tag of `jimmy927/prifly-extension-api`.

| File | What it is |
|---|---|
| `arm.ts` | ARM over `api.connections.fetch`: typed results, paging, the per-tenant sign-in note |
| `azure.ts` | Each read: tenants, subscriptions, Resource Graph, one resource, costs, deployments, Activity Log |
| `context.ts` | The chosen account, tenants and subscriptions (kept ten minutes), the shown subscription |
| `tools.ts` | The five session tools |
| `board.ts` / `describe.ts` | The launcher's board, its setup rows, and what a picked resource or deployment says |
| `watch.ts` | The fifteen-minute watch and the status-bar chip |
| `results.ts` | The words for each kind of failure |
| `test/fake-arm.ts` | A fake ARM behind a fake `api.connections`: two tenants, one guest, and the ways it can fail |

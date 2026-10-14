# prifly-ext-azure

Azure for every prifly session, through the Microsoft account you connected in
prifly's Vault → Connections. Nothing to install and no `az` CLI: every call is
Azure Resource Manager over HTTPS, and prifly holds the token.

There is no board, launcher or chip. You ask any session in plain words ("what
is the latest Azure billing", "list my VMs", "create a storage account") and it
answers through the tools below. Reads run at once; every change waits for your
Confirm on a card that shows the exact request.

## Tools (`mcp__prifly__azure_*`)

Reads, run at once:

- `azure_tenants`: the tenants your account reaches, and any that needs a fresh sign-in.
- `azure_subscriptions`: subscriptions across every tenant, or one tenant's.
- `azure_query`: a Resource Graph (KQL) query, paged up to `top` rows.
- `azure_get`: one resource by its ARM id, with the newest stable api-version.
- `azure_cost`: actual cost of a subscription (or of each one reached, when none is named), daily or grouped by resource group, service or resource.
- `azure_api_docs`: an operation as Azure's own OpenAPI specs describe it (github.com/Azure/azure-rest-api-specs): the provider's newest stable api-version, and the operation's path, method, parameters and body schema, `$ref`s resolved to a bounded depth and trimmed.
- `azure_wait_operation`: follows an accepted long-running operation (its Azure-AsyncOperation or Location URL) at its Retry-After pace until it succeeds, fails or is cancelled, or the timeout passes.

Changes, each shown on a confirm card first (method, full URL with api-version, JSON body):

- `azure_put_resource`: create or update one resource by its id.
- `azure_delete_resource`: delete one resource by its id.
- `azure_api`: any ARM call, by path or `https://management.azure.com` URL (no other host). GET and HEAD run at once, as do the Resource Graph query and the Cost Management `query` and `forecast` POSTs; PUT, PATCH, DELETE and every other POST (`listKeys` included, since it reveals secrets) confirm first.

On Cancel nothing is sent and the tool answers `Not done: you cancelled`. A prifly too old to show a confirm card gets no change at all.

The session prompt the extension adds (`prompt.md`) tells sessions how to use these.

## Access

The manifest asks for one Microsoft scope, `https://management.azure.com/user_impersonation`. It is optional, so connecting a Microsoft account for something else never asks for Azure. When a tool finds no Microsoft account, no Azure grant, or a sign-in that ended, it says so and opens the Microsoft sign-in page in your browser itself; the next call after you finish goes through.

A guest tenant that demands a fresh sign-in (MFA, a claims challenge) is cut off alone: your own tenant keeps working, and asking for that tenant (`azure_subscriptions` with its id, or any call into it) opens its sign-in.

Settings → Extensions shows one line for Azure, read at most every fifteen minutes: `Connected · 3 subscriptions (Northwind Retail, Contoso Labs)`, or why it is not connected.

## Develop

```sh
bun install
bun test && bun run typecheck && bun run check
```

The types come from `@prifly/extension-api`, at a tag of `jimmy927/prifly-extension-api` (v0.6.0: `api.confirm` and `api.status`).

| File | What it is |
|---|---|
| `arm.ts` | ARM over `api.connections.fetch`: typed results, status and async headers, paging, the per-tenant sign-in note |
| `azure.ts` | Each curated read: tenants, subscriptions, Resource Graph, one resource, the newest api-version, costs |
| `context.ts` | The chosen account, and the tenants and subscriptions it reaches (kept ten minutes) |
| `access.ts` | Why access is missing, and starting the sign-in that fixes it |
| `kit.ts` | What every tool is built from |
| `tools.ts` | The read tools, and the list of every tool |
| `writes.ts` | `azure_api`, `azure_put_resource`, `azure_delete_resource`, and the rule for what confirms |
| `wait.ts` | `azure_wait_operation` |
| `docs.ts` / `specs.ts` / `schema.ts` | `azure_api_docs`: finding and reading the specs on GitHub, and resolving their schemas |
| `status.ts` | The status line |
| `results.ts` | The words for each kind of failure, and JSON answers |
| `test/fake-arm.ts` | A fake ARM behind a fake `api.connections`: two tenants, one guest, a storage account to create and delete, and the ways it can fail |
| `test/fake-api.ts` | A fake `api`, its confirm cards and status lines kept to look at |

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.

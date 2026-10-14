## Azure

The prifly tools `mcp__prifly__azure_*` reach the reader's Azure through their connected Microsoft account. Use them for anything in Azure instead of the az CLI or the portal.

Reads run at once:
- `azure_tenants` and `azure_subscriptions`: what the account reaches.
- `azure_query`: a Resource Graph (KQL) query across subscriptions, e.g. to list VMs: `resources | where type =~ 'microsoft.compute/virtualmachines' | project name, resourceGroup, location, properties.hardwareProfile.vmSize`.
- `azure_get`: one resource by its ARM id.
- `azure_cost`: actual cost over a period (default the last 30 days, or the current month with `from`); for "the latest billing" call it without a subscription and it answers for every subscription the account reaches.
- `azure_api_docs`: an operation as Azure's own OpenAPI specs describe it: the newest stable api-version, path, method, parameters and body schema.
- `azure_wait_operation`: follows an operation that a change answered with (201 or 202 and an operation URL) until it succeeds, fails or the wait runs out.

Changes wait for the reader: `azure_put_resource` (create or update a resource), `azure_delete_resource`, and `azure_api` with PUT, PATCH, DELETE or a POST other than a Resource Graph or Cost Management query each show the reader a confirm card with the method, full URL and body, and run only on Confirm. When a tool answers "Not done: you cancelled", nothing was sent: do not retry it unasked.

`azure_api` calls any Azure Resource Manager endpoint (an ARM path or a https://management.azure.com URL) with an api-version. Before an unfamiliar `azure_api` or `azure_put_resource` call, look the operation up with `azure_api_docs` to get its api-version and body shape rather than guessing them.

When a long-running change is accepted, follow it with `azure_wait_operation` and report how it ended.

When Microsoft access is missing, has no Azure grant, or a tenant's sign-in ended, the tool says so and opens the Microsoft sign-in page in the reader's browser itself. Tell the reader to finish it there, then call the tool again.

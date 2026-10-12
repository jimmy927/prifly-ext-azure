---
setup:
  - bun install --frozen-lockfile
---

One install, from `bun.lock`. It brings biome, TypeScript, `@types/bun` and the types package
`@prifly/extension-api`, all as dev dependencies. After it, `bun test`, `bun run typecheck` and
`bun run check` run as `package.json` names them.

What the install relies on outside the worktree:

- `bun` on PATH.
- SSH access to GitHub as a user who can read the private repository
  `jimmy927/prifly-extension-api`. `@prifly/extension-api` is installed from
  `git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.1.0`, so the install fails
  without the key.

The tests need nothing else: they run against a fake ARM (`test/fake-arm.ts`). No Azure login,
no network and no prifly host are needed.

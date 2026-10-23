# Dependency licenses

## Policy

The product is commercially distributable: only dependencies with permissive licenses are allowed.

- **Allowed**: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, PostgreSQL.
- **Forbidden**: GPL, LGPL, AGPL, SSPL and "source available" licenses.
- SPDX expressions: `A OR B` is allowed if either one is; `A AND B` only if both are.
- **Approved exceptions** (`licenses.exceptions.json`, with reason and approval):

| Package | License      | Reason                                                    |
| ------- | ------------ | --------------------------------------------------------- |
| `tslib` | 0BSD         | Used by Radix UI (the base of shadcn/ui); no obligations. |
| `isbot` | Unlicense    | Used by TanStack Router/Start; public domain.             |
| `pako`  | MIT AND Zlib | Used by isomorphic-git; Zlib is permissive.               |

## How the check works

1. Web and worker are compiled into complete bundles: the images contain no `node_modules`, so what is distributed is
   exactly what is in the bundles.
2. During the build, the `scripts/vite-plugin-third-party.mjs` plugin records every third-party package included in
   the bundles and copies its LICENSE, NOTICE and COPYING files into `dist/third-party-licenses/`, which ends up in
   the images.
3. `pnpm licenses:check` reads these inventories and fails if it finds a license that is neither allowed nor
   approved, or if an Apache-2.0 package with a NOTICE file did not have it copied.
4. `pnpm licenses:report` also lists the licenses of every installed package, including build and development
   tools, flagging those that are not distributed.

The check runs in CI and inside the Docker build: an image with a forbidden license is never produced.

### WebAssembly grammars

The tree-sitter runtime and grammars ship as `.wasm` files next to the worker bundle, not as JavaScript, so
`scripts/vite-plugin-grammars.mjs` copies them into `dist/grammars/` and records their packages (all MIT:
`web-tree-sitter` and the `tree-sitter-*` grammars) in `dist/third-party-licenses/grammars.json`, with their license
files. The license check reads this inventory like the others.

### AI SDK

`ai`, `@ai-sdk/openai-compatible` and their `@ai-sdk/*` dependencies (including `@ai-sdk/gateway`, which `ai`
imports but the product never uses) and `@vercel/oidc` are Apache-2.0; `zod` (a peer dependency of the AI SDK) and
`eventsource-parser` are MIT. Their LICENSE files ship in `third-party-licenses/`. Models are not distributed: the
license of the model deployed on premise is the operator's responsibility.

## Build tools

Some tools used only at build time have licenses outside the list (for example lightningcss, MPL-2.0, used by
Tailwind; caniuse-lite, CC-BY-4.0). They do not end up in the bundles, so they are not distributed.

## Adding a dependency

1. Check its license before installing it (`npm view <package> license`).
2. Pin the exact version (the project uses `save-exact`).
3. Run `pnpm build && pnpm licenses:check`.
4. If an exception is needed, it must be approved and recorded in `licenses.exceptions.json`.

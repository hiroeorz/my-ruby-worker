# Repository Guidelines

## 言語

- すべてのやり取りは日本語で行う。

## Project Structure & Module Organization

- Core Worker logic lives in `src/index.ts`; keep the default export aligned with Cloudflare Worker expectations (`fetch(request, env, ctx)`).
- Shared typing helpers belong in `worker-configuration.d.ts`; regenerate env typings with `npm run cf-typegen` whenever `wrangler.jsonc` bindings change.
- Tests sit under `test/`, with Vitest configs scoped locally (`test/tsconfig.json`, `env.d.ts`). Mirror production file names, e.g. `src/foo.ts` pairs with `test/foo.spec.ts`.

## Build, Test, and Development Commands

- `npm run dev`: Launches Wrangler’s local dev server at `http://localhost:8787`, hot-reloading Worker code.
- `npm run test`: Runs Vitest using the Cloudflare Worker pool; rely on this before every PR.
- `npm run cf-typegen`: Regenerates type definitions for bound resources.
- `npm run deploy`: Publishes the Worker via Wrangler; only run once PRs merge and secrets are configured.

## Coding Style & Naming Conventions

- Write TypeScript using ES modules; prefer arrow functions for callbacks and named exports for helpers.
- Match the repository’s tab-indented style and limit line length to roughly 100 characters for readability.
- Name Workers and modules with concise, kebab-case file names (`request-router.ts`) and camelCase symbols (`handleRequest`).
- Use explicit return types on exported functions to keep type checks predictable in Wrangler.

## Testing Guidelines

- Tests use Vitest with `@cloudflare/vitest-pool-workers`; favor integration-style assertions with `SELF.fetch` when exercising routing.
- Name test files `*.spec.ts` and describe blocks with the user-facing behavior (`describe('Hello World worker', ...)`).
- Ensure new tests await `waitOnExecutionContext(ctx)` when using execution contexts, preventing leaked Promises.
- Aim to cover edge cases tied to Durable Objects or KV usage before deploying.

## Commit & Pull Request Guidelines

- Follow the existing history’s style: short, imperative commit subjects (`Add rate limiting middleware`), optional body wrapping at 72 chars.
- Each PR should document intent, key changes, and include `npm run test` output or a note about skipped suites.
- Link related issues in the PR description and call out any required Wrangler config or secret changes.
- Provide screenshots or cURL snippets when behavior changes responses exposed by the Worker.

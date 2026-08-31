# Contributing

Bug reports and patches are welcome. Read [AGENTS.md](AGENTS.md) before changing anything —
it documents the layout and, more usefully, the mistakes this codebase has already made
around statelessness, write versioning, attachment ordering and semantic search.

## Setup

```bash
mise install
mise exec -- bun install
cp .dev.vars.example .dev.vars   # fill in your own Zotero and WebDAV credentials
mise exec -- bun run dev
```

You need a Zotero account with an API key and a WebDAV server for anything beyond unit tests.
`mise exec -- bun test` needs neither — it stubs `fetch`.

## Before you open a pull request

Run what CI runs:

```bash
mise exec -- bun run format:check
mise exec -- bun run lint
mise exec -- bun run typecheck
mise exec -- bun test
```

`mise exec -- bun run format` fixes formatting. CI also does `mise exec -- bun x wrangler deploy --dry-run` to catch imports
that do not survive the Workers runtime; it needs no credentials, so a fork's PR runs it too.

## Things worth knowing

**Adding a tool** has a checklist in [AGENTS.md](AGENTS.md#adding-a-tool). The parts people
miss: `assertWritable(context)` on every write tool, and putting anything the model needs into
`structuredContent` rather than only into the Markdown.

**Anything touching files** is only really verified by syncing Zotero Desktop afterwards and
confirming the item, the file and the filename all landed. `scripts/e2e.ts --write` runs the
full create → upload → read → rename → delete cycle, but against your real library — expect it
to leave traces if it fails partway.

**Dependency upgrades are manual.** Run `mise exec -- bun update` and commit `bun.lock` in the same commit
as `package.json` — CI installs with `--frozen-lockfile`, so a bump without its lockfile fails
before any test runs. Dependabot only opens security PRs here, for the same reason.

**Commits** follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), matching
the existing history.

## Scope

This is a single-tenant server for one person's library, and that constraint keeps it small.
Changes that turn it into a multi-user service are a different project. If you are unsure
whether an idea fits, open an issue before writing the code.

By contributing you agree your work is licensed under the [MIT License](LICENSE).

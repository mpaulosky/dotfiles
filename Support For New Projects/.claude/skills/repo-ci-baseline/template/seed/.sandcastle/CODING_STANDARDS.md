# {{REPO}} coding standards

Every Sandcastle role follows these standards, and the reviewer checks the branch against them. Fill in each section for this repo, and keep it short: link a longer
document rather than copying it here.

## Where the rules are

- `.github/instructions/` holds the rules the Baseline Template owns: commit messages, Markdown and blog posts.
- `docs/PROCESS.md` says how a change reaches `main`: branches, commits, PR titles and descriptions, checks and review.
- `CLAUDE.md` says how the repo is built and laid out.

## Code

The language and framework conventions this repo follows: naming, layout, nullability, error handling and logging.

## Tests

Where tests go, how they're named, and what each kind of test (unit, integration, end-to-end) covers.

## Sandcastle's TypeScript

`.sandcastle/` is TypeScript run with `tsx` on Node, with no build step. `pnpm run check:sandcastle` type-checks it and runs every `*.test.mts`.

- Match the module you're in: two-space indents, double quotes, semicolons, and `.mts` imports with the extension.
- Tests sit beside the module as `<module>.test.mts`, written with `node:test` and `node:assert/strict`.
- `lib/host-safety.mts` and `lib/shell.mts` are owned by the Baseline Template: don't change them here.

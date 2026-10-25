# Sandcastle's shared files are Owned, its prompts are Seed, and Apply adds them only to a Sandcastle repo

**Status:** accepted (mpaulosky/dotfiles#280); implemented in `template/owned/.sandcastle/`, `template/seed/.sandcastle/`, `apply.sh` and `test.sh`
([sandcastle.md](../../references/sandcastle.md)).

Seven repos carry a `.sandcastle/`, in two generations, and their settings have drifted: five `.env.example` variants, two `.gitignore`s,
`test:sandcastle` against `check:sandcastle`, and a different Dockerfile in each.
The Template had no Sandcastle section, so a new repo started from a copy of whichever repo was nearest.
The Template now carries one, split by the same rule as the rest of it (ADR 0001): a file with no per-repo value is Owned, anything else is Seed.

## Decisions

- **Owned:** `.sandcastle/tsconfig.json`, `.markdownlint-cli2.jsonc`, `.gitignore`, `.env.example`, `intake-prompt.md`, `critique-prompt.md`,
  and `lib/host-safety.mts` and `lib/shell.mts` with their tests.
  These carry nothing about the repo, and the two modules import nothing but each other, so a repo can't break them through its own code.
  Keeping the host-safety guardrails identical everywhere is the point of owning them.
- **Seed:** the role prompts (`roles/*.md`, `shared-rules.md` included), `plan-prompt.md`, `review-prompt.md`, `Dockerfile`, `CODING_STANDARDS.md`
  and `check.sh` under `.sandcastle/`, and the root `package.json` and `pnpm-workspace.yaml`.
  Each one describes the repo (its stacks, test commands, docs, toolchain), so it's the repo's once written.
  mpaulosky/dotfiles#280 listed `roles/shared-rules.md` as Owned; it isn't, because it is the one file that describes the repo to every role.
- **The rest of `lib/` and `main.mts` stay out of the Template for now.** Almost every module imports `lib/config.mts`, which holds
  per-repo values (labels, root copies, role models), so an Owned module would break whenever a repo's `config.mts` lacked a name it reads.
  Their comments also cite issues by bare number from more than one repo, which the Owned-file check refuses.
  Bringing them in needs `config.mts` split into an Owned part and a Seed part first, as its own issue.
- **Apply adds Sandcastle's files only to a repo that has a `.sandcastle/` folder, or no commits yet.**
  The Template's paths are those of every Baseline repo, and SuggestionApp has no Sandcastle: without the rule its next re-Apply would add
  an inert `.sandcastle/` and a root `package.json`. A repo starts using Sandcastle by creating the folder and Applying again.
- **The placeholder checks let Sandcastle's own `{{NAME}}`s through.** Sandcastle fills `{{TASK_ID}}`, `{{SHARED_RULES}}` and the rest when it runs a prompt,
  so under `.sandcastle/` the no-placeholders check refuses only Apply's `{{OWNER}}`, `{{REPO}}` and `{{SOLUTION}}`,
  and Apply reports a Seed file as unfilled only for those three.
- **dotfiles' `.sandcastle/` carries the Owned files as copies**, checked by `test.sh` like its other copies of Owned files.

## Considered Options

- **Owning the whole pipeline** (every `lib/` module, `main.mts` and the prompts): rejected for now; `config.mts` and the role prompts hold per-repo
  values, and the three full-pipeline repos' copies couldn't be compared from one repo.
- **Owned `shared-rules.md`, as the issue planned**: rejected; it would overwrite each repo's description of itself on every Apply.
- **A separate `template/sandcastle/` tree with an `apply.sh --sandcastle` flag**: rejected; one more tree and a flag to forget,
  where the folder's presence already says whether a repo runs Sandcastle.
- **Adding Sandcastle's files to every Baseline repo**: rejected; repos that don't run Sandcastle would carry files that do nothing.
- **Exempting `.sandcastle/` from the placeholder checks altogether**: rejected; an Apply placeholder in an Owned prompt would still go out unfilled.

## Consequences

- A repo moves onto the section by re-Apply, then Adapt: the Owned files arrive as drift to review, and each Seed file it already has is diffed
  against the Template's ([sandcastle.md](../../references/sandcastle.md#migrating-a-repo)).
- A new repo gets the config and prompts but not the code: until `lib/` is in the Template, `main.mts` and the rest of `lib/` are copied by hand.
- The Sandcastle workflows (`sandcastle*.yml`) stay each repo's own, since Sandcastle's Actions token can't push workflow changes.

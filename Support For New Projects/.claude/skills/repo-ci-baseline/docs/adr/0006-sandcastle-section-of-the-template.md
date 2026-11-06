# Sandcastle's shared files are Owned, its prompts are Seed, and Apply adds them only to a Sandcastle repo

**Status:** accepted (mpaulosky/dotfiles#280); implemented in `template/owned/.sandcastle/`, `template/seed/.sandcastle/`, `apply.sh` and `test.sh`
([sandcastle.md](../../references/sandcastle.md)). Its decision to keep the rest of `lib/` and `main.mts` out is superseded by
[ADR 0007](0007-sandcastle-code-is-owned-with-a-seed-repo-config.md), and its decision to keep `sandcastle.yml` out by
[ADR 0009](0009-sandcastle-workflow-is-owned.md). Amended by mpaulosky/dotfiles#391: `.sandcastle/check.sh` is Owned, and a repo's extra
watched paths are in the Seed `.sandcastle/check-paths.txt`. Amended by mpaulosky/dotfiles#392: the role prompts, `plan-prompt.md` and `review-prompt.md` are Owned, and a repo's text
goes in the Seed `roles/shared-rules.md` and `roles/skills.md`.

Seven repos carry a `.sandcastle/`, in two generations, and their settings have drifted: five `.env.example` variants, two `.gitignore`s,
`test:sandcastle` against `check:sandcastle`, and a different Dockerfile in each.
The Template had no Sandcastle section, so a new repo started from a copy of whichever repo was nearest.
The Template now carries one, split by the same rule as the rest of it (ADR 0001): a file with no per-repo value is Owned, anything else is Seed.

## Decisions

- **Owned:** `.sandcastle/tsconfig.json`, `.markdownlint-cli2.jsonc`, `.gitignore`, `.env.example`, `intake-prompt.md`, `critique-prompt.md`,
  `check.sh`, `plan-prompt.md`, `review-prompt.md`, the role prompts (`roles/architect.md`, `backend.md`, `tester.md`, `follow-up.md`, `gate-fixer.md`, `scribe.md` and `ui.md`)
  and `lib/host-safety.mts` and `lib/shell.mts` with their tests.
  These carry nothing about the repo, and the two modules import nothing but each other, so a repo can't break them through its own code.
  Keeping the host-safety guardrails identical everywhere is the point of owning them.
- **Seed:** `roles/shared-rules.md`, `roles/skills.md`, `Dockerfile`, `CODING_STANDARDS.md`
  and `check-paths.txt` under `.sandcastle/`, and the root `package.json` and `pnpm-workspace.yaml`.
  Each one describes the repo (its stacks, test commands, docs, toolchain), so it's the repo's once written.
  The role prompts and the two other prompts started as Seed (mpaulosky/dotfiles#280) and became Owned (mpaulosky/dotfiles#392): they had drifted by 9-35 lines per repo, mostly staleness,
  and the rest was repo content (pointers to `docs/CODING_STANDARDS.md`, `CONTEXT.md` and `.claude/rules/`, a `.NET` `# SKILLS` block, the Blazor UI role). That content now sits in
  `roles/shared-rules.md`, and in `roles/skills.md`, which the host injects into the prompts as `{{REPO_SKILLS}}`; `roles/ui.md` and the planner's `ui` role are Owned and opt-in.
  A re-Apply reviews the nine prompts, since they instruct the pipeline's agents.
  `check.sh` started as Seed and became Owned (mpaulosky/dotfiles#391): Blazor-Server and auth0-management-app had edited only its list of watched paths, which now lives in
  `check-paths.txt`; the three older repos used the name for their sandbox gate, a different script that they rename before they Apply.
  mpaulosky/dotfiles#280 listed `roles/shared-rules.md` as Owned; it isn't, because it is the one file that describes the repo to every role.
- **Superseded by ADR 0007: the rest of `lib/` and `main.mts` stay out of the Template for now.** Almost every module imports `lib/config.mts`, which holds
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
- **Keeping the role prompts Seed**: rejected; they drifted 9-35 lines per repo, and a repo's few lines of its own fit in `roles/shared-rules.md` and `roles/skills.md`.
- **Owned `shared-rules.md`, as the issue planned**: rejected; it would overwrite each repo's description of itself on every Apply.
- **A separate `template/sandcastle/` tree with an `apply.sh --sandcastle` flag**: rejected; one more tree and a flag to forget,
  where the folder's presence already says whether a repo runs Sandcastle.
- **Adding Sandcastle's files to every Baseline repo**: rejected; repos that don't run Sandcastle would carry files that do nothing.
- **Exempting `.sandcastle/` from the placeholder checks altogether**: rejected; an Apply placeholder in an Owned prompt would still go out unfilled.

## Consequences

- A repo moves onto the section by re-Apply, then Adapt: the Owned files arrive as drift to review, and each Seed file it already has is diffed
  against the Template's ([sandcastle.md](../../references/sandcastle.md#migrating-a-repo)).
- Superseded by ADR 0007: a new repo gets the config and prompts but not the code: until `lib/` is in the Template, `main.mts` and the rest of `lib/` are copied by hand.
- Superseded by ADR 0009 for `sandcastle.yml`: the Sandcastle workflows stayed each repo's own, since Sandcastle's Actions token can't push workflow changes.

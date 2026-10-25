# Sandcastle's code is Owned, and its per-repo values move to a Seed `lib/repo-config.mts`

**Status:** accepted (mpaulosky/dotfiles#282); supersedes ADR 0006's decision to keep the rest of `lib/` and `main.mts` out of the Template.
To be implemented in `template/owned/.sandcastle/`, `template/seed/.sandcastle/lib/repo-config.mts` and `test.sh`
([sandcastle.md](../../references/sandcastle.md)).

ADR 0006 owned only `lib/host-safety.mts` and `lib/shell.mts`, because every other module imports `lib/config.mts`,
which mixed shared limits and markers with per-repo values. A new repo had to copy `main.mts` and the rest of `lib/` by hand.

## Decisions

- **`lib/config.mts` keeps its name and becomes Owned.** It holds what every Sandcastle repo shares: the role names (`ROLES`,
  `OPTIONAL_ROLES`, `BUILD_ROLES`), limits, labels, markers, the Copilot reviewer settings, and the queue-scope and budget parsing.
- **The per-repo values move to a new Seed file, `lib/repo-config.mts`:** `ROLE_AGENTS`, `MAX_ITERATIONS`, `hooks`, `copyToWorktree`,
  `SANDBOX_SKILLS`, `GATE_COVERED_CHECKS`, `TEMPLATE_OWNED_DIR` and `TEMPLATE_ROOT_COPIES`.
  It imports only types from `config.mts`, and `config.mts` imports nothing from it.
  The Owned name stays `config.mts` because of how a re-Apply goes in an older repo: Apply replaces its `config.mts` with a complete Owned one,
  and writes `repo-config.mts` fresh from the Seed, since the repo has none. Every name the Owned modules read then exists.
- **Every `lib/` module and its test, and `main.mts`, are Owned**, except `repo-config.mts` and the tests that read dotfiles' own files.
  The modules import each other as one cluster (`prompts.mts` imports a type from `follow-up-pass.mts`, which imports `build.mts`, which imports
  nearly everything). Owning only some of them would leave Owned modules importing ones a repo can change.
- **The source is dotfiles' copy.** This run can't compare the three full-pipeline repos' copies byte for byte, as the issue planned.
  Each repo's differences are diffed at its migration and move into the Template first, as ADR 0006 already says for `host-safety.mts`.
- **The names `repo-config.mts` exports are a contract.** Apply never rewrites a Seed file, so an Owned change that reads a new name
  breaks every repo until it adds that name. `tsc --noEmit` catches that in the repo's own check, before a run starts.
- **Owned tests pin no per-repo value.** They read it from `repo-config.mts`, or the code under test takes it as a parameter
  (`PassHost.gateCovered`). dotfiles pins its own values in its own test. A dotfiles test also type-checks the Template's `.sandcastle/`
  as Apply writes it (Owned plus Seed) and runs its Owned tests there.
- **Owned code cites no bare `#N`.** The existing citations mix Blazor-Server's issue numbers with dotfiles', and the two can't be told apart
  now, so they're dropped rather than rewritten as `mpaulosky/dotfiles#N`. New ones are written `mpaulosky/dotfiles#N`.

## Considered Options

- **Seed `config.mts` with a new Owned file for the shared part:** rejected. Each older repo would keep its own `config.mts`, which lacks the
  names the Owned modules read from the Seed part, so every Owned module would fail to type-check there until someone moved them by hand.
- **Per-repo values read at run time from `.env` or a JSON file:** rejected. A missing or mistyped value would fail a run in Actions
  instead of the type-check.
- **Owning only the modules that are byte-identical in the three repos:** not possible from one repo, and the import cluster would
  pull most modules in or leave them all out.
- **Keeping `main.mts` each repo's own:** rejected. Once `ROLE_AGENTS` and `MAX_ITERATIONS` are in `repo-config.mts` it holds no per-repo value,
  and owning it means a new repo can run Sandcastle straight after Apply.
- **Keeping `lib/overlap.mts` out, since only dotfiles has root copies of Template files:** rejected. Its root-copy list moves to
  `repo-config.mts`, empty in the Seed, and the tests of that mapping become dotfiles' own.

## Consequences

- A change to Sandcastle's code in dotfiles changes the Template's copy too: `test.sh` fails when they differ, and the overlap check
  counts each pair as one path.
- The Owned build only knows the Template's roles. Blazor-Server's UI developer role has to come into the Template before
  Blazor-Server migrates, or it loses that role.
- The older repos take every Owned file at their migration and fill `repo-config.mts`, which gives them a `ROLE_AGENTS` map for the first time.

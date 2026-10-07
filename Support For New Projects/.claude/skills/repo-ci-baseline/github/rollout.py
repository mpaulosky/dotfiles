#!/usr/bin/env python3
"""Roll a re-Apply round out across the Baseline repos, TicketManager first.

    rollout.sh --brings <prs> [--root dir] [--dry-run]

The Baseline repos are github/repos.txt's, in its order, without the
repo-settings-only ones (dotfiles); TicketManager goes first as the live check
of the Template change. Each run:

1. runs reapply.sh on TicketManager;
2. holds the rest while TicketManager's re-Apply PR is open (or its reapply
   failed): land it (land.sh prints how), fix any finding Template first, then
   run rollout.sh again;
3. once TicketManager has no open re-Apply PR, its Apply is on main, so the
   rest get reapply.sh in order, one at a time, so one pre-push gate runs at a
   time. A repo that fails is reported and the round goes on.

Each repo's checkout is <root>/<Repo> (default ~/github). It ends with the
land.sh command that watches the re-Apply PRs it left open, and exits 1 when
any reapply failed. --dry-run prints the reapply.sh calls it would make from
the open PRs as they are now, and makes none: the rest's calls only follow when
TicketManager's reapply opens no PR.
"""

import argparse
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass

from settings import read_repo_list

LEAD = "mpaulosky/TicketManager"
BRANCH = "chore/reapply-baseline"
REAPPLY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "reapply.sh")


def name(repo):
    return repo.split("/")[-1]


def rollout_order(listed):
    """The Baseline repos in repos.txt's order, TicketManager first."""
    repos = [repo for repo, scope in listed.items() if scope != "repo-settings-only"]
    return tuple(sorted(repos, key=lambda repo: repo != LEAD))


@dataclass(frozen=True)
class Lead:
    """How TicketManager's reapply went: it ran cleanly, and its open re-Apply PR, if any."""

    ok: bool
    open_pr: int | None


@dataclass(frozen=True)
class Step:
    run: tuple  # the repos to reapply now, in order
    held: tuple  # the repos that wait
    reason: str = ""


def next_step(order, lead):
    """What runs next: TicketManager alone, then (once its PR has merged) the rest."""
    first, rest = order[0], tuple(order[1:])
    if lead is None:
        return Step((first,), rest, f"{name(first)} goes first")
    if not lead.ok:
        return Step((), rest, f"reapply failed on {name(first)}")
    if lead.open_pr is not None:
        return Step((), rest, f"waiting for {name(first)}#{lead.open_pr} to merge")
    return Step(rest, ())


def run_reapply(brings, path):
    """reapply.sh on one checkout, its output straight through; its exit code."""
    return subprocess.run([REAPPLY, "--brings", brings, path]).returncode


def gh_open_pr(repo):
    """The number of repo's open re-Apply PR, or None."""
    run = subprocess.run(["gh", "pr", "list", "-R", repo, "--head", BRANCH, "--state", "open",
                          "--json", "number", "--jq", ".[0].number // empty"], capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip() or f"gh pr list exited {run.returncode}")
    return int(run.stdout) if run.stdout.strip() else None


def main(argv=None, listed=None, reapply=run_reapply, open_pr=gh_open_pr, exists=os.path.isdir,
         out=sys.stdout, err=sys.stderr):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--brings", required=True,
                        help="the dotfiles PRs this round brings in, as reapply.sh takes them: mpaulosky/dotfiles#80,#81")
    parser.add_argument("--root", default=os.path.expanduser("~/github"),
                        help="the directory holding each repo's checkout (default ~/github)")
    parser.add_argument("--dry-run", action="store_true", help="print the reapply.sh calls instead of making them")
    args = parser.parse_args(argv)
    order = rollout_order(read_repo_list() if listed is None else listed)

    def say(text):
        out.write(text + "\n")
        out.flush()

    def apply(repo):
        """reapply.sh on one repo (or what it would run); whether it went cleanly."""
        path = os.path.join(args.root, name(repo))
        if not exists(path):
            err.write(f"rollout.sh: no checkout at {path} for {repo}\n")
            return False
        if args.dry_run:
            say(f"would run: reapply.sh --brings {shlex.quote(args.brings)} {path}")
            return True
        say(f"── rollout: {name(repo)}")
        if reapply(args.brings, path) != 0:
            err.write(f"rollout.sh: reapply failed on {name(repo)}\n")
            return False
        return True

    def lookup(repo):
        """(read it, the number of repo's open re-Apply PR or None)."""
        try:
            return True, open_pr(repo)
        except Exception as error:  # noqa: BLE001 - reported; the repo's PR is then unknown
            err.write(f"rollout.sh: can't read {repo}'s re-Apply PR: {error}\n")
            return False, None

    first = next_step(order, None).run[0]
    ok = apply(first)
    read, number = lookup(first)
    lead = Lead(ok and read, number)
    step = next_step(order, lead)
    if not step.run:
        say(f"rollout: {step.reason}; held: {', '.join(name(repo) for repo in step.held)}")
        if lead.open_pr is not None:
            say(f"  land it with: land.sh {first}#{lead.open_pr}, then run rollout.sh again")
        return 0 if lead.ok else 1

    if args.dry_run:
        say(f"then, if that leaves {name(first)} with no open re-Apply PR (its Apply is already on main):")
    failed, landing = [], []
    for repo in step.run:
        if not apply(repo):
            failed.append(name(repo))
            continue
        if args.dry_run:
            continue
        _, number = lookup(repo)
        if number is not None:
            landing.append(f"{repo}#{number}")
    if not args.dry_run:
        say(f"rollout: reapplied {len(step.run) - len(failed)} of {len(step.run)} repo(s) after {name(first)}"
            + (f"; failed: {', '.join(failed)}" if failed else ""))
        if landing:
            say(f"  land them with: land.sh {' '.join(landing)}")
    elif failed:
        say(f"rollout: failed: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

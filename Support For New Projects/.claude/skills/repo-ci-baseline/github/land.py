#!/usr/bin/env python3
"""Watch a round's PRs and act on the landing decision until they land.

    land.sh [options]                     every open PR in github/repos.txt
    land.sh [options] <owner/repo>...     every open PR in these repos
    land.sh [options] <owner/repo#n>...   just these PRs

Each poll costs one GraphQL query per repo (status.py's QUERY). Every watched
PR goes through landing.decide(), and the command does what the decision says,
once per PR head:

- mark ready:       gh pr ready (only with --ready; otherwise a draft waits)
- update branch:    gh pr update-branch, then gh pr edit --add-reviewer @copilot,
                    read back: gh exits 0 even when GitHub drops the request,
                    so a dropped or refused one is warned about
- request Copilot:  gh pr edit --add-reviewer @copilot for a head no reviewer
                    has reviewed or is on its way to, read back the same way;
                    a request that didn't register is remembered for the head
- add review:claude: gh pr edit --add-label review:claude, so Claude Review
                    reviews a head whose Copilot request didn't register; the
                    decision makes it only once the head's checks are green,
                    and never past Claude's review rounds
                    (landing.MAX_CLAUDE_ROUNDS)
- arm auto-merge:   gh pr merge --auto --squash --match-head-commit <head>
- leave to PR Auto-Merge, wait, report blocker, nothing: no call

So a reviewed PR is left to its repo's own PR Auto-Merge workflow (dotfiles
carries a copy), and a release-blog PR is armed when its workflow hasn't armed
it. Release-blog PRs that open in a watched repo
are watched too, and after a watched PR in a Baseline repo merges, the command
waits up to --blog-wait minutes for its release-blog PR.

It prints only changes: one line per PR whose state or action changed (status.sh's
line), the calls it made under it, and nothing when nothing changed. It exits 0
once every watched PR is merged or closed, or after one pass with --once, and 1
at the time limit or when a repo can't be read on the last pass. --dry-run
prints the calls instead of making them.
"""

import argparse
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field

from landing import ARM_AUTO_MERGE, MARK_READY, REQUEST_CLAUDE, REQUEST_COPILOT, REVIEW_CLAUDE, UPDATE_BRANCH, decide
from settings import read_repo_list
from status import gh_graphql, line, repo_flags, to_state

PR_REF = re.compile(r"^(?:https://github\.com/)?([\w.-]+/[\w.-]+)(?:#|/pull/)(\d+)$")
REPO_REF = re.compile(r"^[\w.-]+/[\w.-]+$")


def parse_targets(args):
    """{repo: set of PR numbers, or None for every open PR} from the arguments."""
    targets = {}
    for arg in args:
        match = PR_REF.match(arg)
        if match:
            numbers = targets.setdefault(match[1], set())
            if numbers is not None:
                numbers.add(int(match[2]))
        elif REPO_REF.match(arg):
            targets[arg] = None
        else:
            raise ValueError(f"not owner/repo or owner/repo#n: {arg}")
    return targets


def commands(action, repo, number, head):
    """The gh calls that carry out one decision's action; none for the rest."""
    pr = [str(number), "-R", repo]
    if action == MARK_READY:
        return [["gh", "pr", "ready", *pr]]
    if action == UPDATE_BRANCH:
        return [["gh", "pr", "update-branch", *pr], ["gh", "pr", "edit", *pr, "--add-reviewer", "@copilot"]]
    if action == REQUEST_COPILOT:
        return [["gh", "pr", "edit", *pr, "--add-reviewer", "@copilot"]]
    if action == REQUEST_CLAUDE:
        return [["gh", "pr", "edit", *pr, "--add-label", REVIEW_CLAUDE]]
    if action == ARM_AUTO_MERGE:
        return [["gh", "pr", "merge", *pr, "--auto", "--squash", "--match-head-commit", head]]
    return []


def run_gh(argv):
    """Run one gh call; (ok, message)."""
    run = subprocess.run(argv, capture_output=True, text=True)
    return run.returncode == 0, (run.stderr.strip() or run.stdout.strip()).replace("\n", " ")


# How many of the PR's review requests and reviews of its head are Copilot's.
COPILOT_JQ = ('.headRefOid as $h | [(.reviewRequests[] | .login // .name // ""), '
              '(.reviews[] | select(.commit.oid == $h) | .author.login)] | map(select(test("copilot"; "i"))) | length')


def gh_copilot_requested(repo, number):
    """Whether Copilot's review is requested on the PR, or Copilot has reviewed its head."""
    ok, message = run_gh(["gh", "pr", "view", str(number), "-R", repo, "--json", "headRefOid,reviewRequests,reviews",
                          "--jq", COPILOT_JQ])
    if not ok:
        raise RuntimeError(message)
    return int(message) > 0


def gh_pr_state(repo, number):
    """MERGED or CLOSED (or OPEN) for a PR that left the open list."""
    ok, message = run_gh(["gh", "pr", "view", str(number), "-R", repo, "--json", "state", "--jq", ".state"])
    if not ok:
        raise RuntimeError(message)
    return message


@dataclass
class Watched:
    title: str = ""
    seen: tuple | None = None  # the last state printed
    final: str = ""  # MERGED or CLOSED once it has left the open list


@dataclass
class Lander:
    """The watch loop's state across polls; poll() is one pass."""

    targets: dict  # {repo: set of numbers, or None for every open PR}
    scopes: dict  # {repo: repos.txt scope}
    want_ready: bool = False
    dry_run: bool = False
    blog_wait: float = 15 * 60
    fetch: object = gh_graphql
    pr_state: object = gh_pr_state
    copilot_requested: object = gh_copilot_requested
    run: object = run_gh
    clock: object = time.monotonic
    out: object = sys.stdout
    err: object = sys.stderr
    watched: dict = field(default_factory=dict)  # {(repo, number): Watched}
    acted: set = field(default_factory=set)  # {(repo, number, action, head)}
    copilot_dropped: set = field(default_factory=set)  # {(repo, number, head)} whose Copilot request didn't register
    blog_due: dict = field(default_factory=dict)  # {repo: deadline} while its blog PR is awaited
    errors: dict = field(default_factory=dict)  # {repo: last error printed}
    started: set = field(default_factory=set)  # repos read at least once

    def say(self, text):
        self.out.write(text + "\n")
        self.out.flush()

    def poll(self):
        """One pass over every repo: (nothing left to watch, a repo couldn't be read)."""
        failed = False
        for repo, numbers in self.targets.items():
            failed |= not self.poll_repo(repo, numbers)
        return self.done(), failed

    def poll_repo(self, repo, numbers):
        owner, name = repo.split("/", 1)
        try:
            nodes = self.fetch(owner, name)["repository"]["pullRequests"]["nodes"]
        except Exception as error:  # noqa: BLE001 - one unreadable repo mustn't stop the rest
            if self.errors.get(repo) != str(error):
                self.err.write(f"{repo}: {error}\n")
                self.errors[repo] = str(error)
            return False
        self.errors.pop(repo, None)
        flags = repo_flags(self.scopes.get(repo, "full"))
        open_prs = {node["number"]: node for node in nodes}

        if repo not in self.started:  # the PRs to watch are fixed on the first read
            self.started.add(repo)
            for number in (open_prs if numbers is None else numbers):
                self.watched.setdefault((repo, number), Watched())
        blog_open = False
        for number, node in open_prs.items():
            state = to_state(node, **flags, want_ready=self.want_ready)
            if state.release_blog:
                self.watched.setdefault((repo, number), Watched())
                blog_open = True

        for (watched_repo, number), pr in sorted(self.watched.items()):
            if watched_repo != repo or pr.final:
                continue
            if number in open_prs:
                self.update_open(repo, number, pr, open_prs[number], flags)
            else:
                self.update_gone(repo, number, pr, flags)
        # After the updates, so a release-blog PR that opened in the same poll
        # as the merge that started the wait still ends it.
        if blog_open:
            self.blog_due.pop(repo, None)

        due = self.blog_due.get(repo)
        if due is not None and self.clock() >= due:
            del self.blog_due[repo]
            self.say(f"{repo}: no release-blog PR within {self.blog_wait / 60:g} min")
        return True

    def update_open(self, repo, number, pr, node, flags):
        state = to_state(node, **flags, want_ready=self.want_ready,
                         copilot_dropped=(repo, number, node["headRefOid"]) in self.copilot_dropped)
        decision = decide(state)
        pr.title = node["title"]
        seen = (state.state, state.head, state.draft, state.merge_state, state.head_reviewer,
                state.open_threads, state.auto_merge_armed, decision.action, decision.reason)
        if seen == pr.seen:
            return
        pr.seen = seen
        self.say(line(repo, node, state))
        key = (repo, number, decision.action, state.head)
        calls = commands(decision.action, repo, number, state.head)
        if not calls or key in self.acted:
            return
        self.acted.add(key)
        for argv in calls:
            if self.dry_run:
                self.say("  would run: " + " ".join(argv))
                continue
            ok, message = self.run(argv)
            if "--add-reviewer" in argv:
                # A request GitHub refuses outright is no worse than one it
                # drops: the read-back finds none, and the warning says so.
                if ok:
                    self.say("  ran: " + " ".join(argv))
                else:
                    self.say("  warning: " + " ".join(argv) + " failed" + (f" ({message})" if message else ""))
                # After update-branch the head is new and unknown here, so only
                # a request for the head as read is remembered.
                self.read_back_copilot(repo, number, state.head if decision.action == REQUEST_COPILOT else None)
                continue
            self.say(("  ran: " if ok else "  failed: ") + " ".join(argv) + (f" ({message})" if message and not ok else ""))
            if not ok:
                break

    def read_back_copilot(self, repo, number, head=None):
        """Read Copilot's review request back, and warn when GitHub dropped it.

        A dropped request for head is remembered, so the decision can call in
        Claude Review, though not here: it adds review:claude once the head's
        checks are green. A read-back that fails remembers nothing.
        """
        url = f"https://github.com/{repo}/pull/{number}"
        try:
            if self.copilot_requested(repo, number):
                return
        except Exception as error:  # noqa: BLE001 - reported like a failed call
            self.say(f"  failed: Copilot's review request couldn't be read back on #{number} ({error}); request it at {url}")
            return
        if head:
            self.copilot_dropped.add((repo, number, head))
        self.say(f"  warning: Copilot's review request didn't register on #{number} (GitHub drops it once the Copilot "
                 f"code review budget is used up); {REVIEW_CLAUDE} is added once the head's checks are green")

    def update_gone(self, repo, number, pr, flags):
        try:
            final = self.pr_state(repo, number)
        except Exception as error:  # noqa: BLE001 - reported, and tried again next poll
            if self.errors.get((repo, number)) != str(error):
                self.err.write(f"{repo}#{number}: {error}\n")
                self.errors[(repo, number)] = str(error)
            return
        if final == "OPEN":  # not on the first page of open PRs, or the list lagged
            return
        pr.final = final
        self.say(f"{repo.split('/')[-1]}#{number} {final.lower()}")
        # A PR seen open that merges in a Baseline repo starts a release, and
        # with it a release-blog PR; a [skip-release] one (a blog PR) doesn't,
        # and dotfiles (repo-settings-only) has no releases.
        if (final == "MERGED" and pr.seen is not None and "[skip-release]" not in pr.title
                and self.scopes.get(repo, "full") != "repo-settings-only"):
            self.blog_due[repo] = self.clock() + self.blog_wait

    def done(self):
        return (set(self.targets) <= self.started and not self.blog_due
                and all(pr.final for pr in self.watched.values()))


def main(argv=None, lander=None, sleep=time.sleep, out=sys.stdout, err=sys.stderr):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("prs", nargs="*", help="owner/repo or owner/repo#n (default: every repo in github/repos.txt)")
    parser.add_argument("--ready", action="store_true", help="mark watched drafts ready (otherwise a draft waits)")
    parser.add_argument("--once", action="store_true", help="one pass, then exit")
    parser.add_argument("--dry-run", action="store_true", help="print the gh calls instead of making them")
    parser.add_argument("--interval", type=float, default=60, help="seconds between polls (default 60)")
    parser.add_argument("--timeout", type=float, default=180, help="minutes before giving up (default 180)")
    parser.add_argument("--blog-wait", type=float, default=15,
                        help="minutes to wait for a release-blog PR after a Baseline PR merges (default 15)")
    args = parser.parse_args(argv)
    listed = read_repo_list()
    try:
        targets = parse_targets(args.prs) if args.prs else dict.fromkeys(listed)
    except ValueError as error:
        parser.error(str(error))

    if lander is None:
        lander = Lander(targets, listed, out=out, err=err)
    lander.want_ready, lander.dry_run, lander.blog_wait = args.ready, args.dry_run, args.blog_wait * 60

    deadline = lander.clock() + args.timeout * 60
    while True:
        done, failed = lander.poll()
        if not lander.watched and not failed:
            lander.say(f"No open PRs to land in {len(targets)} repo(s).")
            return 0
        if done:
            if not args.once:
                lander.say(f"All {len(lander.watched)} watched PR(s) merged or closed.")
            return 0
        if args.once:
            return 1 if failed else 0
        if lander.clock() >= deadline:
            still = sorted(f"{repo.split('/')[-1]}#{number}" for (repo, number), pr in lander.watched.items()
                           if not pr.final)
            lander.say(f"Time limit reached; still open: {', '.join(still) or 'none'}"
                       + ("; still waiting for a release-blog PR in " + ", ".join(sorted(lander.blog_due))
                          if lander.blog_due else ""))
            return 1
        sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())

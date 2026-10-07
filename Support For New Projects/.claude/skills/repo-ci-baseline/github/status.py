#!/usr/bin/env python3
"""One line per open PR across the repos in github/repos.txt.

    status.sh                   every repo in github/repos.txt
    status.sh <owner/repo>...   just these

Each line: repo#number, title, head, draft, merge state, whether Copilot
reviewed the head, open threads, auto-merge, running/failed/cancelled checks,
and the landing decision's next action (github/landing.py). One GraphQL query
per repo, read-only. Prints nothing else, apart from one line when no PR is
open; a repo that can't be read is reported on stderr and exits 1.

A repo whose repos.txt scope is repo-settings-only (dotfiles) has no required
checks and no PR Auto-Merge, so the decision waits for its checks to go green
before arming. Any other repo is a Baseline repo, whose PR Auto-Merge merges a
reviewed PR itself (see repo_flags()).
"""

import argparse
import json
import subprocess
import sys

from landing import RELEASE_BLOG_BRANCHES, Check, PrState, copilot_reviews, decide, summarize_checks
from settings import read_repo_list

QUERY = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        number title state isDraft headRefName headRefOid mergeStateStatus
        autoMergeRequest { enabledAt }
        reviews(last: 100) { nodes { author { login } commit { oid } } }
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion startedAt }
          ... on StatusContext { context state createdAt }
        } } } } } }
      }
    }
  }
}
"""

TITLE_WIDTH = 40


def gh_graphql(owner, name):
    """The query's data for one repo, through `gh api graphql`."""
    run = subprocess.run(["gh", "api", "graphql", "-f", f"query={QUERY}", "-F", f"owner={owner}", "-F", f"name={name}"],
                         capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip() or run.stdout.strip())
    return json.loads(run.stdout)["data"]


def to_check(node):
    if node.get("__typename") == "StatusContext":
        state = node.get("state")
        if state in ("PENDING", "EXPECTED"):
            return Check(node["context"], "PENDING", None, node.get("createdAt") or "")
        return Check(node["context"], "COMPLETED", state, node.get("createdAt") or "")
    return Check(node["name"], node["status"], node.get("conclusion"), node.get("startedAt") or "")


def repo_flags(scope):
    """to_state()'s per-repo keywords for a repos.txt scope.

    A Baseline repo ("full") requires checks and runs PR Auto-Merge;
    repo-settings-only (dotfiles) has neither.
    """
    baseline = scope != "repo-settings-only"
    return {"checks_required": baseline, "merged_by_workflow": baseline}


def to_state(node, checks_required=True, merged_by_workflow=False, want_ready=False):
    """A PrState from one pullRequests node of QUERY."""
    commits = node["commits"]["nodes"]
    rollup = commits[0]["commit"]["statusCheckRollup"] if commits else None
    contexts = rollup["contexts"]["nodes"] if rollup else []
    return PrState(
        state=node["state"],
        draft=node["isDraft"],
        head=node["headRefOid"],
        copilot_reviewed=copilot_reviews(((review.get("author") or {}).get("login"), (review.get("commit") or {}).get("oid"))
                                         for review in node["reviews"]["nodes"]),
        open_threads=sum(1 for thread in node["reviewThreads"]["nodes"] if not thread["isResolved"]),
        merge_state=node["mergeStateStatus"],
        checks=tuple(to_check(context) for context in contexts if context),
        checks_required=checks_required,
        auto_merge_armed=node["autoMergeRequest"] is not None,
        want_ready=want_ready,
        merged_by_workflow=merged_by_workflow,
        release_blog=node.get("headRefName") in RELEASE_BLOG_BRANCHES,
    )


def shorten(text, width=TITLE_WIDTH):
    return text if len(text) <= width else text[:width - 1] + "…"


def line(repo, node, pr):
    checks = summarize_checks(pr.checks)
    decision = decide(pr)
    name = repo.split("/")[-1]
    return (f"{name}#{node['number']} {shorten(node['title']):<{TITLE_WIDTH}} {pr.head[:7]}"
            f" {'draft' if pr.draft else 'ready'} {pr.merge_state}"
            f" copilot:{'head' if pr.copilot_on_head else 'no'} threads:{pr.open_threads}"
            f" automerge:{'on' if pr.auto_merge_armed else 'off'}"
            f" running:{len(checks.running)} failed:{len(checks.failed)} cancelled:{len(checks.cancelled)}"
            f" -> {decision.action} ({decision.reason})")


def main(argv=None, fetch=gh_graphql, out=sys.stdout, err=sys.stderr):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("repos", nargs="*", help="owner/repo (default: every repo in github/repos.txt)")
    args = parser.parse_args(argv)
    listed = read_repo_list()
    repos = args.repos or list(listed)

    lines, status = [], 0
    for repo in repos:
        owner, name = repo.split("/", 1)
        try:
            data = fetch(owner, name)
        except Exception as error:  # noqa: BLE001 - one unreadable repo mustn't hide the rest
            err.write(f"{repo}: {error}\n")
            status = 1
            continue
        flags = repo_flags(listed.get(repo, "full"))
        for node in data["repository"]["pullRequests"]["nodes"]:
            lines.append(line(repo, node, to_state(node, **flags)))
    if lines:
        out.write("\n".join(lines) + "\n")
    elif status == 0:
        out.write(f"No open PRs in {len(repos)} repo(s).\n")
    return status


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""One line per open PR across the repos in github/repos.txt.

    status.sh                   every repo in github/repos.txt
    status.sh <owner/repo>...   just these

Each line: repo#number, title, head, draft, merge state, which reviewer
reviewed the head (review:copilot, review:claude or review:no), open threads,
auto-merge, running/failed/cancelled checks,
and the landing decision's next action (github/landing.py), then a
`notice:` naming the resolved Copilot or Claude Review threads nobody replied to. One GraphQL query
per repo, plus one for each PR whose threads are all resolved and that Copilot or Claude Review reviewed (it reads the
thread comments the notice needs; they would cost far more in the repo query), read-only. Prints nothing else, apart from one line when no PR is
open; a repo that can't be read is reported on stderr and exits 1.

Every listed repo requires checks and runs PR Auto-Merge, which merges a
reviewed PR itself: a Baseline repo through Apply, and dotfiles (repos.txt
scope repo-settings-only) through its copy and its hand-made main-rules.
"""

import argparse
import json
import subprocess
import sys

from landing import (COPILOT, RELEASE_BLOG_BRANCHES, REVIEW_CLAUDE, Check, PrState, Thread, claude_off_diff, claude_reviews,
                     copilot_declined, copilot_reviews, decide, is_claude_review, summarize_checks, unreplied_notice,
                     unreplied_threads)
from settings import read_repo_list

QUERY = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        id number title state isDraft headRefName headRefOid mergeStateStatus
        autoMergeRequest { enabledAt }
        labels(first: 20) { nodes { name } }
        reviewRequests(first: 20) { nodes { requestedReviewer {
          ... on Bot { login }
          ... on User { login }
          ... on Team { name }
        } } }
        reviews(last: 100) { nodes { author { login } commit { oid parents { totalCount } } body } }
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { databaseId name status conclusion startedAt }
          ... on StatusContext { context state createdAt }
        } } } } } }
      }
    }
  }
}
"""

# The comments of one PR's review threads, for the notice: 1 + 100 requests, 1 point.
THREADS_QUERY = """
query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) { nodes {
        isResolved path line originalLine
        comments(first: 10) { totalCount nodes { url author { login __typename } pullRequestReview { body } } }
      } }
    }
  }
}
"""

TITLE_WIDTH = 40


def graphql(query, *fields, **raw):
    """The data of one `gh api graphql` call: fields are "key=value" for -F, raw are -f (strings as they are)."""
    argv = ["gh", "api", "graphql", "-f", f"query={query}"]
    for field in fields:
        argv += ["-F", field]
    for key, value in raw.items():
        argv += ["-f", f"{key}={value}"]
    run = subprocess.run(argv, capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip() or run.stdout.strip())
    return json.loads(run.stdout)["data"]


def bot_reviewed(node):
    """Whether Copilot or Claude Review ever reviewed this PR, from QUERY's reviews."""
    return any(COPILOT.search((review.get("author") or {}).get("login") or "")
               or is_claude_review((review.get("author") or {}).get("login"), "-", review.get("body"))
               for review in node["reviews"]["nodes"])


def gh_graphql(owner, name):
    """The query's data for one repo, through `gh api graphql`.

    QUERY reads no thread comments: on 50 PRs of 100 threads they would cost
    about 53 points a read instead of 3. A PR whose threads are all resolved
    and that a bot reviewed gets THREADS_QUERY (1 point), and its thread nodes
    are replaced by that query's, which carry the comments the notice reads.
    """
    data = graphql(QUERY, f"owner={owner}", f"name={name}")
    for node in data["repository"]["pullRequests"]["nodes"]:
        threads = node["reviewThreads"]["nodes"]
        if threads and all(thread["isResolved"] for thread in threads) and bot_reviewed(node):
            node["reviewThreads"]["nodes"] = graphql(THREADS_QUERY, id=node["id"])["node"]["reviewThreads"]["nodes"]
    return data


def to_check(node):
    if node.get("__typename") == "StatusContext":
        state = node.get("state")
        if state in ("PENDING", "EXPECTED"):
            return Check(node["context"], "PENDING", None, node.get("createdAt") or "")
        return Check(node["context"], "COMPLETED", state, node.get("createdAt") or "")
    return Check(node["name"], node["status"], node.get("conclusion"), node.get("startedAt") or "",
                 node.get("databaseId") or 0)


def printable(text):
    """text with every character that isn't printable replaced by its repr escape; thread paths are PR-controlled."""
    return "".join(char if char.isprintable() else repr(char)[1:-1] for char in text)


def thread_name(node):
    """A thread's path:line, or what of them it has, printable; "thread" with no path."""
    path = node.get("path")
    if not path:
        return "thread"
    line_number = node.get("line") or node.get("originalLine")
    return printable(f"{path}:{line_number}" if line_number else path)


def to_thread(node):
    """A Thread from one reviewThreads node of QUERY; a node without comments has no opener and is no bot thread."""
    comments = node.get("comments") or {}
    nodes = [comment or {} for comment in comments.get("nodes") or []]
    author = (nodes[0].get("author") or {}) if nodes else {}
    review = (nodes[0].get("pullRequestReview") or {}) if nodes else {}
    return Thread(
        resolved=bool(node.get("isResolved")),
        opener=author.get("login") or "",
        opener_kind=author.get("__typename") or "",
        opener_review=review.get("body") or "",
        repliers=tuple((comment.get("author") or {}).get("login") or "" for comment in nodes[1:]),
        partial=comments.get("totalCount", len(nodes)) > len(nodes),
        name=thread_name(node),
    )


def repo_flags(scope):
    """to_state()'s per-repo keywords for a repos.txt scope.

    A Baseline repo ("full") requires checks and runs PR Auto-Merge, and so
    does repo-settings-only (dotfiles), with a copy of PR Auto-Merge and a
    main-rules ruleset of its own.
    """
    return {"checks_required": True, "merged_by_workflow": True}


def to_state(node, checks_required=True, merged_by_workflow=False, want_ready=False, copilot_dropped=False):
    """A PrState from one pullRequests node of QUERY.

    copilot_dropped is the caller's memory that Copilot's request for this
    head didn't register; a one-shot read has none, so it shows the Copilot step.
    """
    commits = node["commits"]["nodes"]
    rollup = commits[0]["commit"]["statusCheckRollup"] if commits else None
    contexts = rollup["contexts"]["nodes"] if rollup else []
    reviews = [((review.get("author") or {}).get("login"), (review.get("commit") or {}).get("oid"), review.get("body"))
               for review in node["reviews"]["nodes"]]
    # Copilot is requested as a Bot; a login or a team name, like reapply.sh's copilot_jq.
    requested = [(request.get("requestedReviewer") or {}) for request in (node.get("reviewRequests") or {}).get("nodes", [])]
    labels = {label["name"] for label in (node.get("labels") or {}).get("nodes", []) if label}
    return PrState(
        state=node["state"],
        draft=node["isDraft"],
        head=node["headRefOid"],
        copilot_reviewed=copilot_reviews(reviews),
        copilot_declined=copilot_declined(reviews),
        # Merge commits don't count toward PR Auto-Merge's cap.
        merge_commits=frozenset(review["commit"]["oid"] for review in node["reviews"]["nodes"]
                                if ((review.get("commit") or {}).get("parents") or {}).get("totalCount", 1) > 1),
        claude_reviewed=claude_reviews(reviews),
        claude_off_diff=claude_off_diff(reviews),
        copilot_requested=any(COPILOT.search(reviewer.get("login") or reviewer.get("name") or "") for reviewer in requested),
        claude_requested=REVIEW_CLAUDE in labels,
        copilot_dropped=copilot_dropped,
        open_threads=sum(1 for thread in node["reviewThreads"]["nodes"] if not thread["isResolved"]),
        unreplied_threads=unreplied_threads([to_thread(thread) for thread in node["reviewThreads"]["nodes"]]),
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
    notice = unreplied_notice(pr)
    return (f"{name}#{node['number']} {shorten(node['title']):<{TITLE_WIDTH}} {pr.head[:7]}"
            f" {'draft' if pr.draft else 'ready'} {pr.merge_state}"
            f" review:{pr.head_reviewer or 'no'} threads:{pr.open_threads}"
            f" automerge:{'on' if pr.auto_merge_armed else 'off'}"
            f" running:{len(checks.running)} failed:{len(checks.failed)} cancelled:{len(checks.cancelled)}"
            f" -> {decision.action} ({decision.reason})" + (f" {notice}" if notice else ""))


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

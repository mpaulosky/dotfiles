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
thread comments the notice needs; they would cost far more in the repo query), and one for each open, ready PR whose head
Copilot hasn't reviewed and isn't asked for, or whose review loop could be exhausted (the last 100 comments, for the
record that Copilot was asked and PR Auto-Merge's exhaustion comment), read-only. Prints nothing else, apart from one line when no PR is
open; a repo that can't be read is reported on stderr and exits 1.

Every listed repo requires checks and runs PR Auto-Merge, which merges a
reviewed PR itself: a Baseline repo through Apply, and dotfiles (repos.txt
scope repo-settings-only) through its copy and its hand-made main-rules.
"""

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime

from landing import (COPILOT, EXHAUSTED_MARKER, GITHUB_ACTIONS, MAX_CLAUDE_ROUNDS, RELEASE_BLOG_BRANCHES, REVIEW_CLAUDE, Check,
                     PrState, Thread, claude_off_diff, claude_reviews, copilot_ask, copilot_declined, copilot_reviews, decide,
                     is_claude_review, review_rounds, summarize_checks, trailing_dirty, unreplied_notice, unreplied_threads)
from settings import read_repo_list

QUERY = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        id number title state isDraft headRefName headRefOid mergeStateStatus
        autoMergeRequest { enabledAt }
        labels(first: 20) { nodes { name } }
        timelineItems(last: 30, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt label { name } } } }
        reviewRequests(first: 20) { nodes { requestedReviewer {
          ... on Bot { login }
          ... on User { login }
          ... on Team { name }
        } } }
        reviews(last: 100) { nodes { author { login } commit { oid parents { totalCount } } body submittedAt comments { totalCount } } }
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

# The last 100 comments of one PR, for the record that Copilot was asked (mpaulosky/dotfiles#360) and PR Auto-Merge's
# comment on an exhausted review loop (mpaulosky/dotfiles#375).
COMMENTS_QUERY = """
query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      comments(last: 100) { totalCount nodes { author { login } body createdAt } }
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

# PR ids (and ("record", id) for COMMENTS_QUERY) whose failure was already reported, so a polling land.py says it once.
COMMENTS_FAILED = set()


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


def requested_reviewers(node):
    """The reviewers a PR's review requests name (a Bot has a login, a team a name)."""
    return [(request.get("requestedReviewer") or {}) for request in (node.get("reviewRequests") or {}).get("nodes", [])]


def needs_record(node):
    """Whether the record that Copilot was asked matters for this PR: open, ready, no real Copilot review of the head, no request."""
    if node.get("state") != "OPEN" or node.get("isDraft"):
        return False
    if any(COPILOT.search(reviewer.get("login") or reviewer.get("name") or "") for reviewer in requested_reviewers(node)):
        return False
    reviews = [((review.get("author") or {}).get("login"), (review.get("commit") or {}).get("oid"), review.get("body"))
               for review in node["reviews"]["nodes"]]
    return node["headRefOid"] not in copilot_reviews(reviews)


def could_be_exhausted(node):
    """Whether the PR's review loop could be exhausted: MAX_CLAUDE_ROUNDS dirty rounds in a row, before any restart.

    Claude's reviews count here as if Copilot were gone unless a request is pending, since only the comments say
    whether it is; the exact answer is to_state()'s.
    """
    requested = any(COPILOT.search(reviewer.get("login") or reviewer.get("name") or "") for reviewer in requested_reviewers(node))
    declined = copilot_declined([((review.get("author") or {}).get("login"), (review.get("commit") or {}).get("oid"), review.get("body"))
                                 for review in node["reviews"]["nodes"]])
    return trailing_dirty(review_rounds(review_records(node), declined, not requested or node["headRefOid"] in declined)) >= MAX_CLAUDE_ROUNDS


def needs_comments(node):
    """Whether the PR's comments are read: for the record of Copilot's ask (needs_record) or for its review loop's exhaustion comment."""
    if node.get("state") != "OPEN":
        return False
    return needs_record(node) or (not node.get("isDraft") and could_be_exhausted(node))


def gh_graphql(owner, name):
    """The query's data for one repo, through `gh api graphql`.

    QUERY reads no thread comments: on 50 PRs of 100 threads they would cost
    about 53 points a read instead of 3. A PR whose threads are all resolved
    and that a bot reviewed gets THREADS_QUERY (1 point), and its thread nodes
    are replaced by that query's, which carry the comments the notice reads.
    The notice is advisory, so a failed or empty comments query keeps the
    comment-less nodes (no notice) and never costs the repo's read; the first
    failure for a PR is reported on stderr.

    QUERY reads no comments either. A PR that needs the record that Copilot was
    asked (needs_record), or whose review loop could be exhausted
    (could_be_exhausted: PR Auto-Merge's exhaustion comment decides), gets
    COMMENTS_QUERY (1 point) and its node a "comments" key; a failed query sets
    it to None, which to_state reads as a record nobody can see: neither asked
    nor called dropped, and the loop never exhausted. The first failure is reported.
    """
    data = graphql(QUERY, f"owner={owner}", f"name={name}")
    for node in data["repository"]["pullRequests"]["nodes"]:
        if needs_comments(node):
            try:
                node["comments"] = graphql(COMMENTS_QUERY, id=node["id"])["node"]["comments"]
            except Exception as error:  # noqa: BLE001 - an unread record fails closed, it mustn't make the repo unreadable
                node["comments"] = None
                if ("record", node["id"]) not in COMMENTS_FAILED:
                    COMMENTS_FAILED.add(("record", node["id"]))
                    sys.stderr.write(f"{owner}/{name}#{node.get('number')}: comments unreadable, Copilot neither asked nor called gone, "
                                     f"its review loop not called exhausted: {error!r}\n")
        threads = node["reviewThreads"]["nodes"]
        if threads and all(thread["isResolved"] for thread in threads) and bot_reviewed(node):
            try:
                node["reviewThreads"]["nodes"] = graphql(THREADS_QUERY, id=node["id"])["node"]["reviewThreads"]["nodes"]
            except Exception as error:  # noqa: BLE001 - an advisory notice mustn't make the repo unreadable
                if node["id"] not in COMMENTS_FAILED:
                    COMMENTS_FAILED.add(node["id"])
                    sys.stderr.write(f"{owner}/{name}#{node.get('number')}: thread comments unreadable, no notice: {error!r}\n")
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


def asked_copilot(node, owner, now):
    """copilot_ask() for a node's "comments" (COMMENTS_QUERY's): absent or None, or a page that hides the record, is unread."""
    comments = node.get("comments")
    if comments is None:
        return copilot_ask(None, owner, now)
    nodes = [comment or {} for comment in comments.get("nodes") or []]
    found = copilot_ask([((comment.get("author") or {}).get("login") or "", comment.get("body") or "", comment.get("createdAt"))
                         for comment in nodes], owner, now)
    # More comments than were read and no record among them: it may be on a page that wasn't read.
    if found == (False, False) and comments.get("totalCount", len(nodes)) > len(nodes):
        return copilot_ask(None, owner, now)
    return found


def review_records(node):
    """The reviews of QUERY's node as review_rounds() reads them: (login, oid, body, submittedAt, inline thread count, is a merge)."""
    return [((review.get("author") or {}).get("login"), (review.get("commit") or {}).get("oid"), review.get("body"),
             review.get("submittedAt"), (review.get("comments") or {}).get("totalCount", 0),
             ((review.get("commit") or {}).get("parents") or {}).get("totalCount", 1) > 1)
            for review in node["reviews"]["nodes"]]


def instant(text):
    """An ISO-8601 time as epoch seconds; -inf when it is missing or unreadable, which sorts before every time."""
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return float("-inf")


def review_loop(node, rounds):
    """(rounds, exhaustion_marker_newest, loop_unread) for a node's review rounds, cut at the owner's re-add of review:claude.

    PR Auto-Merge's exhaustion comment (github-actions, EXHAUSTED_MARKER) is read from the node's "comments"; the newest
    one decides. The loop restarts at the first review:claude added after it, which is the owner's re-add (PR Auto-Merge's
    own later adds mustn't restart it): only rounds submitted after that count. Comments or label events that can't be
    read make the loop unread when it could be exhausted, so it never is (reviewLoopState does the same).
    """
    could_be = trailing_dirty(rounds) >= MAX_CLAUDE_ROUNDS
    comments = node.get("comments")
    events = (node.get("timelineItems") or {}).get("nodes")
    if comments is None:
        return rounds, False, could_be
    nodes = [comment or {} for comment in comments.get("nodes") or []]
    markers = [comment for comment in nodes
               if ((comment.get("author") or {}).get("login") or "").removesuffix("[bot]") == GITHUB_ACTIONS
               and EXHAUSTED_MARKER in (comment.get("body") or "")]
    if not markers:
        # More comments than were read and no record among them: it may be on a page that wasn't read.
        return rounds, False, could_be and comments.get("totalCount", len(nodes)) > len(nodes)
    if events is None:
        return rounds, False, could_be
    marker_at = instant(markers[-1].get("createdAt"))
    restart = next((event for event in events
                    if ((event or {}).get("label") or {}).get("name") == REVIEW_CLAUDE and instant(event.get("createdAt")) > marker_at),
                   None)
    if restart is None:
        return rounds, True, False
    restart_at = instant(restart.get("createdAt"))
    return tuple(item for item in rounds if instant(item.at) > restart_at), False, False


def to_state(node, checks_required=True, merged_by_workflow=False, want_ready=False, copilot_dropped=False, owner="",
             now=None):
    """A PrState from one pullRequests node of QUERY.

    copilot_dropped is the caller's memory that Copilot's request for this
    head didn't register. owner is the repository's owner, who with
    github-actions may write the record that Copilot was asked; now is epoch
    seconds (default: the clock), which the record's 30 seconds are counted to.
    """
    asked, settled = asked_copilot(node, owner, time.time() if now is None else now)
    commits = node["commits"]["nodes"]
    rollup = commits[0]["commit"]["statusCheckRollup"] if commits else None
    contexts = rollup["contexts"]["nodes"] if rollup else []
    reviews = [((review.get("author") or {}).get("login"), (review.get("commit") or {}).get("oid"), review.get("body"))
               for review in node["reviews"]["nodes"]]
    # Copilot is requested as a Bot; a login or a team name, like reapply.sh's copilot_jq.
    requested = requested_reviewers(node)
    copilot_is_requested = any(COPILOT.search(reviewer.get("login") or reviewer.get("name") or "") for reviewer in requested)
    labels = {label["name"] for label in (node.get("labels") or {}).get("nodes", []) if label}
    declined = copilot_declined(reviews)
    # Copilot can't review the PR (landing.PrState.claude_backed): Claude's review of any commit then counts as a round.
    gone = copilot_dropped or (asked and settled and not copilot_is_requested) or node["headRefOid"] in declined
    rounds, marker_newest, unread = review_loop(node, review_rounds(review_records(node), declined, gone))
    return PrState(
        state=node["state"],
        draft=node["isDraft"],
        head=node["headRefOid"],
        copilot_reviewed=copilot_reviews(reviews),
        copilot_declined=declined,
        rounds=rounds,
        exhaustion_marker_newest=marker_newest,
        loop_unread=unread,
        claude_reviewed=claude_reviews(reviews),
        claude_off_diff=claude_off_diff(reviews),
        copilot_requested=copilot_is_requested,
        claude_requested=REVIEW_CLAUDE in labels,
        copilot_dropped=copilot_dropped,
        copilot_asked=asked,
        copilot_ask_settled=settled,
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
            lines.append(line(repo, node, to_state(node, **flags, owner=owner)))
    if lines:
        out.write("\n".join(lines) + "\n")
    elif status == 0:
        out.write(f"No open PRs in {len(repos)} repo(s).\n")
    return status


if __name__ == "__main__":
    sys.exit(main())

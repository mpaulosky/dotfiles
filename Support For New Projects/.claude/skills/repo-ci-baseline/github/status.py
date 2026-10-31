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
Copilot hasn't reviewed and isn't asked for, or whose review loop could be exhausted (its comments, back to PR
Auto-Merge's exhaustion comment, for it and the record that Copilot was asked; its review:claude label events, all of them,
with the permission of each login that added one; and the authors of its open threads, a person's holding the merge),
read-only. Prints nothing else, apart from one line when no PR is
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
                     PrState, Thread, claude_off_diff, claude_reviews, copilot_ask, copilot_declined, copilot_reviews, current_loop,
                     decide, is_claude_review, review_rounds, summarize_checks, thread_opened_by_person, trailing_dirty,
                     unreplied_notice, unreplied_threads)
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

# A page of up to 100 comments of one PR, the newest 100 by default and the page before $cursor when given (startCursor
# of the page read last), for the record that Copilot was asked (mpaulosky/dotfiles#360) and PR Auto-Merge's comment on
# an exhausted review loop (mpaulosky/dotfiles#375). A loop that could be exhausted pages back to its comment, or the
# first comment (mpaulosky/dotfiles#378).
COMMENTS_QUERY = """
query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      # comments(last: 100) is the newest page; with $cursor, the 100 before it.
      comments(last: 100, before: $cursor) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { author { login } body createdAt }
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

# The PR's label events, oldest first, a page of 100 at a time after $cursor (mpaulosky/dotfiles#378): every one is read,
# since the owner's add of review:claude that restarts a loop can come after any number of others.
EVENTS_QUERY = """
query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      timelineItems(first: 100, after: $cursor, itemTypes: [LABELED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on LabeledEvent { createdAt label { name } actor { login __typename } } }
      }
    }
  }
}
"""

# {(owner/name, login): True | False} for the collaborator permission lookups that were read: whether the login has write
# access. A lookup that failed isn't kept, so the next read tries again.
PERMISSIONS = {}


def rest(path):
    """The parsed JSON of one `gh api <path>` call."""
    run = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip() or run.stdout.strip())
    return json.loads(run.stdout)


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


def exhaustion_markers(nodes):
    """The comments among COMMENTS_QUERY's nodes that are PR Auto-Merge's (github-actions) exhaustion comments."""
    return [comment for comment in nodes
            if ((comment.get("author") or {}).get("login") or "").removesuffix("[bot]") == GITHUB_ACTIONS
            and EXHAUSTED_MARKER in (comment.get("body") or "")]


def read_comments(node_id, to_the_marker):
    """The comments COMMENTS_QUERY reads for a PR, as its "comments" key: {totalCount, nodes}, oldest first.

    The newest 100. With to_the_marker (a review loop that could be exhausted) the pages before it too, until a page
    holds PR Auto-Merge's exhaustion comment or the first comment is read (mpaulosky/dotfiles#378), so a PR with more
    than 100 comments is read in full, as the workflow reads it. A page that fails raises.
    """
    comments = graphql(COMMENTS_QUERY, id=node_id)["node"]["comments"]
    nodes = [comment or {} for comment in comments.get("nodes") or []]
    info = comments.get("pageInfo") or {}
    while to_the_marker and info.get("hasPreviousPage") and not exhaustion_markers(nodes):
        page = graphql(COMMENTS_QUERY, id=node_id, cursor=info["startCursor"])["node"]["comments"]
        nodes = [comment or {} for comment in page.get("nodes") or []] + nodes
        info = page.get("pageInfo") or {}
    total = len(nodes) if to_the_marker and not info.get("hasPreviousPage") else comments.get("totalCount", len(nodes))
    return {"totalCount": total, "nodes": nodes}


def writer_access(owner, name, actor):
    """Whether the login that did a label event has write access to the repo: True, False, or None when it can't be read.

    The repository's owner always has it, a bot or an actor that can't be read (a deleted account) never does; any other
    login is asked once through the collaborators' permission endpoint (admin or write), and a failed lookup isn't kept.
    """
    login = (actor or {}).get("login")
    if not login or actor.get("__typename") == "Bot":
        return False
    if login.lower() == owner.lower():
        return True
    key = (f"{owner}/{name}", login)
    if key not in PERMISSIONS:
        try:
            PERMISSIONS[key] = rest(f"repos/{owner}/{name}/collaborators/{login}/permission").get("permission") in ("admin", "write")
        except Exception:  # noqa: BLE001 - an unreadable permission makes the loop unread, never a restart
            return None
    return PERMISSIONS[key]


def read_label_events(owner, name, node_id):
    """The PR's review:claude label events, all of them, oldest first, as [{createdAt, writer}] (see writer_access).

    EVENTS_QUERY is paged to the end: the add that restarts a loop can follow any number of others
    (mpaulosky/dotfiles#378). A page that fails raises.
    """
    events, cursor = [], None
    while True:
        page = graphql(EVENTS_QUERY, id=node_id, **({"cursor": cursor} if cursor else {}))["node"]["timelineItems"]
        events += page.get("nodes") or []
        info = page.get("pageInfo") or {}
        if not info.get("hasNextPage"):
            break
        cursor = info["endCursor"]
    return [{"createdAt": event.get("createdAt"), "writer": writer_access(owner, name, event.get("actor"))}
            for event in events if event and (event.get("label") or {}).get("name") == REVIEW_CLAUDE]


def report_once(key, message):
    """Write message on stderr the first time key fails, so a polling land.py says it once."""
    if key not in COMMENTS_FAILED:
        COMMENTS_FAILED.add(key)
        sys.stderr.write(message)


def gh_graphql(owner, name):
    """The query's data for one repo, through `gh api graphql`.

    QUERY reads no thread comments: on 50 PRs of 100 threads they would cost
    about 53 points a read instead of 3. A PR whose threads are all resolved
    and that a bot reviewed gets THREADS_QUERY (1 point), and its thread nodes
    are replaced by that query's, which carry the comments the notice reads.
    So does a PR that could be exhausted and has an unresolved thread: the
    authors tell the threads a person opened, which hold the merge, from
    Copilot's and Claude Review's (mpaulosky/dotfiles#378). The notice is
    advisory, so a failed or empty comments query keeps the comment-less nodes
    (no notice, and every unresolved thread counts as a person's) and never
    costs the repo's read; the first failure for a PR is reported on stderr.

    QUERY reads no comments either. A PR that needs the record that Copilot
    was asked (needs_record), or whose review loop could be exhausted
    (could_be_exhausted: PR Auto-Merge's exhaustion comment decides), gets
    COMMENTS_QUERY (1 point) and its node a "comments" key, the pages back to
    the exhaustion comment for a loop that could be exhausted; a failed query
    sets it to None, which to_state reads as a record nobody can see: neither
    asked nor called dropped, and the loop never exhausted. A loop that could
    be exhausted also gets all its review:claude label events, EVENTS_QUERY
    paged, in "labelEvents" (None when a page failed, which to_state reads as
    a loop it can't tell the state of). The first failure is reported.
    """
    data = graphql(QUERY, f"owner={owner}", f"name={name}")
    for node in data["repository"]["pullRequests"]["nodes"]:
        label = f"{owner}/{name}#{node.get('number')}"
        candidate = node.get("state") == "OPEN" and not node.get("isDraft") and could_be_exhausted(node)
        if needs_comments(node):
            try:
                node["comments"] = read_comments(node["id"], candidate)
            except Exception as error:  # noqa: BLE001 - an unread record fails closed, it mustn't make the repo unreadable
                node["comments"] = None
                report_once(("record", node["id"]), f"{label}: comments unreadable, Copilot neither asked nor called gone, "
                                                    f"its review loop not called exhausted: {error!r}\n")
        if candidate:
            try:
                node["labelEvents"] = read_label_events(owner, name, node["id"])
            except Exception as error:  # noqa: BLE001 - unread events fail closed, they mustn't make the repo unreadable
                node["labelEvents"] = None
                report_once(("events", node["id"]), f"{label}: label events unreadable, its review loop not called exhausted: {error!r}\n")
        threads = node["reviewThreads"]["nodes"]
        resolved = threads and all(thread["isResolved"] for thread in threads) and bot_reviewed(node)
        authors = candidate and not all(thread["isResolved"] for thread in threads)
        if resolved or authors:
            try:
                node["reviewThreads"]["nodes"] = graphql(THREADS_QUERY, id=node["id"])["node"]["reviewThreads"]["nodes"]
            except Exception as error:  # noqa: BLE001 - an advisory notice mustn't make the repo unreadable
                report_once(node["id"] if resolved else ("authors", node["id"]),
                            f"{label}: thread comments unreadable, no notice"
                            + ("" if resolved else ", every unresolved thread counts as a person's")
                            + f": {error!r}\n")
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


def review_loop(node, rounds, copilot_cant_review):
    """(rounds, exhaustion_marker_newest, loop_unread) for a node's review rounds, after the loop's restarts.

    The rounds that count are the final generation's (landing.current_loop): a loop that reached MAX_CLAUDE_ROUNDS dirty
    rounds in a row restarts at the first review:claude added after the round that got it there by a login with write
    access, comment or none, while Copilot can't review (copilot_cant_review); with Copilot available the label is ignored.
    PR Auto-Merge's exhaustion comment (github-actions, EXHAUSTED_MARKER) is read from the node's "comments"; it is the
    newest word when it is no older than the round that exhausted the final generation. Comments, label events or a
    permission that can't be read make the loop unread when it reached the cap, so it never is called exhausted
    (reviewLoopState does the same).
    """
    streak = longest = 0
    for item in rounds:
        streak = streak + 1 if item.dirty else 0
        longest = max(longest, streak)
    if longest < MAX_CLAUDE_ROUNDS:
        return rounds, False, False
    comments = node.get("comments")
    events = node.get("labelEvents")
    if comments is None or events is None:
        return rounds, False, True
    nodes = [comment or {} for comment in comments.get("nodes") or []]
    adds = [(instant(event.get("createdAt")), event.get("writer")) for event in events] if copilot_cant_review else []
    walk = current_loop(rounds, adds)
    markers = [instant(comment.get("createdAt")) for comment in exhaustion_markers(nodes)]
    # More comments than were read and no record among them: it may be on a page that wasn't read.
    if walk.unread or (not markers and comments.get("totalCount", len(nodes)) > len(nodes)):
        return walk.rounds, False, True
    return walk.rounds, walk.hit is not None and any(marker >= walk.hit for marker in markers), False


def to_state(node, checks_required=True, merged_by_workflow=False, want_ready=False, owner="",
             now=None):
    """A PrState from one pullRequests node of QUERY.

    owner is the repository's owner, who with
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
    gone = (asked and settled and not copilot_is_requested) or node["headRefOid"] in declined
    # Claude reviews only where Copilot can't (mpaulosky/dotfiles#378): its quota note is on the head, or it is gone and
    # hasn't really reviewed the head. Otherwise a review:claude add means nothing, and starts no new loop.
    cant_review = node["headRefOid"] in declined or (gone and node["headRefOid"] not in copilot_reviews(reviews))
    rounds, marker_newest, unread = review_loop(node, review_rounds(review_records(node), declined, gone), cant_review)
    threads = [(thread["isResolved"], to_thread(thread)) for thread in node["reviewThreads"]["nodes"]]
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
        copilot_asked=asked,
        copilot_ask_settled=settled,
        open_threads=sum(1 for resolved, _ in threads if not resolved),
        open_person_threads=sum(1 for resolved, thread in threads if not resolved and thread_opened_by_person(thread)),
        unreplied_threads=unreplied_threads([thread for _, thread in threads]),
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

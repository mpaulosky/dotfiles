#!/usr/bin/env bash
# Watches one pull request and exits with the reason when the session that opened it needs to act. Owned by the repo-ci-baseline
# Template (references/watch-pr.md). Read-only: it makes `gh api graphql` queries and writes only its seen file.
#   scripts/watch-pr.sh [--once] [--interval <seconds>] [--timeout <minutes>] <pr-number>
#   scripts/watch-pr.sh --would-skip      reads a comment body on stdin; exit 0 when the watcher skips it, 1 when it wouldn't
#
# Each poll prints one `watch-pr: <code>: <detail>` line per reason that applies, then exits 0. The codes, in order:
#   merged, closed    the PR is done (printed alone)
#   conflict          the PR conflicts with its base
#   behind            the base branch moved and the repo requires an up-to-date branch
#   check-failed      a check run failed, timed out, needs action or didn't start, or a status context failed
#   thread            an unresolved review thread whose last comment is not the session's or Sandcastle's
#   changes-requested a person's review requested changes (reported once)
#   review            a person's review with a body (reported once)
#   comment           a person's PR comment (reported once)
# A one-shot event is recorded in watch-pr-<n>.seen in the git common directory, so the next run stays quiet about it.
#
# A comment is the session's when its body contains WATCH_PR_MARKER (default `<!-- claude-session -->`), and Sandcastle's when it
# starts with `<!-- sandcastle:<name> -->`, with or without data after the name. Neither wakes the watcher: both post under the
# owner's token, so the marker is the only way to tell them from the owner.
#
# Exit codes: 0 the session is needed; 1 quiet until the timeout (or after --once); 2 a usage error, a missing tool or a PR that
# can't be read (five polls in a row fail; a poll that fails or isn't GitHub's answer is never read as quiet).
# Environment: WATCH_PR_MARKER, WATCH_PR_INTERVAL (default 60 seconds; each poll costs about 1-3 GraphQL points, so not lower),
# WATCH_PR_TIMEOUT (default 120 minutes), GITHUB_REPOSITORY (else the upstream, then the origin remote).
set -euo pipefail

usage() {
  echo "Usage: scripts/watch-pr.sh [--once] [--interval <seconds>] [--timeout <minutes>] <pr-number>" >&2
  echo "       scripts/watch-pr.sh --would-skip   (a comment body on stdin)" >&2
}

MARKER="${WATCH_PR_MARKER:-<!-- claude-session -->}"
interval="${WATCH_PR_INTERVAL:-60}"
timeout_min="${WATCH_PR_TIMEOUT:-120}"
once=0
would_skip=0
pr=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) once=1 ;;
    --would-skip) would_skip=1 ;;
    --interval | --timeout)
      if [[ $# -lt 2 ]]; then usage; exit 2; fi
      if [[ "$1" == "--interval" ]]; then interval="$2"; else timeout_min="$2"; fi
      shift
      ;;
    --interval=*) interval="${1#*=}" ;;
    --timeout=*) timeout_min="${1#*=}" ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "watch-pr: unknown option $1" >&2; usage; exit 2 ;;
    *)
      if [[ -n "$pr" ]]; then usage; exit 2; fi
      pr="$1"
      ;;
  esac
  shift
done

if ! command -v jq >/dev/null 2>&1; then
  echo "watch-pr: jq is required and was not found on PATH" >&2
  exit 2
fi

# The classifier, written once for the poll and for --would-skip. A body is ours when it carries the session's marker anywhere,
# or starts (\A, not ^, which also matches after a newline) with a Sandcastle marker: a name of lower-case letters and hyphens,
# then optionally data (approved-head and overlap carry some), then `-->`.
# shellcheck disable=SC2016 # jq's $variables are not the shell's
OURS_JQ='
  def ours($body):
    ($body // "") as $s
    | ($s | contains($session)) or ($s | test("\\A<!-- sandcastle:[a-z-]+( [^>\n]*)?-->"));
'

if ((would_skip)); then
  [[ "$(jq -Rs --arg session "$MARKER" "$OURS_JQ"' ours(.)')" == "true" ]]
  exit $?
fi

if [[ -z "$pr" || ! "$pr" =~ ^[1-9][0-9]*$ ]]; then usage; exit 2; fi
if [[ ! "$interval" =~ ^[1-9][0-9]*$ ]]; then echo "watch-pr: --interval must be a whole number of seconds, 1 or more" >&2; exit 2; fi
if [[ ! "$timeout_min" =~ ^[1-9][0-9]*$ ]]; then echo "watch-pr: --timeout must be a whole number of minutes, 1 or more" >&2; exit 2; fi

if ! command -v gh >/dev/null 2>&1; then # gh-repo: ok
  echo "watch-pr: gh is required and was not found on PATH" >&2 # gh-repo: ok
  exit 2
fi

url="$(git remote get-url upstream 2>/dev/null || git remote get-url origin 2>/dev/null || true)"
url="${url%.git}"
repo="${GITHUB_REPOSITORY:-}"
if [[ -z "$repo" && -n "$url" ]]; then repo="${url#*github.com[:/]}"; fi
if [[ ! "$repo" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo "watch-pr: can't tell which repository to watch: set GITHUB_REPOSITORY or add an upstream or origin remote" >&2
  exit 2
fi
export GH_REPO="${repo:?}"

common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
seen_file="$common_dir/watch-pr-$pr.seen"

# shellcheck disable=SC2016 # GraphQL's $variables are not the shell's
QUERY='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state merged mergeable mergeStateStatus headRefOid commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}} reviewThreads(first:100){nodes{isResolved comments(last:1){nodes{author{__typename login} body}}}} reviews(last:50){nodes{id state author{__typename login} body}} comments(last:50){nodes{id author{__typename login} body}}}}}'

# The response must have GitHub's shape, with every list present: anything else is a failed poll, never a quiet one.
SHAPE_JQ='
  .data.repository.pullRequest
  | type == "object" and (.state | type == "string")
    and ([.commits.nodes, .reviewThreads.nodes, .reviews.nodes, .comments.nodes] | all(type == "array"))
'

# One line per reason: code, detail and the node id of a one-shot event (else empty), apart by the unit separator.
# shellcheck disable=SC2016
REASONS_JQ="$OURS_JQ"'
  def clean: tostring | gsub("[\u0001-\u001f\u007f]"; " ") | .[0:200];
  def first_line: (. // "") | split("\n")[0];
  def person: (.author.__typename // "") != "Bot";
  def who: .author.login // "unknown";
  def line($code; $detail; $id): [$code, ($detail | clean), $id] | join("\u001f");
  .data.repository.pullRequest as $pr
  | ($seen | split("\n")) as $seen_ids
  | if $pr.state == "MERGED" or $pr.merged == true then line("merged"; "the PR was merged"; "")
    elif $pr.state == "CLOSED" then line("closed"; "the PR was closed without merging"; "")
    else
      (if $pr.mergeable == "CONFLICTING" then line("conflict"; "the PR conflicts with its base branch"; "")
       elif $pr.mergeStateStatus == "BEHIND" then line("behind"; "the base branch has moved on; merge it into the PR"; "")
       else empty end),
      ([($pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes // [])[]
        | select((.conclusion as $c | ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"] | index($c))
                 or (.state as $s | ["FAILURE", "ERROR"] | index($s)))
        | (.name // .context)]
       | if length > 0 then line("check-failed"; join(", "); "") else empty end),
      ($pr.reviewThreads.nodes[]
       | select(.isResolved == false)
       | (.comments.nodes | last) as $last
       | select($last != null and (ours($last.body) | not))
       | line("thread"; "\($last | who): \($last.body | first_line)"; "")),
      ($pr.reviews.nodes[]
       | select(person and (ours(.body) | not) and (.id as $id | $seen_ids | index($id) | not))
       | if .state == "CHANGES_REQUESTED" then line("changes-requested"; "\(who): \(if (.body // "") == "" then "(no text)" else .body | first_line end)"; .id)
         elif ((.body // "") | test("\\S")) and .state != "PENDING" then line("review"; "\(who): \(.body | first_line)"; .id)
         else empty end),
      ($pr.comments.nodes[]
       | select(person and (ours(.body) | not) and (.id as $id | $seen_ids | index($id) | not))
       | line("comment"; "\(who): \((.body // "") | first_line)"; .id))
    end
'

errfile="$(mktemp)"
trap 'command rm -f "$errfile"' EXIT

failures=0
elapsed=0

while true; do
  ok=1
  resp=""
  if ! resp="$(gh api graphql -f query="$QUERY" -f owner="${repo%%/*}" -f name="${repo#*/}" -F number="$pr" 2>"$errfile")"; then
    ok=0
    reason="gh failed: $(head -n 1 "$errfile")"
  elif ! printf '%s' "$resp" | jq -e "$SHAPE_JQ" >/dev/null 2>&1; then
    ok=0
    reason="the answer is not a pull request"
  fi

  if ((ok)); then
    seen_text=""
    if [[ -f "$seen_file" ]]; then seen_text="$(<"$seen_file")"; fi
    if ! reasons="$(printf '%s' "$resp" | jq -r --arg session "$MARKER" --arg seen "$seen_text" "$REASONS_JQ" 2>/dev/null)"; then
      ok=0
      reason="the answer could not be read"
    fi
  fi

  if ((ok)); then
    failures=0
    if [[ -n "$reasons" ]]; then
      while IFS=$'\x1f' read -r code detail id; do
        echo "watch-pr: $code: $detail"
        if [[ -n "$id" ]]; then echo "$id" >> "$seen_file"; fi
      done <<< "$reasons"
      exit 0
    fi
    if ((once)); then exit 1; fi
    # The timeout counts the waits between quiet polls; a failed poll's wait doesn't count, and at most four of them run in a row.
    if ((elapsed + interval > timeout_min * 60)); then exit 1; fi
    elapsed=$((elapsed + interval))
  else
    failures=$((failures + 1))
    echo "watch-pr: poll $failures failed: $reason" >&2
    if ((once || failures >= 5)); then
      echo "watch-pr: can't read PR $pr of $repo" >&2
      exit 2
    fi
  fi
  sleep "$interval"
done

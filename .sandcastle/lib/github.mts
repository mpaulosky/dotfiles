// gh helpers. Only the host talks to GitHub: the sandbox gets no token, so
// everything a role needs from GitHub reaches it through its prompt. Every gh
// command runs in the main checkout, never in a worktree, and names the
// repository itself (--repo, or repos/<owner>/<name> for gh api) rather than
// working it out from the git remote of wherever it runs.

import { execFileSync } from "node:child_process";
import { endOf } from "./checkpoint.mts";
import { COPILOT_REVIEWER, QUEUE_LABEL, SANDCASTLE_LABELS, type QueueScope, type SandcastleLabel } from "./config.mts";
import type { CheckState, SweepPullRequest } from "./follow-up.mts";
import { handBackReport, targetUrl, type HandBackReport } from "./report.mts";
import { sh } from "./shell.mts";

let repo: string | undefined;

// "owner/name" of the repository in the current directory, the main checkout.
// Read on first use rather than at import, so importing a module never shells
// out to gh.
export function repoName(): string {
  repo ??= sh(process.cwd(), "gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
  return repo;
}

export type GhIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: { author: string; body: string }[];
  // When GitHub last changed the issue, a label add or removal included;
  // lib/queue.mts#loadQueue's round cache keys on it. Absent from a stub
  // that doesn't need it.
  updatedAt?: string;
};

export type SandcastleIssue = Omit<GhIssue, "comments"> & {
  // Only the comments of authors with write access to the repository; see ownerApproved.
  comments: string[];
};

// Whether the issue carries `label`. GitHub matches label names
// case-insensitively, so a hand-made "Sandcastle:Ready" is the same label.
export function hasLabel(issue: Pick<SandcastleIssue, "labels">, label: string): boolean {
  return issue.labels.some((name) => name.toLowerCase() === label.toLowerCase());
}

// Keep only the comments of authors with admin, maintain or write permission
// on `repo`, so text from anyone else never reaches a role's prompt.
// Permission rather than the owner's login decides this, because in a
// repository an organization owns the owner never comments (#214). A
// permission lookup that fails drops that author's comments, so an error
// never lets a stranger's text through. `canPush` caches each author's
// answer, so a caller that shares one map across issues looks each author up
// once. Only GitHub's answer is cached, never a failure: one transient error
// would otherwise drop a maintainer's guidance for the rest of the run. A
// failure goes in `failed` instead, which a caller shares across one round's
// issues and starts afresh each round: the author's comments are dropped
// without another lookup or warning until then, since a retry within the same
// burst would most likely fail too and deepen a rate limit.
export function ownerApproved(
  issue: GhIssue,
  repo: string = repoName(),
  run: typeof execFileSync = execFileSync,
  canPush: Map<string, boolean> = new Map(),
  warn: (message: string) => void = console.error,
  failed: Set<string> = new Set(),
): SandcastleIssue {
  const trusted = (author: string): boolean => pushAccess(author, canPush, failed, repo, run, warn) ?? false;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    comments: issue.comments.filter((comment) => trusted(comment.author)).map((comment) => comment.body),
    ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
  };
}

const PUSH_PERMISSIONS: ReadonlySet<unknown> = new Set(["admin", "maintain", "write"]);

// Whether `login` can push to `repo`. GitHub reports maintain as "write" in
// `.permission` and names it only in `.role_name`, so either field counts. A
// 404 whose message says the login "is not a user", as for the bare
// "github-actions" gh prints for a GitHub App's comment, is a definite no,
// cached and not reported. Any other 404 means the token can't see the
// repository, which says nothing about the author. Any other failure, or an answer with neither field, is reported
// through `warn` and returns undefined: it says nothing about the author's
// access.
function hasWriteAccess(
  login: string,
  repo: string,
  run: typeof execFileSync,
  warn: (message: string) => void,
): boolean | undefined {
  try {
    const answer = JSON.parse(
      ghWithStderr(run, ["api", `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`]),
    ) as { permission?: unknown; role_name?: unknown };
    if (typeof answer.permission !== "string" && typeof answer.role_name !== "string") {
      throw new Error(`unexpected answer: ${JSON.stringify(answer)}`);
    }
    return PUSH_PERMISSIONS.has(answer.permission) || PUSH_PERMISSIONS.has(answer.role_name);
  } catch (error) {
    if (/is not a user \(HTTP 404\)/.test(String(error))) return false;
    warn(`  ⚠ Couldn't read ${login}'s permission on ${repo}, so they aren't trusted this time: ${error}`);
    return undefined;
  }
}

// Each login's answer from pushAccess, kept for the whole run so no comment
// author or label actor is looked up twice, however many issues or rounds
// they show up on. The trade-off: write access revoked partway through a run
// isn't seen until the next run, so stop the run to cut someone off at once.
const writeAccessByLogin = new Map<string, boolean>();

// Tri-state: whether `login` has admin, maintain or write permission on
// `repo` (see hasWriteAccess) — who counts as "the repository owner"
// throughout the queue's approval and label-origin checks (lib/queue.mts),
// and the same check ownerApproved uses for a comment's author. A `null`
// login (a deleted account) is a definite no, with no gh call. `canPush` and
// `failed` share one cache and one round's failures with whichever caller
// passes them in, so a login asked about from two places, such as a comment
// and a label event, is looked up once (#146).
export function pushAccess(
  login: string | null,
  canPush: Map<string, boolean> = writeAccessByLogin,
  failed: Set<string> = new Set(),
  repo: string = repoName(),
  run: typeof execFileSync = execFileSync,
  warn: (message: string) => void = console.error,
): boolean | undefined {
  if (login === null) return false;
  const cached = canPush.get(login);
  if (cached !== undefined) return cached;
  if (failed.has(login)) return undefined;
  const allowed = hasWriteAccess(login, repo, run, warn);
  if (allowed === undefined) failed.add(login);
  else canPush.set(login, allowed);
  return allowed;
}

// The open issues in `scope` (lib/config.mts#QueueScope), with every comment
// dropped but those from authors with write access: every open issue
// carrying the scope's label, or the scope's one issue while it's open.
// Callers read the queue through lib/queue.mts#loadQueue, which also checks
// who queued each issue. `canPush` carries authors' answers across the run;
// `failed` holds one round's failed lookups, so a failure is retried next
// round, and loadQueue shares it with its own owner checks.
export function listSandcastleIssues(
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  canPush: Map<string, boolean> = writeAccessByLogin,
  warn: (message: string) => void = console.error,
  scope: QueueScope = { kind: "label", label: QUEUE_LABEL },
  failed: Set<string> = new Set(),
): SandcastleIssue[] {
  const shape = "{number, title, body, labels: [.labels[].name], comments: [.comments[] | {author: .author.login, body}], updatedAt}";
  let issues: GhIssue[];
  if (scope.kind === "label") {
    issues = JSON.parse(
      ghWithStderr(run, [
        "issue", "list", "--repo", repo, "--state", "open", "--label", scope.label, "--limit", "1000",
        "--json", "number,title,body,labels,comments,updatedAt",
        "--jq", `[.[] | ${shape}]`,
      ]),
    ) as GhIssue[];
  } else {
    const viewed = JSON.parse(
      ghWithStderr(run, [
        "issue", "view", String(scope.number), "--repo", repo,
        "--json", "number,title,body,labels,comments,state,url,updatedAt",
        "--jq", `${shape} + {state, url}`,
      ]),
    ) as GhIssue & { state: string; url?: string };
    const { state, url, ...issue } = viewed;
    // SANDCASTLE_ISSUE names an issue to build, never a PR: fail rather than
    // treat a PR as a queued issue, if gh ever answers for one.
    if (url?.includes("/pull/")) throw new Error(`#${scope.number} is a pull request, not an issue.`);
    issues = state === "OPEN" ? [issue] : [];
  }
  return issues.map((issue) => ownerApproved(issue, repo, run, canPush, warn, failed));
}

export type OpenPullRequest = { number: number; headRefName: string };

// An open pull request as gh pr list reports it.
export type ListedPullRequest = OpenPullRequest & { isCrossRepository: boolean; url?: string };

// Only the pull requests whose branch is in this repository. Anyone can open a
// pull request from a fork, with any branch name: matching those by name would
// let an outsider hold an issue back, pass a fork's PR off as the one the host
// opened, or get the fork's changed paths in front of the critique.
export function sameRepository<T extends Pick<ListedPullRequest, "isCrossRepository">>(pullRequests: readonly T[]): T[] {
  return pullRequests.filter((pr) => pr.isCrossRepository === false);
}

// The open pull requests from this repository's branches, and their head
// branches. gh pages through results up to --limit, so the cap sits far above
// any real queue: a PR missed here would let its issue be built twice.
export function openPullRequests(): OpenPullRequest[] {
  const listed = JSON.parse(
    sh(
      process.cwd(), "gh", "pr", "list", "--repo", repoName(), "--state", "open", "--limit", "1000",
      "--json", "number,headRefName,isCrossRepository",
    ),
  ) as ListedPullRequest[];
  return sameRepository(listed).map(({ number, headRefName }) => ({ number, headRefName }));
}

// The open pull request from this repository's `branch`, or a new one for it
// with the title and body, as its URL. A fork's PR from a branch of the same
// name doesn't count.
// Run gh with its stderr captured, and throw with that stderr in the message,
// so a caller can say why it failed.
function ghWithStderr(run: typeof execFileSync, args: string[], input?: string, maxBuffer?: number): string {
  try {
    return run("gh", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed${detail ? `:\n${detail}` : ""}`, { cause: error });
  }
}

export function openPullRequest(
  branch: string,
  title: string,
  body: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): string {
  const listed = JSON.parse(
    ghWithStderr(run, [
      "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,headRefName,isCrossRepository,url",
    ]),
  ) as ListedPullRequest[];
  const existing = sameRepository(listed).find((pr) => pr.headRefName === branch)?.url;
  if (existing) return existing;
  return ghWithStderr(
    run,
    ["pr", "create", "--repo", repo, "--base", "main", "--head", branch, "--title", title, "--body-file", "-"],
    body,
  ).trim();
}

// The fields the follow-up sweep (lib/follow-up.mts) checks on every PR it
// reads, open or closed.
export type PullRequestIdentity = {
  number: number;
  author: string | null;
  body: string;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
};

// A closed PR, as lib/follow-up.mts#closedWithoutMerging reads it to find an
// issue's latest PR that closed without merging. state is "CLOSED" (closed
// without merging) or "MERGED".
export type ClosedPullRequest = PullRequestIdentity & { headRefOid: string; state: string; closedAt: string };

// The host's closed PRs into main, newest first, for
// lib/follow-up.mts#closedWithoutMerging and #startFromMain.
export function closedPullRequests(
  author: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): ClosedPullRequest[] {
  const listed = JSON.parse(
    ghWithStderr(run, [
      "pr", "list", "--state", "closed", "--author", author, "--base", "main", "--repo", repo, "--limit", "1000",
      "--json", "number,author,body,baseRefName,headRefName,headRefOid,isCrossRepository,state,closedAt",
    ]),
  ) as (Omit<ClosedPullRequest, "author"> & { author: unknown })[];
  return listed.map((pr) => ({ ...pr, author: authorLogin(pr.author) }));
}

// The login in an author field: gh's --json and GraphQL give an object with
// a login, or null for a deleted account.
function authorLogin(author: unknown): string | null {
  const login = (author as { login?: unknown } | null)?.login;
  return typeof login === "string" ? login : null;
}

// Each nested list carries its page flags, so a PR with more reviews, threads
// or checks than one page holds is marked truncated rather than decided from
// part of its data. reviews and timelineItems read the newest items (last:),
// so their flag is hasPreviousPage.
const SWEEP_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: "main", first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number isDraft isCrossRepository baseRefName headRefName headRefOid body mergeStateStatus
        author { login }
        labels(first: 50) { pageInfo { hasNextPage } nodes { name } }
        reviewRequests(first: 20) {
          pageInfo { hasNextPage }
          nodes { requestedReviewer { ... on Bot { login } ... on User { login } } }
        }
        reviews(last: 50) { pageInfo { hasPreviousPage } nodes { author { login } commit { oid } } }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes { isResolved comments(first: 1) { nodes { author { __typename login } } } }
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion completedAt }
                    ... on StatusContext { context state createdAt }
                  }
                }
              }
            }
          }
        }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 50) {
          pageInfo { hasPreviousPage }
          nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on Bot { login } ... on User { login } } } }
        }
      }
    }
  }
}`;

type PageInfo = { hasNextPage?: boolean; hasPreviousPage?: boolean; endCursor?: string | null };
type Connection<T> = { pageInfo?: PageInfo; nodes?: (T | null)[] } | null | undefined;
type Login = { login?: string } | null | undefined;
type CheckContext = {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  completedAt?: string | null;
  context?: string;
  state?: string;
  createdAt?: string;
  checkSuite?: { workflowRun?: { databaseId?: number } | null } | null;
};
type SweepNode = {
  id: string;
  number: number;
  isDraft: boolean;
  isCrossRepository: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  body: string | null;
  mergeStateStatus: string;
  author: Login;
  labels: Connection<{ name: string }>;
  reviewRequests: Connection<{ requestedReviewer: Login }>;
  reviews: Connection<{ author: Login; commit: { oid?: string } | null }>;
  reviewThreads: Connection<{ isResolved: boolean; comments: Connection<{ author?: { __typename?: string; login?: string } | null }> }>;
  commits: Connection<{ commit: { oid?: string; statusCheckRollup: { contexts: Connection<CheckContext> } | null } | null }>;
  timelineItems: Connection<{ createdAt?: string; requestedReviewer?: Login }>;
};

// The open PRs into main with everything the follow-up sweep decides from
// (lib/follow-up.mts#sweepPullRequests), through one GraphQL query paged by
// hand, 50 PRs a page. Normalised to SweepPullRequest.
export function openPullRequestsForSweep(
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): SweepPullRequest[] {
  const [owner, name] = repo.split("/") as [string, string];
  const pullRequests: SweepPullRequest[] = [];
  let cursor: string | undefined;
  do {
    const page = JSON.parse(
      ghWithStderr(run, [
        "api", "graphql", "-f", `query=${SWEEP_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`,
        ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
      ]),
    ) as { data?: { repository?: { pullRequests?: Connection<SweepNode> } } };
    const connection = page.data?.repository?.pullRequests;
    // An answer without the list can't be told apart from no open PRs.
    if (!connection?.nodes) throw new Error(`gh api graphql didn't answer the open pull requests: ${JSON.stringify(page)}`);
    pullRequests.push(...nodesOf(connection).map(sweepPullRequest));
    cursor = connection.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? undefined) : undefined;
    if (connection.pageInfo?.hasNextPage && cursor === undefined) throw new Error("gh api graphql gave a next page with no cursor");
  } while (cursor !== undefined);
  return pullRequests;
}

function nodesOf<T>(connection: Connection<T>): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node !== null && node !== undefined);
}

function truncated(connection: Connection<unknown>): boolean {
  return connection?.pageInfo?.hasNextPage === true || connection?.pageInfo?.hasPreviousPage === true;
}

function sweepPullRequest(node: SweepNode): SweepPullRequest {
  const head = nodesOf(node.commits)[0]?.commit;
  const contexts = head?.statusCheckRollup?.contexts;
  return {
    id: node.id,
    number: node.number,
    author: authorLogin(node.author),
    body: node.body ?? "",
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    isCrossRepository: node.isCrossRepository,
    isDraft: node.isDraft,
    labels: nodesOf(node.labels).map((label) => label.name),
    mergeStateStatus: node.mergeStateStatus,
    reviewRequests: nodesOf(node.reviewRequests).flatMap((request) => {
      const login = request.requestedReviewer?.login;
      return typeof login === "string" ? [login] : [];
    }),
    reviews: nodesOf(node.reviews).map((review) => ({ author: authorLogin(review.author), commitOid: review.commit?.oid ?? null })),
    threads: nodesOf(node.reviewThreads).map((thread) => {
      const first = nodesOf(thread.comments)[0];
      const author = first?.author;
      return { resolved: thread.isResolved, byBot: author?.__typename === "Bot", author: authorLogin(author) };
    }),
    checks: nodesOf(contexts).map(checkState),
    copilotRequestedAt: nodesOf(node.timelineItems)
      .filter((event) => typeof event.createdAt === "string" && isCopilot(event.requestedReviewer?.login ?? null))
      .map((event) => event.createdAt as string),
    truncated:
      [node.labels, node.reviewRequests, node.reviews, node.reviewThreads, contexts, node.timelineItems].some(truncated) ||
      nodesOf(node.reviewThreads).some((thread) => truncated(thread.comments)) ||
      // The rollup read must be the head's: checks on any other commit say
      // nothing about whether the head is settled.
      (head?.oid !== undefined && head.oid !== node.headRefOid),
  };
}

// A check run is green when it succeeded, or was neutral or skipped; a
// status only when it succeeded. Any other value, an unknown one included,
// counts as red. A status that's pending or expected hasn't completed, and
// neither has a context of a type the query didn't ask for.
function checkState(context: CheckContext): CheckState {
  if (context.__typename === "StatusContext") {
    const state = context.state ?? "";
    return {
      name: context.context ?? "",
      completed: state !== "PENDING" && state !== "EXPECTED",
      green: state === "SUCCESS",
      completedAt: context.createdAt ?? null,
    };
  }
  return {
    name: context.name ?? "",
    completed: context.status === "COMPLETED",
    green: ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion ?? ""),
    completedAt: context.completedAt ?? null,
  };
}

// Whether `login` is Copilot's code-review account. GitHub names it
// differently across REST, GraphQL and review requests ("Copilot",
// "copilot-pull-request-reviewer" and "...[bot]"), so every form is accepted.
// lib/follow-up.mts re-exports it, and the sweep decides with it.
export function isCopilot(login: string | null): boolean {
  const name = login?.toLowerCase().replace(/\[bot\]$/, "");
  return name === "copilot-pull-request-reviewer" || name === "copilot";
}

// Asks Copilot to review a PR again (lib/follow-up.mts#decide), once CI has
// been done for a while with no review of the head and no pending request.
// union: true adds Copilot to the PR's reviewers rather than replacing them.
export function requestCopilotReview(pullRequestId: string, run: typeof execFileSync = execFileSync): void {
  const mutation =
    "mutation($pullRequestId: ID!) { requestReviewsByLogin(input: { pullRequestId: $pullRequestId, " +
    `botLogins: [${JSON.stringify(COPILOT_REVIEWER)}], union: true }) { clientMutationId } }`;
  ghWithStderr(run, ["api", "graphql", "-f", `query=${mutation}`, "-f", `pullRequestId=${pullRequestId}`]);
}

// Updates a PR's branch from its base on GitHub's server
// (lib/follow-up.mts#decide), for a settled PR whose only problem is being
// behind main. expected_head_sha makes GitHub refuse (422) when the head
// moved since the sweep read it, rather than merge into a head it never
// judged.
export function updatePullRequestBranch(
  number: number,
  expectedHeadSha: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  ghWithStderr(run, ["api", "--method", "PUT", `repos/${repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${expectedHeadSha}`]);
}

// One comment in a review thread, first comment first (lib/github.mts#reviewThreadsOf).
// byBot: whether its author.__typename is "Bot".
export type ThreadComment = { author: string | null; byBot: boolean; body: string; url: string };

// One review thread on a pull request (lib/follow-up-pass.mts#threadsForRole),
// with its comments, first comment first.
export type ReviewThread = {
  id: string;
  resolved: boolean;
  outdated: boolean;
  path: string | null;
  line: number | null;
  comments: ThreadComment[];
};

// The PR's head and every open-or-not review thread
// (lib/follow-up-pass.mts#runPass), through one GraphQL query. Throws when
// any nested list (threads or a thread's comments) is truncated, or the
// answer names no such PR, so a pass never decides from partial information
// (#78, fail closed as lib/github.mts#bodyEdits already does for issues).
export function reviewThreadsOf(
  number: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): { headRefOid: string; threads: ReviewThread[] } {
  const [owner, name] = repo.split("/") as [string, string];
  const page = JSON.parse(
    ghWithStderr(run, [
      "api", "graphql", "-f", `query=${REVIEW_THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
    ]),
  ) as { data?: { repository?: { pullRequest?: ReviewThreadsNode | null } } };
  const pr = page.data?.repository?.pullRequest;
  if (!pr || typeof pr.headRefOid !== "string" || !pr.reviewThreads?.nodes) {
    throw new Error(`gh api graphql answered no such pull request #${number}: ${JSON.stringify(page)}`);
  }
  if (truncated(pr.reviewThreads) || nodesOf(pr.reviewThreads).some((thread) => truncated(thread.comments))) {
    throw new Error(`Pull request #${number}'s review threads are truncated, so they can't be read in full`);
  }
  return {
    headRefOid: pr.headRefOid,
    threads: nodesOf(pr.reviewThreads).map((thread) => ({
      id: thread.id,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      path: thread.path ?? null,
      line: thread.line ?? null,
      comments: nodesOf(thread.comments).map((comment) => ({
        author: authorLogin(comment.author),
        byBot: comment.author?.__typename === "Bot",
        body: comment.body ?? "",
        url: comment.url ?? "",
      })),
    })),
  };
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line
          comments(first: 100) { pageInfo { hasNextPage } nodes { author { __typename login } body url } }
        }
      }
    }
  }
}`;

type ReviewThreadsNode = {
  headRefOid?: string;
  reviewThreads: Connection<{
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path?: string | null;
    line?: number | null;
    comments: Connection<{ author?: { __typename?: string; login?: string } | null; body?: string; url?: string }>;
  }>;
};

// One check on a PR's head as a follow-up pass reads it (#79): its
// CheckState, and the id of the GitHub Actions run behind it, which is what
// `gh run rerun` and `gh run view` take. A status, or a check run another
// app made (such as code scanning's own "CodeQL" result), has none.
export type HeadCheck = CheckState & { runId: number | undefined };

const HEAD_CHECKS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion completedAt checkSuite { workflowRun { databaseId } } }
                  ... on StatusContext { context state createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

// The checks on PR `number`'s head, read fresh for a follow-up pass
// (lib/follow-up-pass.mts#PassHost.checks), normalised as the sweep's are.
// Throws, rather than deciding from part of them, when the list is
// truncated, the answer names no such PR, or the checks read are on a commit
// other than its head.
export function headChecksOf(
  number: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): { headRefOid: string; checks: HeadCheck[] } {
  const [owner, name] = repo.split("/") as [string, string];
  const page = JSON.parse(
    ghWithStderr(run, [
      "api", "graphql", "-f", `query=${HEAD_CHECKS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
    ]),
  ) as {
    data?: {
      repository?: {
        pullRequest?: {
          headRefOid?: string;
          commits?: Connection<{ commit: { oid?: string; statusCheckRollup: { contexts: Connection<CheckContext> } | null } | null }>;
        } | null;
      };
    };
  };
  const pr = page.data?.repository?.pullRequest;
  if (!pr || typeof pr.headRefOid !== "string") {
    throw new Error(`gh api graphql answered no such pull request #${number}: ${JSON.stringify(page)}`);
  }
  const head = nodesOf(pr.commits)[0]?.commit;
  if (head?.oid !== pr.headRefOid) throw new Error(`Pull request #${number}'s checks weren't read from its head ${pr.headRefOid}`);
  const contexts = head.statusCheckRollup?.contexts;
  if (truncated(contexts)) throw new Error(`Pull request #${number}'s checks are truncated, so they can't be read in full`);
  return {
    headRefOid: pr.headRefOid,
    checks: nodesOf(contexts).map((context) => ({ ...checkState(context), runId: context.checkSuite?.workflowRun?.databaseId })),
  };
}

// The head checks named in `names`, each with the Actions run behind it. Reads
// the checks afresh and refuses when the head has moved past `expectedHead`
// (the commit a follow-up pass gated), rather than re-run or forward a check
// read from a commit the pass never judged (#79).
function namedRuns(
  number: number,
  names: readonly string[],
  expectedHead: string,
  run: typeof execFileSync,
  repo: string,
): { checks: HeadCheck[]; runIds: number[] } {
  const { headRefOid, checks: allChecks } = headChecksOf(number, run, repo);
  if (headRefOid !== expectedHead) {
    throw new Error(`Pull request #${number}'s head moved to ${headRefOid}, so its checks aren't the ones gated at ${expectedHead}`);
  }
  // A head can carry a name in `names` from more than one Actions run, for
  // example a workflow triggered by both `push` and `pull_request`: one run
  // green, one red. Keeping only the failed ones here stops a caller from
  // re-running, or reading the failed-job log of, a run that already passed
  // (#259).
  const checks = allChecks.filter((check) => names.includes(check.name) && check.completed && !check.green);
  const runIds = [...new Set(checks.flatMap((check) => (check.runId === undefined ? [] : [check.runId])))];
  return { checks, runIds };
}

// The check without its run id, as PassHost hands it back.
function stateOf({ runId: _runId, ...state }: HeadCheck): CheckState {
  return state;
}

// lib/follow-up-pass.mts#PassHost.rerunFailedChecks: re-runs, once, the
// failed jobs of each Actions run behind the checks in `names`
// (`gh run rerun --failed`), and reports those checks as running. It doesn't
// wait for the re-run: a pass holds its issue's building label while it
// runs, and the sweep already waits for running checks. So "once" is told
// from the run itself, not remembered: a run on a later attempt has been
// re-run already, by a pass or a person, and its checks are reported as they
// stand, so one still red there hands the PR back. Throws for a named check
// with no Actions run, which can't be re-run, or when the head has moved past
// `expectedHead` since the pass gated it (#79).
export function rerunFailedChecksOnce(
  number: number,
  names: readonly string[],
  expectedHead: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): CheckState[] {
  const { checks, runIds } = namedRuns(number, names, expectedHead, run, repo);
  const runless = checks.filter((check) => check.runId === undefined).map((check) => check.name);
  if (runless.length > 0) throw new Error(`No GitHub Actions run is behind ${runless.join(", ")}, so it can't be re-run`);
  const states: CheckState[] = [];
  for (const runId of runIds) {
    const ofRun = checks.filter((check) => check.runId === runId);
    const attempt = Number(ghWithStderr(run, ["api", `repos/${repo}/actions/runs/${runId}`, "--jq", ".run_attempt"]).trim());
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`gh api gave run ${runId} no attempt number`);
    if (attempt > 1) {
      states.push(...ofRun.map(stateOf));
      continue;
    }
    ghWithStderr(run, ["run", "rerun", String(runId), "--failed", "--repo", repo]);
    states.push(...ofRun.map((check) => ({ ...stateOf(check), completed: false, green: false, completedAt: null })));
  }
  return states;
}

// How much of a `gh run view --log-failed` answer failedCheckLogs reads: a
// failed CodeQL job's log can run to megabytes, past execFileSync's default
// buffer, and the caller keeps only its end.
const FAILED_LOG_BUFFER = 256 * 1024 * 1024;

// lib/follow-up-pass.mts#PassHost.failedCheckLog: `gh run view --log-failed`
// for each Actions run behind the checks in `names`, read once per run under
// a header naming its checks. A check with no Actions run gets a line saying
// so rather than failing the pass: the follow-up role can still fix the rest.
// Throws when the head has moved past `expectedHead` since the pass gated it
// (#79), rather than quote a log for a commit the pass never judged. `limit`,
// when given, keeps each run's own section to an even share of it (the end,
// where its error is) rather than cutting the joined text as a whole: two
// runs' logs otherwise compete for the same budget, and the later one in the
// join can crowd the earlier one out of it entirely (#79).
export function failedCheckLogs(
  number: number,
  names: readonly string[],
  expectedHead: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  limit: number = Number.POSITIVE_INFINITY,
): string {
  const { checks, runIds } = namedRuns(number, names, expectedHead, run, repo);
  const perRun = limit / Math.max(1, runIds.length);
  const sections = runIds.map((runId) => {
    const ofRun = checks.filter((check) => check.runId === runId).map((check) => check.name);
    const log = ghWithStderr(run, ["run", "view", String(runId), "--log-failed", "--repo", repo], undefined, FAILED_LOG_BUFFER);
    return `=== ${ofRun.join(", ")} (run ${runId}) ===\n${endOf(log.trim(), perRun)}`;
  });
  const runless = names.filter((name) => !checks.some((check) => check.name === name && check.runId !== undefined));
  if (runless.length > 0) sections.push(`=== ${runless.join(", ")} ===\nThere's no GitHub Actions log for this check.`);
  return sections.join("\n\n");
}

// Replies to a review thread (lib/follow-up-pass.mts#runPass), through
// addPullRequestReviewThreadReply. The body travels as a GraphQL variable in
// a JSON request on stdin, never interpolated into the query or put on the
// command line: it carries the role's reasoning, unchecked model text.
export function replyToReviewThread(threadId: string, body: string, run: typeof execFileSync = execFileSync): void {
  const mutation =
    "mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: " +
    "{ pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }";
  ghWithStderr(run, ["api", "graphql", "--input", "-"], JSON.stringify({ query: mutation, variables: { threadId, body } }));
}

// Resolves a review thread (lib/follow-up-pass.mts#runPass), through
// resolveReviewThread. GitHub's mutation takes only the thread id: there's no
// ADDRESSED/WONT_FIX/INVALID argument, so that resolution travels in the
// reply and the pass summary instead (#78).
export function resolveReviewThread(threadId: string, run: typeof execFileSync = execFileSync): void {
  const mutation = "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }";
  ghWithStderr(run, ["api", "graphql", "-f", `query=${mutation}`, "-f", `threadId=${threadId}`]);
}

// Posts the follow-up pass's summary comment on a pull request
// (lib/follow-up-pass.mts#runPass#passSummaryComment), through gh pr comment,
// with the body on stdin.
export function commentOnPullRequest(
  number: number,
  body: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  ghWithStderr(run, ["pr", "comment", String(number), "--repo", repo, "--body-file", "-"], body);
}

// The paths an open PR changes.
export function pullRequestFiles(pr: number): string[] {
  return JSON.parse(
    sh(process.cwd(), "gh", "pr", "view", String(pr), "--repo", repoName(), "--json", "files", "--jq", "[.files[].path]"),
  ) as string[];
}

// Any issue's body, or "" when it has none.
export function issueBody(number: number): string {
  return sh(process.cwd(), "gh", "api", `repos/${repoName()}/issues/${number}`, "--jq", '.body // ""');
}

// Add the native "#issue blocked by #blocker" link. The API names the blocker
// by its id, not its number.
export function addBlockedBy(issue: number, blocker: number): void {
  const id = sh(process.cwd(), "gh", "api", `repos/${repoName()}/issues/${blocker}`, "--jq", ".id");
  sh(
    process.cwd(), "gh", "api", "--method", "POST", `repos/${repoName()}/issues/${issue}/dependencies/blocked_by`,
    "-F", `issue_id=${id}`,
  );
}

// The numbers of `issue`'s native "blocked by" links to issues in this
// repository. GitHub allows a link to another repository's issue, whose
// number means nothing here, so those are left out. Used to hand a split
// issue's blockers to its first child (see lib/intake.mts#applySplit).
export function sameRepoBlockers(
  issue: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): number[] {
  const blockers = jsonLines(
    ghWithStderr(run, [
      "api", "--paginate", `repos/${repo}/issues/${issue}/dependencies/blocked_by`,
      "--jq", ".[] | {number, repository_url} | @json",
    ]),
  ) as { number: number; repository_url: string }[];
  return blockers.filter((blocker) => blocker.repository_url.endsWith(`/repos/${repo}`)).map((blocker) => blocker.number);
}

// Creates an issue with `labels` already applied, for the child issues a
// split verdict drafts (see lib/intake.mts#applyVerdicts). Returns its
// number.
export function createIssue(
  title: string,
  body: string,
  labels: readonly string[],
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): number {
  // The REST API takes the body as JSON on stdin and answers the number
  // directly, where gh issue create prints a URL to parse.
  const number = Number(
    ghWithStderr(
      run,
      ["api", "--method", "POST", `repos/${repo}/issues`, "--input", "-", "--jq", ".number"],
      JSON.stringify({ title, body, labels }),
    ).trim(),
  );
  if (!Number.isInteger(number) || number <= 0) throw new Error(`gh api didn't answer the new issue's number for "${title}"`);
  return number;
}

// Adds the native "parent has sub-issue child" relationship GitHub shows as a
// task list on the parent. Used to add each split child as a sub-issue of the
// original issue it was drafted from (see lib/intake.mts#applyVerdicts).
export function addSubIssue(
  parent: number,
  child: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  // As with addBlockedBy, the API names the sub-issue by its id, not its
  // number.
  const id = ghWithStderr(run, ["api", `repos/${repo}/issues/${child}`, "--jq", ".id"]).trim();
  ghWithStderr(run, ["api", "--method", "POST", `repos/${repo}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${id}`]);
}

// The state of one of an issue's native sub-issues (see addSubIssue): enough
// to tell whether it closed as completed (see lib/umbrella.mts).
export type SubIssue = { number: number; state: string; state_reason: string | null };

// The parent issue's sub-issues, in the order GitHub lists them.
export function subIssuesOf(
  parent: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): SubIssue[] {
  return jsonLines(
    ghWithStderr(run, [
      "api", "--paginate", `repos/${repo}/issues/${parent}/sub_issues`,
      "--jq", ".[] | {number, state, state_reason} | @json",
    ]),
  ) as SubIssue[];
}

// Closes an issue as completed: an umbrella whose children have all finished
// (see lib/umbrella.mts#closeFinishedUmbrellas).
export function closeIssueAsCompleted(
  number: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  ghWithStderr(run, ["issue", "close", String(number), "--repo", repo, "--reason", "completed"]);
}

// The open issues whose comments contain `marker`, found through GitHub's
// search index rather than reading every open issue's comments by hand. An
// umbrella loses Sandcastle, so this, not listSandcastleIssues, is how a
// later round finds it again (see lib/umbrella.mts). Search ignores the
// marker's punctuation, so each match's comments are read to keep only the
// issues where `poster`, the host (see hostLogin), posted the marker itself:
// anyone can comment on a public issue, and a pasted marker mustn't get an
// issue closed. Search lags new comments, so an umbrella can be missed for a
// round or two.
export function openIssuesWithComment(
  marker: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  poster: string = (signedInLogin ??= hostLogin(run)),
): number[] {
  const words = marker.replace(/<!--|-->/g, "").trim();
  const matches = JSON.parse(
    ghWithStderr(run, [
      "issue", "list", "--repo", repo, "--state", "open", "--search", `"${words}" in:comments`, "--limit", "1000",
      "--json", "number", "--jq", "[.[].number]",
    ]),
  ) as number[];
  return matches.filter((number) => {
    const comments = jsonLines(
      ghWithStderr(run, ["api", "--paginate", `repos/${repo}/issues/${number}/comments`, "--jq", ".[] | {body, author: .user.login} | @json"]),
    ) as { body: string; author: string }[];
    return comments.some((comment) => comment.author === poster && comment.body.includes(marker));
  });
}

export function commentOnIssue(
  issue: number,
  body: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  run("gh", ["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    input: body,
  });
}

// Creates any of `labels` this repository doesn't already have, with its
// colour and description. Run once at the host's startup, before the first
// round, so a fresh repository (or one whose labels were deleted) always has
// them (see docs/plans/sandcastle-workflow.md, "Labels").
export function ensureLabels(
  labels: readonly SandcastleLabel[] = SANDCASTLE_LABELS,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  const existing = new Set(
    (JSON.parse(ghWithStderr(run, ["label", "list", "--repo", repo, "--limit", "1000", "--json", "name", "--jq", "[.[].name]"])) as string[])
      // GitHub matches label names case-insensitively, so creating one that
      // differs only in case would fail.
      .map((name) => name.toLowerCase()),
  );
  for (const label of labels) {
    if (existing.has(label.name.toLowerCase())) continue;
    try {
      ghWithStderr(run, ["label", "create", label.name, "--repo", repo, "--color", label.color, "--description", label.description]);
    } catch (error) {
      // Another run starting at the same time created it first. --force would
      // also cover this, but would overwrite a colour or description a person
      // changed.
      if (!String(error).includes("already exists")) throw error;
    }
  }
}

// Adds `label` to the issue `number`, or every label in it, in one edit so
// they land together or not at all. The repository must already have them
// (see ensureLabels).
export function addIssueLabel(
  number: number,
  label: string | readonly string[],
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  const labels = typeof label === "string" ? [label] : label;
  ghWithStderr(run, ["issue", "edit", String(number), "--repo", repo, ...labels.flatMap((name) => ["--add-label", name])]);
}

// Removes `label` from the issue `number`.
export function removeIssueLabel(
  number: number,
  label: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  ghWithStderr(run, ["issue", "edit", String(number), "--repo", repo, "--remove-label", label]);
}

// Adds `label` to the pull request `number`: gh issue edit refuses a PR
// number, so restoring a PR-level hand-back label someone other than the
// repository owner removed (lib/follow-up.mts#sweepPullRequests, #146) needs
// its own gh pr edit call.
export function addPullRequestLabel(
  number: number,
  label: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): void {
  ghWithStderr(run, ["pr", "edit", String(number), "--repo", repo, "--add-label", label]);
}

// The names of the labels the issue `number` carries now, read fresh rather
// than from the round's listSandcastleIssues snapshot.
export function issueLabels(
  number: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): string[] {
  return JSON.parse(
    ghWithStderr(run, ["issue", "view", String(number), "--repo", repo, "--json", "labels", "--jq", "[.labels[].name]"]),
  ) as string[];
}

// The numbers of the open issues carrying `label`. As with
// listSandcastleIssues, the cap sits far above any real queue.
export function issuesWithLabel(
  label: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): number[] {
  return JSON.parse(
    ghWithStderr(run, [
      "issue", "list", "--repo", repo, "--state", "open", "--label", label, "--limit", "1000", "--json", "number", "--jq", "[.[].number]",
    ]),
  ) as number[];
}

// One "labeled" or "unlabeled" event from an issue's or PR's REST timeline.
export type TimelineLabelEvent = { event: "labeled" | "unlabeled"; label: string; createdAt: string };

// gh output printed as one line of JSON per item (@json), parsed item by item.
// The pages --paginate fetches concatenate into lines, so they parse alike.
function jsonLines(output: string): unknown[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

// Every "labeled" and "unlabeled" event on the issue or PR `number`, oldest
// first. PRs share the issues API, so this covers both.
export function labelTimeline(
  number: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): TimelineLabelEvent[] {
  return jsonLines(
    ghWithStderr(run, [
      "api", "--paginate", `repos/${repo}/issues/${number}/timeline`,
      "--jq", '.[] | select(.event == "labeled" or .event == "unlabeled") | {event, label: .label.name, createdAt: .created_at} | @json',
    ]),
  ) as TimelineLabelEvent[];
}

// One "labeled", "unlabeled" or "renamed" event from an issue's or PR's REST
// events list (PRs share it). Unlike labelTimeline, this names who made it:
// lib/queue.mts#approval and #labelOriginFixes need that to tell the
// repository owner's own labelling from anyone else's (#146). `actor` is
// null for a deleted account; `label` is null on a renamed event, which
// carries no label.
export type IssueEvent = { event: "labeled" | "unlabeled" | "renamed"; actor: string | null; label: string | null; createdAt: string };

// Every labeled, unlabeled and renamed event on the issue or PR `number`,
// oldest first (GET repos/{owner}/{repo}/issues/{n}/events, --paginate).
export function issueEvents(
  number: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): IssueEvent[] {
  return jsonLines(
    ghWithStderr(run, [
      "api", "--paginate", `repos/${repo}/issues/${number}/events`,
      "--jq",
      '.[] | select(.event == "labeled" or .event == "unlabeled" or .event == "renamed")' +
        " | {event, actor: .actor.login, label: .label.name, createdAt: .created_at} | @json",
    ]),
  ).map((event) => {
    if (!isIssueEvent(event)) throw new Error(`unexpected event on #${number}: ${JSON.stringify(event)}`);
    return event;
  });
}

// An event approval and labelOriginFixes can trust the shape of: one that
// doesn't fit is thrown on rather than read as nobody's.
function isIssueEvent(value: unknown): value is IssueEvent {
  const event = value as Partial<Record<keyof IssueEvent, unknown>> | null;
  return (
    typeof event === "object" && event !== null &&
    (event.event === "labeled" || event.event === "unlabeled" || event.event === "renamed") &&
    (typeof event.actor === "string" || event.actor === null) &&
    (typeof event.label === "string" || event.label === null) &&
    typeof event.createdAt === "string"
  );
}

// One edit to an issue's or PR's body, from GraphQL issue.userContentEdits.
// `editor` is null for a deleted account. The oldest entry is the body's
// creation, dated before any label, so lib/queue.mts#approval's ">="
// comparison never mistakes it for an edit made after the owner queued the
// issue.
export type ContentEdit = { editor: string | null; editedAt: string };

// Every edit to the issue `number`'s body, every page (GraphQL
// issue.userContentEdits, --paginate with $endCursor), in GitHub's order:
// lib/queue.mts#approval compares each edit's time, not its position. Throws
// when the answer names no such issue, or any edit doesn't fit ContentEdit.
export function bodyEdits(
  number: number,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
): ContentEdit[] {
  const [owner, name] = repo.split("/") as [string, string];
  return jsonLines(
    ghWithStderr(run, [
      "api", "graphql", "--paginate", "-f", `query=${BODY_EDITS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`,
      "-F", `number=${number}`,
      // A missing issue prints null, which the check below throws on, rather
      // than nothing, which would read as an issue nobody has edited.
      "--jq",
      ".data.repository.issue | if . == null then null | @json" +
        " else .userContentEdits.nodes[] | {editor: .editor.login, editedAt} | @json end",
    ]),
  ).map((edit) => {
    if (!isContentEdit(edit)) throw new Error(`GitHub's answer names no issue ${number}'s body edits: ${JSON.stringify(edit)}`);
    return edit;
  });
}

const BODY_EDITS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      userContentEdits(first: 100, after: $endCursor) {
        nodes { editedAt editor { login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function isContentEdit(value: unknown): value is ContentEdit {
  const edit = value as Partial<Record<keyof ContentEdit, unknown>> | null;
  return (
    typeof edit === "object" && edit !== null &&
    (typeof edit.editor === "string" || edit.editor === null) &&
    typeof edit.editedAt === "string"
  );
}

// One comment, with when it was posted, so markerCommentsSince can tell
// which side of a label's removal it falls on, and who posted it.
export type TimestampedComment = { body: string; createdAt: string; author: string };

// The comments in `comments` that `poster` posted and that carry `marker`,
// posted after `label` was last removed from this issue or PR (its most
// recent "unlabeled" event naming `label` in `timeline`), or since
// `createdAt` when `label` was never removed. Counting from the timeline rather than a running counter means the
// count survives a restart, and a human re-queueing by removing the label
// resets it (see docs/plans/sandcastle-workflow.md, "Giving up and telling
// the human").
export function markerCommentsSince(
  comments: readonly TimestampedComment[],
  timeline: readonly TimelineLabelEvent[],
  label: string,
  marker: string,
  createdAt: string,
  poster: string,
): TimestampedComment[] {
  const since = Math.max(
    timestamp(createdAt),
    ...timeline.filter((event) => event.event === "unlabeled" && event.label === label).map((event) => timestamp(event.createdAt)),
  );
  return comments.filter(
    (comment) => comment.author === poster && comment.body.includes(marker) && timestamp(comment.createdAt) >= since,
  );
}

// An ISO 8601 time as milliseconds. Throws on one that doesn't parse rather
// than let NaN quietly drop or keep a comment from the count, or decide
// whether a label is stale (lib/building.mts).
export function timestamp(time: string): number {
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) throw new Error(`GitHub returned a time that doesn't parse: ${JSON.stringify(time)}`);
  return ms;
}

// The login gh is signed in as: the account every host comment is posted
// from. Not the repository owner, which is an organization for a repository
// an organization owns, and never posts a comment itself.
export function hostLogin(run: typeof execFileSync = execFileSync): string {
  return ghWithStderr(run, ["api", "user", "--jq", ".login"]).trim();
}

let signedInLogin: string | undefined;

// Reads the host's login (see hostLogin) and keeps it for markerComments.
// Called once at startup, so a token that can't read /user fails the run
// before any role runs, rather than when the first failed attempt is recorded.
export function cacheHostLogin(run: typeof execFileSync = execFileSync): string {
  signedInLogin = hostLogin(run);
  return signedInLogin;
}

// The host's own login (see hostLogin), cached the same way markerComments and
// openIssuesWithComment already do, for the follow-up sweep
// (lib/follow-up.mts), which needs it outside any single GitHub read: "the
// repository owner opened it" means this login authored the PR (#77, #214).
export function signedInHostLogin(run: typeof execFileSync = execFileSync): string {
  if (sweepLogin?.run !== run) sweepLogin = { run, login: hostLogin(run) };
  return sweepLogin.login;
}

// signedInHostLogin's cache, kept with the runner that read it, so a caller
// passing a different gh (a test's stub) never gets another runner's login.
let sweepLogin: { run: typeof execFileSync; login: string } | undefined;

// The comments on the issue or PR `number` that carry `marker` and were posted
// since `label` was last removed (see markerCommentsSince). Only the host's own
// comments count (see hostLogin): anyone can comment on a public issue, so a
// stranger could otherwise paste the marker in to hand the issue back early.
// PRs share the issues API, so this covers both.
export function markerComments(
  number: number,
  label: string,
  marker: string,
  repo: string = repoName(),
  run: typeof execFileSync = execFileSync,
  poster: string = (signedInLogin ??= hostLogin(run)),
): TimestampedComment[] {
  const comments = jsonLines(
    ghWithStderr(run, [
      "api", "--paginate", `repos/${repo}/issues/${number}/comments`,
      "--jq", ".[] | {body, createdAt: .created_at, author: .user.login} | @json",
    ]),
  ) as TimestampedComment[];
  const timeline = labelTimeline(number, run, repo);
  const createdAt = ghWithStderr(run, ["api", `repos/${repo}/issues/${number}`, "--jq", ".created_at"]).trim();
  return markerCommentsSince(comments, timeline, label, marker, createdAt, poster);
}

// A label only the host or a human applies to hand work back: the issue's or
// PR's text, or Sandcastle's own effort, is the problem.
export type HandBackLabel = "sandcastle:needs-info" | "sandcastle:needs-human";

export type HandBackTarget = { kind: "issue" | "pr"; number: number };

// Hands `target` back to a human: adds `label`, with one comment carrying
// `body`, and records the hand-back in `report` (see lib/report.mts) under
// `reason`, for the run's final summary. An issue-level
// `sandcastle:needs-human` also removes `sandcastle:ready`, so a re-queue
// re-runs intake on the current text before the build starts again; a
// PR-level one leaves `sandcastle:ready` alone (see "Giving up and telling
// the human").
export function handBack(
  target: HandBackTarget,
  label: HandBackLabel,
  reason: string,
  body: string,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  report: HandBackReport = handBackReport,
): void {
  const number = String(target.number);
  const removeReady = target.kind === "issue" && label === "sandcastle:needs-human" ? ["--remove-label", "sandcastle:ready"] : [];
  // The comment goes first: if GitHub rejects it, the labels are untouched and
  // the work stays in the queue, rather than leaving it with no explanation.
  ghWithStderr(run, [target.kind, "comment", number, "--repo", repo, "--body-file", "-"], body);
  ghWithStderr(run, [target.kind, "edit", number, "--repo", repo, "--add-label", label, ...removeReady]);
  report.record({ kind: target.kind, number: target.number, label, reason, url: targetUrl(repo, target) });
}

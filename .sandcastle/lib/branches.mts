// Branch naming and fetching. Branch names come from code, never from a model,
// so re-planning an issue always lands on the branch that holds its earlier work.

import type { SandcastleIssue } from "./github.mts";
import { BASE_BRANCH } from "./config.mts";
import { git } from "./shell.mts";

const maxSlugLength = 50;

// The branch prefixes that name an issue, per docs/PROCESS.md: feature/ for new
// behaviour, fix/ for a bug fix and hotfix/ for an urgent fix.
const issuePrefixes = ["feature", "fix", "hotfix"] as const;

// The parts of an issue its branch name depends on.
type BranchIssue = Pick<SandcastleIssue, "number" | "title" | "labels">;

// The issue title as a branch slug: no conventional-commit prefix, lower case,
// apostrophes dropped so "haven't" stays one word, and runs of ASCII letters
// and digits joined with "-", cut to 50 characters at a "-" boundary.
export function slugFor(title: string): string {
  const words = title
    .replace(/^\s*[a-z]+(?:\([^)]*\))?!?:\s*/i, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .match(/[a-z0-9]+/g) ?? [];
  const slug = words.join("-");
  if (slug.length === 0) return "issue";
  if (slug.length <= maxSlugLength) return slug;

  const cut = slug.slice(0, maxSlugLength + 1);
  const boundary = cut.lastIndexOf("-");
  return boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, maxSlugLength);
}

// Whether a branch is the issue's: feature/{n}-{slug}, fix/{n}-{slug} or
// hotfix/{n}-{slug}, with a slug scripts/check-branch-name.sh accepts. Only such
// a name is reused or counted as the issue's PR: a branch name reaches a shell,
// since review-prompt.md passes {{BRANCH}} to the `git diff` it runs in the
// sandbox, and anyone with push access could name a branch `fix/4-$(...)`.
export function isIssueBranch(branch: string, issueNumber: number): boolean {
  return new RegExp(`^(?:${issuePrefixes.join("|")})/${issueNumber}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(branch);
}

// The issue's branch: its existing feature/, fix/ or hotfix/{n}-{slug} branch on the
// remote when there is one, even if the title or labels have changed since, so
// earlier work is built on rather than redone. Otherwise fix/{n}-{slug} for a
// bug and feature/{n}-{slug} for everything else. No label marks a fix as
// urgent, so Sandcastle never names a hotfix/ branch itself.
export function branchFor(issue: BranchIssue, remoteBranches: readonly string[]): string {
  const existing = remoteBranches
    .filter((branch) => isIssueBranch(branch, issue.number))
    .sort()[0];
  if (existing) return existing;

  const prefix = issue.labels.includes("bug") ? "fix" : "feature";
  return `${prefix}/${issue.number}-${slugFor(issue.title)}`;
}

// Branch names from `git ls-remote --heads` output, without refs/heads/.
export function parseHeads(lsRemote: string): string[] {
  return lsRemote
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]!.replace(/^refs\/heads\//, ""));
}

// The remote git operations prepareBranches needs; tests pass a stub.
export type RemoteGit = {
  // The feature/*, fix/* and hotfix/* branches on origin.
  issueBranches(): string[];
  // Fetch origin's branch into its remote-tracking ref.
  fetch(branch: string): void;
};

// The live RemoteGit, which lib/follow-up-pass.mts's pass phase fetches a
// PR's branch through too.
export const originGit: RemoteGit = {
  issueBranches: () =>
    parseHeads(git("ls-remote", "--heads", "origin", ...issuePrefixes.map((prefix) => `refs/heads/${prefix}/*`))),
  fetch: (branch) => {
    git("fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  },
};

// Count the commits on the issue branch that `base` (fetchMain's commit)
// doesn't have. Counted by ref in the main checkout, never in the branch's
// worktree (see lib/host-safety.mts).
export function commitsAhead(branch: string, base: string): number {
  return Number(git("rev-list", "--count", `${base}..refs/heads/${branch}`));
}

// Refresh BASE_BRANCH (origin/main) and return the commit it now names, read by
// its full ref name, so a planted refs/heads/origin/main or tag can't stand in. Called
// once per round, before the pipelines start, because concurrent fetches from
// each pipeline would contend on the same ref lock. The host works from the
// returned commit, not the ref: the ref is in the shared .git, which agents can
// write.
//
// A shallow checkout (actions/checkout's default depth of 1 in the workflow) is
// unshallowed here. Shallow, git can't see that a branch's older history is in
// main, so `<this commit>..<branch>` lists everything the branch reaches past
// the cut: the secret scan then read main's whole history as a PR's own, and a
// fake token in a test on main handed a follow-up pass back (#372). git refuses
// --unshallow in a full clone, so it's only passed to a shallow one.
export function fetchMain(run: (...args: string[]) => string = git): string {
  const shallow = run("rev-parse", "--is-shallow-repository") === "true";
  run("fetch", "--quiet", ...(shallow ? ["--unshallow"] : []), "origin", "+refs/heads/main:refs/remotes/origin/main");
  return run("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
}

// The git operations discardClosedWork needs; tests pass a stub.
export type BranchRefs = {
  // git ls-remote origin refs/heads/<branch>; undefined when origin has no such branch.
  remoteHead(branch: string): string | undefined;
  // git rev-parse --verify --quiet <ref>^{commit}; undefined when the ref doesn't exist.
  localHead(ref: string): string | undefined;
  // git merge-base --is-ancestor; false on exit 1 or a missing object.
  contains(commit: string, ancestor: string): boolean;
  // git cat-file -e <commit>^{commit}; whether the repository has the commit.
  hasCommit(commit: string): boolean;
  // git fetch origin refs/pull/<n>/head, which GitHub keeps after the PR's
  // branch is deleted.
  fetchPullHead(number: number): void;
  // git merge-base; undefined on exit 1, when the two share no commit.
  mergeBase(commit: string, other: string): string | undefined;
  // git branch -D; git refuses when a worktree has the branch checked out.
  deleteLocalBranch(branch: string): void;
  // git update-ref -d.
  deleteRef(ref: string): void;
  // git push --force-with-lease=refs/heads/<b>:<sha> origin :refs/heads/<b>.
  deleteRemote(branch: string, expectedSha: string): void;
};

// A git failure's exit status, read from the execFileSync error runHostGit
// keeps as the cause.
function exitStatus(error: unknown): unknown {
  return ((error as { cause?: { status?: unknown } }).cause ?? {}).status;
}

// The live BranchRefs, whose `contains` lib/follow-up-pass.mts also asks
// whether a PR's head already has main.
export const originRefs: BranchRefs = {
  remoteHead: (branch) => git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] || undefined,
  localHead: (ref) => {
    try {
      return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    } catch (error) {
      // --quiet exits 1 with no output only when the ref doesn't exist; any
      // other failure is rethrown rather than read as a missing ref.
      if (exitStatus(error) === 1) return undefined;
      throw error;
    }
  },
  contains: (commit, ancestor) => {
    try {
      git("merge-base", "--is-ancestor", ancestor, commit);
      return true;
    } catch (error) {
      if (exitStatus(error) === 1) return false;
      // An object this repository doesn't have can't be in any of its refs.
      if (/Not a valid (?:object|commit) name/.test(String(error))) return false;
      throw error;
    }
  },
  hasCommit: (commit) => {
    try {
      git("cat-file", "-e", `${commit}^{commit}`);
      return true;
    } catch {
      return false;
    }
  },
  fetchPullHead: (number) => void git("fetch", "--quiet", "origin", `refs/pull/${number}/head`),
  mergeBase: (commit, other) => {
    try {
      return git("merge-base", commit, other);
    } catch (error) {
      if (exitStatus(error) === 1) return undefined;
      throw error;
    }
  },
  deleteLocalBranch: (branch) => void git("branch", "-D", branch),
  deleteRef: (ref) => void git("update-ref", "-d", ref),
  deleteRemote: (branch, expectedSha) =>
    void git("push", "--quiet", `--force-with-lease=refs/heads/${branch}:${expectedSha}`, "origin", `:refs/heads/${branch}`),
};

// Deletes each ref of `branch` that holds the work of `closed`, an issue's
// Sandcastle PR that closed without merging, and returns the refs it
// deleted: refs/heads/<branch>, refs/remotes/origin/<branch> and
// origin/<branch>, in that order (lib/follow-up.mts#startFromMain). Leaves
// everything alone when `base` already contains the closed head. A ref holds
// the closed PR's work when it shares a commit with the closed head that
// `base` doesn't have, whether it contains the head, lags behind it (the
// local branch sits where the sandbox pushed, and an update-branch or a
// commit made on GitHub moves the PR past it) or has diverged from it. Any
// other ref is left alone, so a fresh attempt's commits, which start from
// main, survive. The closed head is fetched first when the repository
// doesn't have it (its branch was deleted with the PR), and a head that
// can't be fetched throws: without it, no ref can be told apart. All three
// go because Sandcastle's `git worktree add` checks out a local branch if
// there is one, else DWIMs from origin/<branch>, and starts fresh from main
// only when neither exists. Every call goes through `refs` (live: git(),
// hooks off, main checkout), so a test can stub it.
export function discardClosedWork(
  branch: string,
  closed: { number: number; headRefOid: string },
  base: string,
  refs: BranchRefs = originRefs,
): string[] {
  const closedHead = closed.headRefOid;
  if (!refs.hasCommit(closedHead)) refs.fetchPullHead(closed.number);
  if (!refs.hasCommit(closedHead)) {
    throw new Error(`PR #${closed.number}'s head ${closedHead} isn't in the repository and couldn't be fetched, so its work can't be told from a fresh attempt`);
  }
  if (refs.contains(base, closedHead)) return [];
  const holdsClosedWork = (commit: string): boolean => {
    const shared = refs.mergeBase(commit, closedHead);
    return shared !== undefined && !refs.contains(base, shared);
  };
  const deleted: string[] = [];
  // The local branch goes first: it's the one git can refuse to delete (a
  // worktree still has it checked out), and failing there leaves origin's
  // branch untouched.
  const localRef = `refs/heads/${branch}`;
  const local = refs.localHead(localRef);
  if (local !== undefined && holdsClosedWork(local)) {
    refs.deleteLocalBranch(branch);
    deleted.push(localRef);
  }
  const trackingRef = `refs/remotes/origin/${branch}`;
  const tracking = refs.localHead(trackingRef);
  if (tracking !== undefined && holdsClosedWork(tracking)) {
    refs.deleteRef(trackingRef);
    deleted.push(trackingRef);
  }
  const remote = refs.remoteHead(branch);
  if (remote !== undefined && holdsClosedWork(remote)) {
    refs.deleteRemote(branch, remote);
    deleted.push(`origin/${branch}`);
  }
  return deleted;
}

// Name each issue's branch, and fetch the ones that already exist on origin
// into their remote-tracking refs so createSandbox() checks them out from
// origin/<branch>. Without the fetch, Sandcastle finds no such branch and
// silently starts a fresh one from main. The fetches run serially, before the
// pipelines start, for the same reason as fetchMain.
export function prepareBranches<T extends BranchIssue>(issues: T[], git: RemoteGit = originGit): { issue: T; branch: string }[] {
  const remoteBranches = git.issueBranches();
  return issues.map((issue) => {
    const branch = branchFor(issue, remoteBranches);
    if (remoteBranches.includes(branch)) git.fetch(branch);
    return { issue, branch };
  });
}

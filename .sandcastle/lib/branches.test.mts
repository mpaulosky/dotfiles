import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { branchFor, discardClosedWork, fetchMain, isIssueBranch, parseHeads, prepareBranches, slugFor, type BranchRefs } from "./branches.mts";

// The branch standard, from the script the pre-push hook and CI's Branch name check share.
const checkBranchName = fileURLToPath(new URL("../../scripts/check-branch-name.sh", import.meta.url));
const passesBranchStandard = (branch: string) => {
  try {
    execFileSync("bash", [checkBranchName, branch], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const issue = (number: number, title: string, labels: string[] = ["Sandcastle"]) => ({ number, title, labels });

describe("slugFor", () => {
  it("drops the conventional-commit prefix, lower-cases and joins words with hyphens", () => {
    assert.equal(
      slugFor("feat(sandcastle): Hold back issues whose blockers haven't landed"),
      "hold-back-issues-whose-blockers-havent-landed",
    );
  });

  it("drops prefixes without a scope or with a breaking-change mark", () => {
    assert.equal(slugFor("fix: Stop the crash"), "stop-the-crash");
    assert.equal(slugFor("refactor(Domain)!: Rename Result"), "rename-result");
  });

  it("drops curly apostrophes too", () => {
    assert.equal(slugFor("Don’t reuse the cache"), "dont-reuse-the-cache");
  });

  it("joins every run of other characters into one hyphen and trims the ends", () => {
    assert.equal(slugFor("  Add  C# / .NET 10 support!  "), "add-c-net-10-support");
  });

  it("cuts a long title to at most 50 characters at a hyphen", () => {
    const slug = slugFor("feat(sandcastle): The host names branches and skips issues that already have a PR");

    assert.equal(slug, "the-host-names-branches-and-skips-issues-that");
    assert.ok(slug.length <= 50);
  });

  it("keeps a title of exactly 50 characters whole", () => {
    const title = "a".repeat(24) + " " + "b".repeat(25);

    assert.equal(slugFor(title), "a".repeat(24) + "-" + "b".repeat(25));
  });

  it("cuts a single word longer than 50 characters at 50", () => {
    assert.equal(slugFor("x".repeat(60)), "x".repeat(50));
  });

  it("falls back to 'issue' when the title has no ASCII letters or digits", () => {
    assert.equal(slugFor("feat: ✨"), "issue");
  });
});

describe("isIssueBranch", () => {
  it("matches the issue's feature, fix and hotfix branches, not another issue's", () => {
    assert.ok(isIssueBranch("feature/4-add-search", 4));
    assert.ok(isIssueBranch("fix/4-stop-the-crash", 4));
    assert.ok(isIssueBranch("hotfix/4-stop-the-crash", 4));
    assert.ok(!isIssueBranch("feature/42-add-search", 4));
    assert.ok(!isIssueBranch("fix/42-stop-the-crash", 4));
    assert.ok(!isIssueBranch("chore/4-add-search", 4));
  });

  it("matches only a name the branch standard allows, since the name reaches a shell in the sandbox", () => {
    for (const branch of [
      "feature/4-",
      "feature/4-Add-Search",
      "feature/4-add--search",
      "feature/4-add-search-",
      "feature/4-add_search",
      "feature/4-$(touch-x)",
      "feature/4-add;rm",
      "feature/4-add`id`",
      "feature/4-add search",
      "feature/4-add-search/more",
      "xfeature/4-add-search",
    ]) {
      assert.ok(!isIssueBranch(branch, 4), branch);
      assert.ok(!passesBranchStandard(branch), branch);
    }
  });
});

describe("branchFor", () => {
  it("names an issue without the bug label feature/{n}-{slug}", () => {
    const branch = branchFor(issue(28, "feat(sandcastle): Hold back issues whose blockers haven't landed"), []);

    assert.equal(branch, "feature/28-hold-back-issues-whose-blockers-havent-landed");
  });

  it("names an issue with the bug label fix/{n}-{slug}", () => {
    const branch = branchFor(issue(7, "fix(ci): Merge PRs again", ["Sandcastle", "bug"]), []);

    assert.equal(branch, "fix/7-merge-prs-again");
  });

  it("reuses the issue's existing remote branch, even under another slug", () => {
    const branch = branchFor(issue(28, "Hold back issues"), ["feature/2-other", "feature/28-other-slug", "fix/280-x", "hotfix/280-y"]);

    assert.equal(branch, "feature/28-other-slug");
  });

  it("reuses an existing fix branch even when the issue has lost its bug label", () => {
    assert.equal(branchFor(issue(9, "Fix it"), ["fix/9-fix-the-thing"]), "fix/9-fix-the-thing");
  });

  it("reuses an existing hotfix branch rather than starting a fix branch", () => {
    assert.equal(branchFor(issue(9, "Fix it", ["bug"]), ["hotfix/9-fix-the-thing"]), "hotfix/9-fix-the-thing");
  });

  it("doesn't reuse a remote branch whose name the branch standard refuses", () => {
    const branch = branchFor(issue(4, "Add search"), ["feature/4-$(touch-x)", "fix/4-Add-Search"]);

    assert.equal(branch, "feature/4-add-search");
  });

  it("ignores remote branches for other issues whose numbers share a prefix", () => {
    assert.equal(branchFor(issue(2, "Add a thing"), ["feature/28-other", "feature/2x-odd"]), "feature/2-add-a-thing");
  });

  it("generates names scripts/check-branch-name.sh accepts", () => {
    const titles = [
      "feat(sandcastle): Hold back issues whose blockers haven't landed",
      "fix: Don’t crash on an empty body!",
      "  Add  C# / .NET 10 support  ",
      "x".repeat(80),
      "feat: ✨",
      "docs(adr)!: Record ADR 0002 — hosted runner, PAT without Workflows",
    ];
    for (const title of titles) {
      for (const labels of [[], ["bug"]]) {
        const branch = branchFor(issue(42, title, labels), []);
        assert.ok(passesBranchStandard(branch), `${JSON.stringify(title)} gave ${branch}, which fails the branch standard`);
      }
    }
  });
});

describe("parseHeads", () => {
  it("reads branch names from git ls-remote --heads output", () => {
    const output = "abc123\trefs/heads/feature/66-split-main\ndef456\trefs/heads/fix/9-fix-it\n";

    assert.deepEqual(parseHeads(output), ["feature/66-split-main", "fix/9-fix-it"]);
  });

  it("returns nothing for empty output", () => {
    assert.deepEqual(parseHeads(""), []);
  });
});

// A BranchRefs stub for discardClosedWork (#77). Each ref's current commit
// (local, tracking, and origin's real branch) and whether it contains
// closedHead are configurable independently, and every call is recorded in
// `calls` so a test can check the order of operations.
function stubRefs(
  branch: string,
  closedHead: string,
  base: string,
  {
    baseContainsClosedHead = false,
    localCommit = "1".repeat(40),
    trackingCommit = "2".repeat(40),
    remoteCommit = "3".repeat(40),
    localExists = true,
    trackingExists = true,
    remoteExists = true,
    localContainsClosedHead = true,
    trackingContainsClosedHead = true,
    remoteContainsClosedHead = true,
    failDeleteLocalBranch,
  }: {
    baseContainsClosedHead?: boolean;
    localCommit?: string;
    trackingCommit?: string;
    remoteCommit?: string;
    localExists?: boolean;
    trackingExists?: boolean;
    remoteExists?: boolean;
    localContainsClosedHead?: boolean;
    trackingContainsClosedHead?: boolean;
    remoteContainsClosedHead?: boolean;
    failDeleteLocalBranch?: Error;
  } = {},
) {
  const localRef = `refs/heads/${branch}`;
  const trackingRef = `refs/remotes/origin/${branch}`;
  const calls: string[] = [];
  const refs: BranchRefs = {
    remoteHead: (b) => {
      calls.push(`remoteHead ${b}`);
      return remoteExists ? remoteCommit : undefined;
    },
    localHead: (ref) => {
      calls.push(`localHead ${ref}`);
      if (ref === localRef) return localExists ? localCommit : undefined;
      if (ref === trackingRef) return trackingExists ? trackingCommit : undefined;
      return undefined;
    },
    contains: (commit, ancestor) => {
      calls.push(`contains ${commit} ${ancestor}`);
      if (ancestor !== closedHead) return false;
      if (commit === base) return baseContainsClosedHead;
      if (commit === localCommit) return localContainsClosedHead;
      if (commit === trackingCommit) return trackingContainsClosedHead;
      if (commit === remoteCommit) return remoteContainsClosedHead;
      return false;
    },
    hasCommit: () => true,
    fetchPullHead: (number) => void calls.push(`fetchPullHead ${number}`),
    // Each flag stands for a ref that contains the closed head, so their
    // merge base is the closed head itself; a ref without it is unrelated.
    mergeBase: (commit, other) => {
      calls.push(`mergeBase ${commit} ${other}`);
      if (other !== closedHead) return undefined;
      if (commit === localCommit) return localContainsClosedHead ? closedHead : undefined;
      if (commit === trackingCommit) return trackingContainsClosedHead ? closedHead : undefined;
      if (commit === remoteCommit) return remoteContainsClosedHead ? closedHead : undefined;
      return undefined;
    },
    deleteLocalBranch: (b) => {
      calls.push(`deleteLocalBranch ${b}`);
      if (failDeleteLocalBranch) throw failDeleteLocalBranch;
    },
    deleteRef: (ref) => void calls.push(`deleteRef ${ref}`),
    deleteRemote: (b, sha) => void calls.push(`deleteRemote ${b} ${sha}`),
  };
  return { refs, calls };
}

describe("discardClosedWork", () => {
  const branch = "feature/42-add-search";
  const closedHead = "c".repeat(40);
  const base = "m".repeat(40);

  it("deletes the local branch, the tracking ref and origin's branch (with the lease SHA), in that order, when each contains the closed head", () => {
    const { refs, calls } = stubRefs(branch, closedHead, base);

    const deleted = discardClosedWork(branch, { number: 10, headRefOid: closedHead }, base, refs);

    assert.deepEqual(calls.filter((call) => call.startsWith("delete")), [
      `deleteLocalBranch ${branch}`,
      `deleteRef refs/remotes/origin/${branch}`,
      `deleteRemote ${branch} ${"3".repeat(40)}`,
    ]);
    assert.deepEqual(deleted, [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`, `origin/${branch}`]);
  });

  it("keeps a local branch that doesn't contain the closed head, because a fresh attempt's commits start from main", () => {
    const { refs, calls } = stubRefs(branch, closedHead, base, { localContainsClosedHead: false });

    const deleted = discardClosedWork(branch, { number: 10, headRefOid: closedHead }, base, refs);

    assert.ok(!calls.some((call) => call.startsWith("deleteLocalBranch")));
    assert.ok(!deleted.includes(`refs/heads/${branch}`));
  });

  it("does nothing when base already contains the closed head", () => {
    const { refs, calls } = stubRefs(branch, closedHead, base, { baseContainsClosedHead: true });

    const deleted = discardClosedWork(branch, { number: 10, headRefOid: closedHead }, base, refs);

    assert.deepEqual(deleted, []);
    assert.ok(!calls.some((call) => call.startsWith("delete")));
  });

  it("rethrows when deleteLocalBranch fails, without deleting origin's branch", () => {
    const failure = new Error("git branch -D failed: worktree in use");
    const { refs, calls } = stubRefs(branch, closedHead, base, { failDeleteLocalBranch: failure });

    assert.throws(() => discardClosedWork(branch, { number: 10, headRefOid: closedHead }, base, refs), /worktree in use/);
    assert.ok(!calls.some((call) => call.startsWith("deleteRemote")));
  });
});

// BranchRefs over a small commit graph: `parents` maps each commit to its
// parents, and contains() and mergeBase() walk it, so a test states the
// history rather than each answer. Every ref exists; deletes are recorded.
// A commit in `missing` isn't in the repository until fetchPullHead fetches
// it, and only when `fetchable` says GitHub still has it.
function graphRefs(
  parents: Record<string, string[]>,
  heads: { local: string; tracking: string; remote: string },
  { missing = [], fetchable = true }: { missing?: string[]; fetchable?: boolean } = {},
) {
  const deletes: string[] = [];
  const fetches: number[] = [];
  const absent = new Set(missing);
  const ancestors = (commit: string): string[] => [commit, ...(parents[commit] ?? []).flatMap(ancestors)];
  const refs: BranchRefs = {
    remoteHead: () => heads.remote,
    localHead: (ref) => (ref.startsWith("refs/heads/") ? heads.local : heads.tracking),
    contains: (commit, ancestor) => !absent.has(ancestor) && ancestors(commit).includes(ancestor),
    hasCommit: (commit) => !absent.has(commit),
    fetchPullHead: (number) => {
      fetches.push(number);
      if (fetchable) absent.clear();
    },
    mergeBase: (commit, other) => {
      const theirs = new Set(ancestors(other));
      return ancestors(commit).find((ancestor) => theirs.has(ancestor));
    },
    deleteLocalBranch: (branch) => void deletes.push(`refs/heads/${branch}`),
    deleteRef: (ref) => void deletes.push(ref),
    deleteRemote: (branch) => void deletes.push(`origin/${branch}`),
  };
  return { refs, deletes, fetches };
}

describe("discardClosedWork over a commit history", () => {
  const branch = "feature/42-add-search";

  // main is M; the sandbox built B on it and pushed; the sweep's
  // update-branch then merged main's newer M2 into the PR on GitHub, giving
  // the closed head U, which the local branch never got.
  const history = { B: ["M"], M2: ["M"], U: ["B", "M2"] };
  const closed = { number: 10, headRefOid: "U" };

  it("deletes a local branch that lags the closed head, so the rebuild doesn't continue the closed PR's work", () => {
    const { refs, deletes } = graphRefs(history, { local: "B", tracking: "U", remote: "U" });

    const deleted = discardClosedWork(branch, closed, "M2", refs);

    assert.deepEqual(deleted, [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`, `origin/${branch}`]);
    assert.deepEqual(deletes, deleted);
  });

  it("keeps a local branch at a commit main already has, since it holds none of the closed PR's work", () => {
    const { refs } = graphRefs(history, { local: "M", tracking: "U", remote: "U" });

    const deleted = discardClosedWork(branch, closed, "M2", refs);

    assert.ok(!deleted.includes(`refs/heads/${branch}`));
  });

  // C was committed on top of the pushed B, but its push failed, while the
  // PR moved on to U on GitHub: neither contains the other.
  it("deletes a local branch that has diverged from the closed head", () => {
    const { refs } = graphRefs({ ...history, C: ["B"] }, { local: "C", tracking: "U", remote: "U" });

    const deleted = discardClosedWork(branch, closed, "M2", refs);

    assert.ok(deleted.includes(`refs/heads/${branch}`));
  });

  // The branch was deleted when the PR closed, so the rebuild's fetch found
  // nothing and this checkout never got U; GitHub keeps refs/pull/<n>/head.
  it("fetches the closed PR's head when the repository doesn't have it, then deletes the work", () => {
    const { refs, fetches } = graphRefs(history, { local: "B", tracking: "B", remote: "B" }, { missing: ["U"] });

    const deleted = discardClosedWork(branch, closed, "M2", refs);

    assert.deepEqual(fetches, [10]);
    assert.ok(deleted.includes(`refs/heads/${branch}`));
  });

  it("throws, deleting nothing, when the closed PR's head can't be fetched", () => {
    const { refs, deletes } = graphRefs(history, { local: "B", tracking: "B", remote: "B" }, { missing: ["U"], fetchable: false });

    assert.throws(() => discardClosedWork(branch, closed, "M2", refs), /PR #10's head U/);
    assert.deepEqual(deletes, []);
  });

  it("keeps a fresh attempt's local branch, which starts from main and isn't related to the closed head", () => {
    const { refs } = graphRefs({ ...history, F: ["M2"] }, { local: "F", tracking: "U", remote: "U" });

    const deleted = discardClosedWork(branch, closed, "M2", refs);

    assert.ok(!deleted.includes(`refs/heads/${branch}`));
  });
});

describe("prepareBranches", () => {
  it("names every issue's branch and fetches only the ones that exist on origin", () => {
    const fetched: string[] = [];
    const git = { issueBranches: () => ["feature/7-old-title"], fetch: (branch: string) => void fetched.push(branch) };

    const work = prepareBranches([issue(7, "feat: New title"), issue(8, "fix: Something", ["bug"])], git);

    assert.deepEqual(work.map((w) => w.branch), ["feature/7-old-title", "fix/8-something"]);
    assert.deepEqual(fetched, ["feature/7-old-title"]);
  });
});

describe("fetchMain", () => {
  // A stub git that answers --is-shallow-repository with `shallow` and
  // records every call.
  function stubGit(shallow: boolean) {
    const calls: string[][] = [];
    const run = (...args: string[]): string => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return shallow ? "true" : "false";
      if (args[0] === "rev-parse") return "abc123";
      return "";
    };
    return { calls, run };
  }

  it("unshallows a shallow checkout while fetching main, so main..<branch> lists only the branch's own commits", () => {
    const { calls, run } = stubGit(true);

    assert.equal(fetchMain(run), "abc123");
    const fetch = calls.find((args) => args[0] === "fetch");
    assert.deepEqual(fetch, ["fetch", "--quiet", "--unshallow", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  });

  it("fetches main without --unshallow in a full clone, where git would refuse it", () => {
    const { calls, run } = stubGit(false);

    assert.equal(fetchMain(run), "abc123");
    const fetch = calls.find((args) => args[0] === "fetch");
    assert.deepEqual(fetch, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  });
});

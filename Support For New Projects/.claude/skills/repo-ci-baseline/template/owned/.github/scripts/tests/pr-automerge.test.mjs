// Tests for the inline github-script in .github/workflows/pr-automerge.yml.
// The script is read out of the workflow file and run against a fake GitHub
// client, so these tests cover exactly the code the workflow runs.
// Usage: node --test .github/scripts/tests/pr-automerge.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WORKFLOW = new URL("../../workflows/pr-automerge.yml", import.meta.url);
const OWNER = "octo";
const HEAD = "abc123";
// reapply.sh's branch, the head of a re-Apply PR.
const REAPPLY_BRANCH = "chore/reapply-baseline";
const NEEDS_HUMAN = "sandcastle:needs-human";

// Returns the body of the `script: |` block scalar with its indentation removed.
function inlineScript() {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s*script: \|\s*$/.test(line));
  assert.notEqual(start, -1, "pr-automerge.yml has no `script: |` block");
  const keyIndent = lines[start].search(/\S/);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) {
      break;
    }
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(indent)).join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const run = new AsyncFunction("github", "context", "core", "getOctokit", inlineScript());

// A same-repo PR into main that is ready to merge unless a test changes it.
function readyPr(overrides = {}) {
  return {
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    author: { login: "octo" },
    autoMergeRequest: null,
    commits: checksOn(HEAD, requiredCheck("Build Solution")),
    copilotReviews: { nodes: [{ commit: { oid: HEAD } }] },
    claudeReviews: { nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    labels: { totalCount: 0, nodes: [] },
    ...overrides
  };
}

// The head's checks as the query reports them: commits(last: 1) of oid.
function checksOn(oid, ...contexts) {
  return { nodes: [{ commit: { oid, statusCheckRollup: { contexts: { totalCount: contexts.length, nodes: contexts } } } }] };
}

// A check run; required and passed unless the overrides say otherwise.
function requiredCheck(name, overrides = {}) {
  return {
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    startedAt: "2026-10-08T10:00:00Z",
    isRequired: true,
    ...overrides
  };
}

// Copilot reviews of each given commit, oldest first. A { oid, merge: true }
// entry is a merge commit, such as a merge from main.
function copilotReviewsOf(...commits) {
  return {
    nodes: commits.map((commit) => {
      const { oid, merge } = typeof commit === "string" ? { oid: commit, merge: false } : commit;
      return { commit: { oid, parents: { totalCount: merge ? 2 : 1 } } };
    })
  };
}

// Claude Review's reviews (github-actions[bot] with the marker) of each given
// commit, oldest first, with ids claude-1, claude-2, ... A { oid, merge: true }
// entry is a merge commit; { oid, marked: false } is a github-actions[bot]
// review without the marker; { oid, offDiff: true } has findings outside the diff.
function claudeReviewsOf(...commits) {
  return {
    nodes: commits.map((commit, index) => {
      const { oid, merge, marked, offDiff } = typeof commit === "string" ? { oid: commit } : commit;
      const body = marked === false
        ? "Some other workflow's review."
        : offDiff
          ? CLAUDE_MARKER + "\n" + OFF_DIFF_MARKER + "\n**Claude Review**"
          : CLAUDE_MARKER + "\nNo findings.";
      return { id: `claude-${index + 1}`, body, commit: { oid, parents: { totalCount: merge ? 2 : 1 } } };
    })
  };
}

// Review threads, each opened by the given login, all unresolved unless marked.
// { login, review } opens the thread in the review with that id.
function threadsBy(...authors) {
  const nodes = authors.map((author) => ({
    isResolved: author.resolved ?? false,
    comments: {
      nodes: [
        {
          author: author.login === null ? null : { login: author.login ?? author },
          pullRequestReview: author.review ? { id: author.review } : null
        }
      ]
    }
  }));
  return { totalCount: nodes.length, nodes };
}

const COPILOT = "copilot-pull-request-reviewer";
// GraphQL reports github-actions[bot] without the "[bot]" suffix.
const ACTIONS = "github-actions";
const CLAUDE_MARKER = "<!-- claude-review -->";
const OFF_DIFF_MARKER = "<!-- claude-review:off-diff -->";

function labelled(...names) {
  return { totalCount: names.length, nodes: names.map((name) => ({ name })) };
}

function unlabeledEvent(label, login) {
  return { event: "unlabeled", label: { name: label }, actor: { login } };
}

function labeledEvent(label, login) {
  return { event: "labeled", label: { name: label }, actor: { login } };
}

// A commit graph for the merge-from-main checks: each commit's parents and
// files (path -> blob). onMain lists the commits on main.
//
//   base0 - main1 - main2      (main)
//      \       \      \
//       rev --- merge1 - merge2 (the PR: rev reviewed, then main merged in twice)
function graph(overrides = {}) {
  return {
    base0: { parents: [], files: { app: "app0", lib: "lib0" } },
    main1: { parents: ["base0"], files: { app: "app0", lib: "lib1" } },
    main2: { parents: ["main1"], files: { app: "app0", lib: "lib2", docs: "docs2" } },
    rev: { parents: ["base0"], files: { app: "app1", lib: "lib0" } },
    merge1: { parents: ["rev", "main1"], files: { app: "app1", lib: "lib1" } },
    merge2: { parents: ["merge1", "main2"], files: { app: "app1", lib: "lib2", docs: "docs2" } },
    ...overrides
  };
}
const ON_MAIN = ["base0", "main1", "main2"];

function ancestors(commits, sha) {
  const seen = new Set();
  const stack = [sha];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!seen.has(next) && commits[next]) {
      seen.add(next);
      stack.push(...commits[next].parents);
    }
  }
  return seen;
}

// Runs the script for PR #7 on a pull_request event and returns what it did.
// options: commits and onMain (the graph the merge checks read), prCommits
// (the PR's commits as REST lists them), comments (the PR's comments),
// updateError (thrown by update-branch), pat (false: no RELEASE_PR_PAT) and
// push (a push to main, which sweeps the open PRs).
async function evaluate(pr, events = [], options = {}) {
  const { commits = graph(), onMain = ON_MAIN, prCommits = [], comments = [], updateError, pat = true, push = false } = options;
  const updates = [];
  const posted = [];
  const merges = [];
  const logs = [];
  const eventRequests = [];
  const queries = [];
  const eventTokens = [];
  let graphqlRequests = 0;
  const pullRequests = Array.isArray(pr) ? [...pr] : [pr];
  const eventSets = Array.isArray(events[0]) ? [...events] : [events];
  const rest = {
    pulls: {
      merge: async (params) => {
        merges.push(params);
      },
      updateBranch: async (params) => {
        updates.push(params);
        if (updateError) {
          throw updateError;
        }
      },
      list: async () => {
        throw new Error("pulls.list is only called through paginate");
      },
      listCommits: async () => {
        throw new Error("pulls.listCommits is only called through paginate");
      }
    },
    issues: {
      listEvents: async () => {
        throw new Error("issues.listEvents is only called through paginate");
      },
      listComments: async () => {
        throw new Error("issues.listComments is only called through paginate");
      },
      createComment: async (params) => {
        posted.push(params);
      }
    },
    git: {
      getCommit: async ({ commit_sha: sha }) => {
        if (!commits[sha]) {
          throw Object.assign(new Error(`No commit ${sha}`), { status: 404 });
        }
        return { data: { sha, parents: commits[sha].parents.map((parent) => ({ sha: parent })), tree: { sha: `tree:${sha}` } } };
      },
      getTree: async ({ tree_sha: treeSha, recursive }) => {
        assert.equal(recursive, "true");
        const commit = commits[treeSha.slice("tree:".length)];
        const files = Object.entries(commit.files).map(([path, sha]) => ({ path, mode: "100644", type: "blob", sha }));
        // A directory entry, which the comparison has to leave out.
        return { data: { truncated: commit.truncated ?? false, tree: [{ path: "src", mode: "040000", type: "tree", sha: "t" }, ...files] } };
      }
    },
    repos: {
      compareCommitsWithBasehead: async ({ basehead }) => {
        const [base, head] = basehead.split("...");
        if (head === "main") {
          return { data: { status: onMain.includes(base) ? (base === onMain.at(-1) ? "identical" : "ahead") : "diverged" } };
        }
        // The merge base: the first of head's ancestors, nearest first, that base also has.
        const baseAncestors = ancestors(commits, base);
        const queue = [head];
        while (queue.length > 0) {
          const next = queue.shift();
          if (baseAncestors.has(next)) {
            return { data: { status: "diverged", merge_base_commit: { sha: next } } };
          }
          queue.push(...(commits[next]?.parents ?? []));
        }
        return { data: { status: "diverged", merge_base_commit: null } };
      }
    }
  };
  const github = {
    rest,
    graphql: async (query) => {
      queries.push(query);
      return { repository: { pullRequest: pullRequests[Math.min(graphqlRequests++, pullRequests.length - 1)] } };
    },
    paginate: async (method, params) => {
      if (method === rest.pulls.listCommits) {
        assert.equal(params.pull_number, 7);
        return prCommits;
      }
      if (method === rest.pulls.list) {
        return [{ number: 7 }];
      }
      throw new Error("the PAT client must not read label events or comments");
    }
  };
  // The GITHUB_TOKEN client: it only reads label events.
  const getOctokit = (token) => {
    eventTokens.push(token);
    return {
      rest,
      paginate: async (method, params) => {
        if (method === rest.issues.listEvents) {
          eventRequests.push(params);
          return eventSets[Math.min(eventRequests.length - 1, eventSets.length - 1)];
        }
        if (method === rest.issues.listComments) {
          return comments;
        }
        throw new Error("unexpected paginate call");
      }
    };
  };
  const core = {
    info: (message) => logs.push(message),
    notice: (message) => logs.push("notice: " + message),
    warning: (message) => logs.push("warning: " + message)
  };
  const context = {
    repo: { owner: OWNER, repo: "demo" },
    payload: push ? { ref: "refs/heads/main" } : { pull_request: { number: 7 } }
  };

  process.env.HAS_RELEASE_PR_PAT = pat ? "true" : "false";
  process.env.EVENTS_TOKEN = "github-token";
  process.env.MERGE_STATE_RETRY_MS = "0";
  await run(github, context, core, getOctokit);
  return { merges, updates, posted, logs, eventRequests, queries, eventTokens, graphqlRequests };
}

test("merges a ready PR at the head it checked", async () => {
  const { merges } = await evaluate(readyPr());

  assert.deepEqual(merges, [{ owner: OWNER, repo: "demo", pull_number: 7, sha: HEAD, merge_method: "squash" }]);
});

test("skips a ready PR labelled sandcastle:needs-human and says why", async () => {
  const { merges, logs } = await evaluate(readyPr({ labels: labelled("enhancement", NEEDS_HUMAN) }));

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("PR #7") && line.includes(NEEDS_HUMAN)), logs.join("\n"));
});

test("skips a PR with more labels than one page", async () => {
  const labels = { totalCount: 101, nodes: labelled("enhancement").nodes };
  const { merges, logs } = await evaluate(readyPr({ labels }));

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("PR #7") && line.includes("more labels than one page")), logs.join("\n"));
});

test("merges once the owner removes sandcastle:needs-human", async () => {
  const events = [labeledEvent(NEEDS_HUMAN, OWNER), unlabeledEvent(NEEDS_HUMAN, OWNER)];
  const { merges, eventRequests } = await evaluate(readyPr(), events);

  assert.equal(merges.length, 1);
  assert.deepEqual(eventRequests, [
    { owner: OWNER, repo: "demo", issue_number: 7, per_page: 100 },
    { owner: OWNER, repo: "demo", issue_number: 7, per_page: 100 }
  ]);
});

test("skips a PR whose sandcastle:needs-human someone else removed and says who", async () => {
  const events = [labeledEvent(NEEDS_HUMAN, OWNER), unlabeledEvent(NEEDS_HUMAN, "triager")];
  const { merges, logs } = await evaluate(readyPr(), events);

  assert.deepEqual(merges, []);
  assert.ok(
    logs.some((line) => line.includes("PR #7") && line.includes(NEEDS_HUMAN) && line.includes("triager")),
    logs.join("\n")
  );
});

test("judges only the most recent sandcastle:needs-human removal", async () => {
  // Oldest first, as the issue events API returns them.
  const ownerLast = [
    labeledEvent(NEEDS_HUMAN, OWNER),
    unlabeledEvent(NEEDS_HUMAN, "triager"),
    labeledEvent(NEEDS_HUMAN, OWNER),
    unlabeledEvent(NEEDS_HUMAN, OWNER)
  ];
  const triagerLast = [
    labeledEvent(NEEDS_HUMAN, OWNER),
    unlabeledEvent(NEEDS_HUMAN, OWNER),
    labeledEvent(NEEDS_HUMAN, OWNER),
    unlabeledEvent(NEEDS_HUMAN, "triager")
  ];

  assert.equal((await evaluate(readyPr(), ownerLast)).merges.length, 1);
  assert.equal((await evaluate(readyPr(), triagerLast)).merges.length, 0);
});

test("ignores other labels' removals", async () => {
  const events = [
    labeledEvent(NEEDS_HUMAN, OWNER),
    unlabeledEvent(NEEDS_HUMAN, OWNER),
    labeledEvent("enhancement", "triager"),
    unlabeledEvent("enhancement", "triager")
  ];
  const { merges } = await evaluate(readyPr(), events);

  assert.equal(merges.length, 1);
});

test("skips a PR whose latest sandcastle:needs-human change added it, even if the snapshot predates it", async () => {
  const events = [labeledEvent(NEEDS_HUMAN, OWNER), unlabeledEvent(NEEDS_HUMAN, OWNER), labeledEvent(NEEDS_HUMAN, "sandcastle")];
  const { merges, logs } = await evaluate(readyPr(), events);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("PR #7") && line.includes("was just added")), logs.join("\n"));
});

test("re-checks sandcastle:needs-human immediately before merging", async () => {
  const latestPr = readyPr({ labels: labelled("enhancement", NEEDS_HUMAN) });
  const { merges, logs } = await evaluate([readyPr(), latestPr]);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("PR #7") && line.includes(NEEDS_HUMAN)), logs.join("\n"));
});

test("re-checks the latest sandcastle:needs-human removal before merging", async () => {
  const initialEvents = [unlabeledEvent(NEEDS_HUMAN, OWNER)];
  const latestEvents = [unlabeledEvent(NEEDS_HUMAN, "triager")];
  const { merges, logs } = await evaluate([readyPr(), readyPr()], [initialEvents, latestEvents]);

  assert.deepEqual(merges, []);
  assert.ok(
    logs.some((line) => line.includes("PR #7") && line.includes(NEEDS_HUMAN) && line.includes("triager")),
    logs.join("\n")
  );
});

test("reads label events with GITHUB_TOKEN, not the PAT", async () => {
  const { merges, eventRequests, eventTokens } = await evaluate(readyPr());

  assert.equal(merges.length, 1);
  assert.ok(eventRequests.length > 0);
  assert.deepEqual(eventTokens, ["github-token"]);
});

test("judges the rest of readiness on the snapshot taken after the label re-check", async () => {
  const latestPr = readyPr({ reviewThreads: threadsBy("reviewer") });
  const { merges, logs } = await evaluate([readyPr(), latestPr]);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("1 unresolved review thread")), logs.join("\n"));
});

test("merges at the head of the snapshot taken after the label re-check", async () => {
  const latestPr = readyPr({ headRefOid: "def456", copilotReviews: copilotReviewsOf("def456") });
  const { merges } = await evaluate([readyPr(), latestPr]);

  assert.equal(merges.length, 1);
  assert.equal(merges[0].sha, "def456");
});

test("waits for a Copilot review of the head below the review cap", async () => {
  const { merges, logs } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "two") }));

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of " + HEAD)), logs.join("\n"));
});

test("waits on an unresolved Copilot thread below the review cap", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", HEAD), reviewThreads: threadsBy(COPILOT) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("1 unresolved review thread(s)")), logs.join("\n"));
});

test("merges without a review of the head once Copilot reviewed three commits", async () => {
  const { merges, logs } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three") }));

  assert.equal(merges.length, 1);
  assert.ok(
    logs.some((line) => line.includes("Review cap (3) reached") && line.includes("without a review of " + HEAD)),
    logs.join("\n")
  );
});

test("counts reviewed commits, not reviews, toward the cap", async () => {
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "one", "two") }));

  assert.deepEqual(merges, []);
});

test("merges past unresolved Copilot threads at the review cap and says how many", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy(COPILOT, COPILOT, { login: OWNER, resolved: true })
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(logs.some((line) => line.includes("past 2 unresolved Copilot thread(s)")), logs.join("\n"));
});

test("still waits on a person's unresolved thread at the review cap", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy(COPILOT, OWNER)
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("1 unresolved review thread(s)")), logs.join("\n"));
});

test("treats a thread with no known author as a person's at the review cap", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two", HEAD), reviewThreads: threadsBy({ login: null }) });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("still needs green checks at the review cap", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three"), mergeStateStatus: "BLOCKED" });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("doesn't count Copilot reviews of merge commits toward the cap", async () => {
  const reviews = copilotReviewsOf("one", { oid: "merge-main-1", merge: true }, { oid: "merge-main-2", merge: true });
  const { merges, logs } = await evaluate(readyPr({ copilotReviews: reviews }));

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of " + HEAD)), logs.join("\n"));
});

test("accepts a Copilot review of a merge commit at the head below the cap", async () => {
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf({ oid: HEAD, merge: true }) }));

  assert.equal(merges.length, 1);
});

test("reaches the cap on three non-merge commits among merges from main", async () => {
  const reviews = copilotReviewsOf("one", { oid: "merge-main", merge: true }, "two", "three");
  const { merges } = await evaluate(readyPr({ copilotReviews: reviews }));

  assert.equal(merges.length, 1);
});

test("keeps the cap reached through many re-reviews of one commit", async () => {
  const reviews = copilotReviewsOf("one", "two", "three", ...Array(30).fill("three"));
  const { merges, queries } = await evaluate(readyPr({ copilotReviews: reviews }));

  assert.equal(merges.length, 1);
  assert.ok(queries.every((query) => query.includes("reviews(last: 100,")), "Copilot reviews are fetched 100 at a time");
});

test("doesn't log the cap when it didn't change the outcome", async () => {
  const { merges, logs } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "two", HEAD) }));

  assert.equal(merges.length, 1);
  assert.ok(!logs.some((line) => line.includes("Review cap")), logs.join("\n"));
});

test("logs both requirements the cap bypassed", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three"), reviewThreads: threadsBy(COPILOT) });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(
    logs.some((line) => line.includes("without a review of " + HEAD + " and past 1 unresolved Copilot thread(s)")),
    logs.join("\n")
  );
});

test("merges on a Claude review of the head with no threads", async () => {
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf(HEAD) }));

  assert.equal(merges.length, 1);
});

test("waits on an unresolved Claude thread", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf(),
    claudeReviews: claudeReviewsOf(HEAD),
    reviewThreads: threadsBy({ login: ACTIONS, review: "claude-1" })
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("1 unresolved review thread(s)")), logs.join("\n"));
});

test("waits on a Claude review of an older head", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf("older") });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of " + HEAD)), logs.join("\n"));
});

test("ignores a github-actions[bot] review without the marker", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf({ oid: HEAD, marked: false }) });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("doesn't count unmarked github-actions[bot] reviews toward the cap", async () => {
  const claude = claudeReviewsOf({ oid: "two", marked: false }, { oid: "three", marked: false });
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one"), claudeReviews: claude }));

  assert.deepEqual(merges, []);
});

test("counts mixed Copilot and Claude rounds toward the cap", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf("three") });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(
    logs.some((line) => line.includes("Review cap (3) reached") && line.includes("without a review of " + HEAD)),
    logs.join("\n")
  );
});

test("counts a commit both reviewers reviewed as one round", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf("two") });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("doesn't count Claude reviews of merge commits toward the cap", async () => {
  const claude = claudeReviewsOf({ oid: "merge-main", merge: true });
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claude }));

  assert.deepEqual(merges, []);
});

test("merges past unresolved Copilot and Claude threads at the cap and names each reviewer", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf(HEAD),
    reviewThreads: threadsBy(COPILOT, { login: ACTIONS, review: "claude-1" }, { login: ACTIONS, review: "claude-1" })
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(
    logs.some((line) => line.includes("past 1 unresolved Copilot thread(s) and 2 unresolved Claude thread(s)")),
    logs.join("\n")
  );
});

test("still waits at the cap on a github-actions thread outside a Claude review", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two", HEAD),
    claudeReviews: claudeReviewsOf({ oid: "two", marked: false }),
    reviewThreads: threadsBy({ login: ACTIONS, review: "claude-1" })
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("1 unresolved review thread(s)")), logs.join("\n"));
});

test("follows Claude Review's runs", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /workflows: \[[^\]]*"Claude Review"[^\]]*\]/);
});

test("waits on a Claude review of the head with findings outside the diff", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf(HEAD), claudeReviews: claudeReviewsOf({ oid: HEAD, offDiff: true }) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("findings outside the diff")), logs.join("\n"));
});

test("judges off-diff findings by the latest Claude review of the head", async () => {
  const blocked = claudeReviewsOf(HEAD, { oid: HEAD, offDiff: true });
  const cleared = claudeReviewsOf({ oid: HEAD, offDiff: true }, HEAD);

  assert.equal((await evaluate(readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: blocked }))).merges.length, 0);
  assert.equal((await evaluate(readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: cleared }))).merges.length, 1);
});

test("ignores off-diff findings on an older head", async () => {
  const claude = claudeReviewsOf({ oid: "older", offDiff: true });
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf(HEAD), claudeReviews: claude }));

  assert.equal(merges.length, 1);
});

test("merges past off-diff findings at the review cap and says so", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf({ oid: HEAD, offDiff: true }) });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(logs.some((line) => line.includes("Review cap (3) reached") && line.includes("past Claude's findings outside the diff")),
    logs.join("\n"));
});

// A re-Apply PR has no review cap: its rounds come from re-Apply commits, not
// from chasing comments, and it changes the gate itself.
test("still waits on an unresolved Copilot thread past the cap on a re-Apply PR", async () => {
  const pr = readyPr({
    headRefName: REAPPLY_BRANCH,
    copilotReviews: copilotReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy(COPILOT)
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(!logs.some((line) => line.includes("Review cap")), logs.join("\n"));
});

test("still waits on an unresolved Claude thread past the cap on a re-Apply PR", async () => {
  const pr = readyPr({
    headRefName: REAPPLY_BRANCH,
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf(HEAD),
    reviewThreads: threadsBy({ login: ACTIONS, review: "claude-1" })
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(!logs.some((line) => line.includes("Review cap")), logs.join("\n"));
});

test("still waits for a review of the head past the cap on a re-Apply PR", async () => {
  const pr = readyPr({ headRefName: REAPPLY_BRANCH, copilotReviews: copilotReviewsOf("one", "two", "three") });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("still waits on off-diff findings past the cap on a re-Apply PR", async () => {
  const pr = readyPr({
    headRefName: REAPPLY_BRANCH,
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf({ oid: HEAD, offDiff: true })
  });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("merges a re-Apply PR past the cap once its head is reviewed and its threads are resolved", async () => {
  const pr = readyPr({
    headRefName: REAPPLY_BRANCH,
    copilotReviews: copilotReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy({ login: COPILOT, resolved: true })
  });
  const { merges } = await evaluate(pr);

  assert.equal(merges.length, 1);
});

test("asks for the head branch's name", async () => {
  const { queries } = await evaluate(readyPr());

  assert.ok(queries.some((query) => /\bheadRefName\b/.test(query)), queries.join("\n"));
});

// ── Merges from main onto a reviewed commit ─────────────────────────────────

// Asserts the run waited for a review of head, with no API error on the way.
function assertWaitsForReview({ merges, logs }, head) {
  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of " + head)), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("warning: ")), logs.join("\n"));
}

// A PR whose head is the given commit of graph(), reviewed by Copilot at rev.
function mergedPr(head, overrides = {}) {
  return readyPr({ headRefOid: head, copilotReviews: copilotReviewsOf("rev"), commits: checksOn(head, requiredCheck("Build Solution")), ...overrides });
}

test("merges a clean merge of main into a reviewed commit without a new review", async () => {
  const { merges, logs } = await evaluate(mergedPr("merge1"));

  assert.equal(merges.length, 1);
  assert.equal(merges[0].sha, "merge1");
  assert.ok(logs.some((line) => line.includes("merge1 is a clean merge from main onto rev")), logs.join("\n"));
});

test("follows a chain of clean merges from main down to the reviewed commit", async () => {
  const { merges } = await evaluate(mergedPr("merge2"));

  assert.equal(merges.length, 1);
});

test("counts a file main deleted as clean", async () => {
  const commits = graph({
    main1: { parents: ["base0"], files: { app: "app0" } },
    merge1: { parents: ["rev", "main1"], files: { app: "app1" } }
  });
  const { merges } = await evaluate(mergedPr("merge1"), [], { commits });

  assert.equal(merges.length, 1);
});

test("waits on a merge from main that also changes a file", async () => {
  const commits = graph({ merge1: { parents: ["rev", "main1"], files: { app: "app2", lib: "lib1" } } });
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { commits }), "merge1");
});

test("waits on a merge from main that adds a file neither side has", async () => {
  const commits = graph({ merge1: { parents: ["rev", "main1"], files: { app: "app1", lib: "lib1", extra: "x" } } });
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { commits }), "merge1");
});

test("waits on a merge from main where both sides changed the same file", async () => {
  const commits = graph({
    main1: { parents: ["base0"], files: { app: "app3", lib: "lib0" } },
    merge1: { parents: ["rev", "main1"], files: { app: "app4", lib: "lib0" } }
  });
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { commits }), "merge1");
});

test("waits on a merge whose second parent isn't on main", async () => {
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { onMain: ["base0"] }), "merge1");
});

test("waits on a merge from main into a commit nobody reviewed", async () => {
  assertWaitsForReview(await evaluate(mergedPr("merge1", { copilotReviews: copilotReviewsOf("other") })), "merge1");
});

test("waits on a merge of the reviewed commit into main's side", async () => {
  // First parent main, second the reviewed commit: the PR's side isn't the reviewed one.
  const commits = graph({ merge1: { parents: ["main1", "rev"], files: { app: "app1", lib: "lib1" } } });
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { commits }), "merge1");
});

test("waits on a merge from main when a tree listing is truncated", async () => {
  const commits = graph({ merge1: { parents: ["rev", "main1"], files: { app: "app1", lib: "lib1" }, truncated: true } });
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { commits }), "merge1");
});

test("stops following merges from main past the chain limit", async () => {
  const commits = graph();
  let previous = "rev";
  for (let n = 1; n <= 6; n++) {
    commits[`m${n}`] = { parents: [previous, "main1"], files: { app: "app1", lib: "lib1" } };
    previous = `m${n}`;
  }
  assert.equal((await evaluate(mergedPr("m5"), [], { commits })).merges.length, 1);
  assertWaitsForReview(await evaluate(mergedPr("m6"), [], { commits }), "m6");
});

test("waits, with a warning, when the merge check can't read a commit", async () => {
  const { merges, logs } = await evaluate(mergedPr("missing"));

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.startsWith("warning: ") && line.includes("clean merge from main")), logs.join("\n"));
});

test("keeps Claude's off-diff hold on the commit a merge from main covers", async () => {
  const pr = mergedPr("merge1", { copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf({ oid: "rev", offDiff: true }) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("Claude's review of rev has findings outside the diff")), logs.join("\n"));
});

test("doesn't spend API calls on a merge check once the cap is reached", async () => {
  const pr = mergedPr("missing", { copilotReviews: copilotReviewsOf("one", "two", "three") });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(!logs.some((line) => line.startsWith("warning: ")), logs.join("\n"));
});

// ── Bringing a ready PR up to date with main ────────────────────────────────

test("brings a ready PR that is BEHIND main up to date, pinned to its head", async () => {
  const { merges, updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }));

  assert.deepEqual(merges, []);
  assert.deepEqual(updates, [{ owner: OWNER, repo: "demo", pull_number: 7, expected_head_sha: HEAD }]);
  assert.ok(logs.some((line) => line.includes("Bringing PR #7 up to date with main from " + HEAD)), logs.join("\n"));
});

test("brings a BEHIND merge from main up to date again", async () => {
  const { updates } = await evaluate(mergedPr("merge1", { mergeStateStatus: "BEHIND" }));

  assert.equal(updates.length, 1);
  assert.equal(updates[0].expected_head_sha, "merge1");
});

test("leaves a BEHIND PR waiting with a notice when RELEASE_PR_PAT isn't set", async () => {
  const { updates, posted, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { pat: false });

  assert.deepEqual(updates, []);
  assert.deepEqual(posted, []);
  assert.ok(logs.some((line) => line.startsWith("notice: ") && line.includes("RELEASE_PR_PAT is not set")), logs.join("\n"));
});

test("doesn't update a BEHIND PR still waiting on a review", async () => {
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", copilotReviews: copilotReviewsOf("older") }));

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of " + HEAD)), logs.join("\n"));
});

test("doesn't update a BEHIND PR with an unresolved thread", async () => {
  const { updates } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", reviewThreads: threadsBy(OWNER) }));

  assert.deepEqual(updates, []);
});

test("doesn't update a BEHIND PR held by Claude's off-diff findings", async () => {
  const pr = readyPr({ mergeStateStatus: "BEHIND", copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf({ oid: HEAD, offDiff: true }) });
  const { updates } = await evaluate(pr);

  assert.deepEqual(updates, []);
});

test("doesn't update a BEHIND PR labelled sandcastle:needs-human", async () => {
  const { updates } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", labels: labelled(NEEDS_HUMAN) }));

  assert.deepEqual(updates, []);
});

test("never updates a BEHIND draft or fork PR", async () => {
  assert.deepEqual((await evaluate(readyPr({ mergeStateStatus: "BEHIND", isDraft: true }))).updates, []);
  assert.deepEqual((await evaluate(readyPr({ mergeStateStatus: "BEHIND", isCrossRepository: true }))).updates, []);
  const armedFork = readyPr({ mergeStateStatus: "BEHIND", isCrossRepository: true, autoMergeRequest: { enabledAt: "now" } });
  assert.deepEqual((await evaluate(armedFork)).updates, []);
});

test("updates a BEHIND PR past the review cap without a review of its head", async () => {
  const { updates } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", copilotReviews: copilotReviewsOf("one", "two", "three") }));

  assert.equal(updates.length, 1);
});

test("doesn't update a BEHIND PR that can't merge cleanly", async () => {
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", mergeable: "CONFLICTING" }));

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("BEHIND main, mergeable=CONFLICTING")), logs.join("\n"));
});

test("doesn't update a BEHIND PR until its required checks pass", async () => {
  const running = readyPr({ mergeStateStatus: "BEHIND", commits: checksOn(HEAD, requiredCheck("Build Solution", { status: "IN_PROGRESS", conclusion: null })) });
  const failed = readyPr({ mergeStateStatus: "BEHIND", commits: checksOn(HEAD, requiredCheck("Build Solution", { conclusion: "FAILURE" })) });
  const failedStatus = readyPr({
    mergeStateStatus: "BEHIND",
    commits: checksOn(HEAD, { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", createdAt: "x", isRequired: true })
  });
  const otherHead = readyPr({ mergeStateStatus: "BEHIND", commits: checksOn("older", requiredCheck("Build Solution")) });
  const noChecks = readyPr({ mergeStateStatus: "BEHIND", commits: checksOn(HEAD) });

  const result = await evaluate(running);
  assert.deepEqual(result.updates, []);
  assert.ok(result.logs.some((line) => line.includes("required checks not passed: Build Solution")), result.logs.join("\n"));
  for (const pr of [failed, failedStatus, otherHead, noChecks]) {
    assert.deepEqual((await evaluate(pr)).updates, []);
  }
});

test("judges a BEHIND PR's required checks by their newest runs, and only the required ones", async () => {
  const rerun = checksOn(
    HEAD,
    requiredCheck("Build Solution", { conclusion: "CANCELLED", startedAt: "2026-10-08T10:00:00Z" }),
    requiredCheck("Build Solution", { conclusion: "SUCCESS", startedAt: "2026-10-08T10:05:00Z" }),
    requiredCheck("Coverage", { conclusion: "FAILURE", isRequired: false }),
    requiredCheck("Merge same-repo PRs when ready", { status: "IN_PROGRESS", conclusion: null, isRequired: false }),
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", createdAt: "x", isRequired: true }
  );
  const regressed = checksOn(
    HEAD,
    requiredCheck("Build Solution", { conclusion: "SUCCESS", startedAt: "2026-10-08T10:00:00Z" }),
    requiredCheck("Build Solution", { conclusion: "FAILURE", startedAt: "2026-10-08T10:05:00Z" })
  );

  const queuedRerun = checksOn(
    HEAD,
    requiredCheck("Build Solution", { conclusion: "SUCCESS", startedAt: "2026-10-08T10:00:00Z" }),
    requiredCheck("Build Solution", { status: "QUEUED", conclusion: null, startedAt: null })
  );

  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", commits: rerun }))).updates.length, 1);
  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", commits: regressed }))).updates.length, 0);
  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", commits: queuedRerun }))).updates.length, 0);
});

test("says so where it shows when a BEHIND PR has no required check at all", async () => {
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", commits: checksOn(HEAD, requiredCheck("Lint", { isRequired: false })) }));

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.startsWith("notice: ") && line.includes("no required check")), logs.join("\n"));
});

test("takes a 422 from update-branch quietly", async () => {
  const updateError = Object.assign(new Error("expected head sha didn't match current head ref"), { status: 422 });
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { updateError });

  assert.equal(updates.length, 1);
  assert.ok(logs.some((line) => line.includes("Not updating PR #7")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("warning: ")), logs.join("\n"));
});

test("warns, but doesn't fail, when update-branch fails otherwise", async () => {
  const updateError = Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 });
  const { logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { updateError });

  assert.ok(logs.some((line) => line.startsWith("warning: ") && line.includes("Resource not accessible")), logs.join("\n"));
});

test("brings a PR with native auto-merge armed up to date without a review", async () => {
  const pr = readyPr({ mergeStateStatus: "BEHIND", autoMergeRequest: { enabledAt: "now" }, copilotReviews: copilotReviewsOf(), headRefName: "docs/release-notes" });
  const { updates, merges } = await evaluate(pr);

  assert.equal(updates.length, 1);
  assert.deepEqual(merges, []);
});

test("leaves a PR with native auto-merge armed alone when it's up to date", async () => {
  const { updates, merges, logs } = await evaluate(readyPr({ autoMergeRequest: { enabledAt: "now" } }));

  assert.deepEqual(updates, []);
  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("auto-merge is already enabled")), logs.join("\n"));
});

// Dependabot's PR, armed by dependabot-auto-merge.yml.
function dependabotPr(overrides = {}) {
  return readyPr({
    mergeStateStatus: "BEHIND",
    author: { login: "dependabot" },
    autoMergeRequest: { enabledAt: "now" },
    copilotReviews: copilotReviewsOf(),
    ...overrides
  });
}
const DEPENDABOT_COMMITS = [{ sha: HEAD, author: { login: "dependabot[bot]" } }];

test("asks Dependabot to rebase its own BEHIND PR instead of updating it", async () => {
  const { updates, posted } = await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS });

  assert.deepEqual(updates, []);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].issue_number, 7);
  assert.match(posted[0].body, /^@dependabot rebase\n/);
  assert.ok(posted[0].body.includes(`<!-- pr-automerge:dependabot-rebase ${HEAD} -->`), posted[0].body);
});

test("asks Dependabot to rebase only once per head", async () => {
  const asked = [{ body: `@dependabot rebase\n\n<!-- pr-automerge:dependabot-rebase ${HEAD} -->` }];
  const askedBefore = [{ body: "@dependabot rebase\n\n<!-- pr-automerge:dependabot-rebase older -->" }, { body: null }];

  const again = await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS, comments: asked });
  assert.deepEqual(again.posted, []);
  assert.deepEqual(again.updates, []);
  assert.ok(again.logs.some((line) => line.includes("already asked to rebase " + HEAD)), again.logs.join("\n"));
  assert.equal((await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS, comments: askedBefore })).posted.length, 1);
});

test("updates a BEHIND Dependabot PR someone else pushed to", async () => {
  const prCommits = [...DEPENDABOT_COMMITS, { sha: "fix", author: { login: "mpaulosky" } }];
  const { updates, posted } = await evaluate(dependabotPr(), [], { prCommits });

  assert.equal(updates.length, 1);
  assert.deepEqual(posted, []);
});

test("doesn't ask Dependabot to rebase without RELEASE_PR_PAT", async () => {
  const { posted } = await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS, pat: false });

  assert.deepEqual(posted, []);
});

test("asks again while GitHub still computes the merge state", async () => {
  const unknown = readyPr({ mergeStateStatus: "UNKNOWN" });
  const { merges, graphqlRequests } = await evaluate([readyPr(), unknown, unknown, readyPr()]);

  assert.equal(merges.length, 1);
  assert.equal(graphqlRequests, 4);
});

test("gives up on an UNKNOWN merge state after a few tries", async () => {
  const unknown = readyPr({ mergeStateStatus: "UNKNOWN" });
  const { merges, graphqlRequests, logs } = await evaluate([readyPr(), unknown]);

  assert.deepEqual(merges, []);
  assert.equal(graphqlRequests, 6);
  assert.ok(logs.some((line) => line.includes("mergeStateStatus=UNKNOWN")), logs.join("\n"));
});

test("a push to main sweeps the open PRs and brings the ready ones up to date", async () => {
  const { updates } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { push: true });

  assert.equal(updates.length, 1);
});

test("runs on a push to main", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /\n {2}push:\n {4}branches: \[main\]\n/);
});

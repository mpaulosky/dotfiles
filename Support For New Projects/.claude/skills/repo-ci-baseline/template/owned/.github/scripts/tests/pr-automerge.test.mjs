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
const PR_NODE_ID = "PR_kwDOdemo7";
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
// Claude's reviews count as backup for Copilot's quota note on the same
// commit (or, for the head, where Copilot can't review it: PR Auto-Merge asked
// once, and the request didn't register, mpaulosky/dotfiles#360), so each
// Claude review given here comes with that note, unless { quotaNotes: false }
// says Copilot never posted one, or the test's own copilotReviews already
// hold the notes it wants.
function readyPr({ quotaNotes = true, ...overrides } = {}) {
  if (quotaNotes && overrides.claudeReviews) {
    const reviewed = overrides.copilotReviews?.nodes ?? [{ commit: { oid: HEAD } }];
    const notes = overrides.claudeReviews.nodes
      .filter((review) => !reviewed.some((other) => other.commit?.oid === review.commit.oid && COPILOT_NO_REVIEW_TEST.test(other.body ?? "")))
      .map((review) => ({ body: COPILOT_QUOTA_NOTE, commit: { oid: review.commit.oid, parents: review.commit.parents } }));
    overrides = { ...overrides, copilotReviews: { nodes: [...reviewed, ...notes] } };
  }
  return {
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: "main",
    id: PR_NODE_ID,
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    author: { login: "octo" },
    autoMergeRequest: null,
    headRef: checksOn(HEAD, requiredCheck("Build Solution")),
    copilotReviews: { nodes: [{ commit: { oid: HEAD } }] },
    reviewRequests: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    claudeReviews: { nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    labels: { totalCount: 0, nodes: [] },
    ...overrides
  };
}

// The head's checks as the query reports them: headRef's target, at oid.
function checksOn(oid, ...contexts) {
  return { target: { oid, statusCheckRollup: { contexts: { totalCount: contexts.length, nodes: contexts } } } };
}

// A check run; required and passed unless the overrides say otherwise.
function requiredCheck(name, overrides = {}) {
  return {
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    databaseId: 1,
    isRequired: true,
    ...overrides
  };
}

// What Copilot posts, as a review of the head, when the account's Copilot
// code review quota is used up: it reviewed nothing.
const COPILOT_NO_REVIEW_TEST = /^[ \t\r\n]*Copilot was unable to review/;
const COPILOT_QUOTA_NOTE =
  "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.";

// Copilot reviews of each given commit, oldest first. A { oid, merge: true }
// entry is a merge commit, such as a merge from main; { oid, note: true } is
// Copilot's quota note rather than a review.
function copilotReviewsOf(...commits) {
  return {
    nodes: commits.map((commit) => {
      const { oid, merge, note } = typeof commit === "string" ? { oid: commit, merge: false, note: false } : commit;
      return { body: note ? COPILOT_QUOTA_NOTE : "", commit: { oid, parents: { totalCount: merge ? 2 : 1 } } };
    })
  };
}

// Claude Review's reviews (github-actions[bot] with the marker) of each given
// commit, oldest first, with ids claude-1, claude-2, ... A { oid, merge: true }
// entry is a merge commit; { oid, marked: false } is a github-actions[bot]
// review without the marker; { oid, offDiff: true } has findings outside the diff;
// { oid, at } was submitted at that time (default: the Nth minute of 2026-01-02).
function claudeReviewsOf(...commits) {
  return {
    nodes: commits.map((commit, index) => {
      const { oid, merge, marked, offDiff, at } = typeof commit === "string" ? { oid: commit } : commit;
      const body = marked === false
        ? "Some other workflow's review."
        : offDiff
          ? CLAUDE_MARKER + "\n" + OFF_DIFF_MARKER + "\n**Claude Review**"
          : CLAUDE_MARKER + "\nNo findings.";
      const submittedAt = at ?? `2026-01-02T00:${String(index).padStart(2, "0")}:00Z`;
      return { id: `claude-${index + 1}`, body, submittedAt, commit: { oid, parents: { totalCount: merge ? 2 : 1 } } };
    })
  };
}

// Review threads, each opened by the given login, all unresolved unless marked.
// { login, review } opens the thread in the review with that id; { reviewBody }
// gives that review's body (Claude Review's starts with its marker). { path, line,
// url } place the opening comment, { replies: [login, ...] } add later comments,
// { kind } is the opener's GraphQL type (default: a Bot for Copilot and
// github-actions, else a User) and { total } is comments.totalCount.
function threadsBy(...authors) {
  const nodes = authors.map((author) => {
    const login = author.login === null ? null : (author.login ?? author);
    const kind = author.kind ?? (login === COPILOT || login === ACTIONS ? "Bot" : "User");
    const review = author.review || author.reviewBody !== undefined
      ? { id: author.review, body: author.reviewBody ?? "" }
      : null;
    const comments = [
      {
        url: author.url ?? "https://github.com/octo/repo/pull/7#discussion_r1",
        author: login === null ? null : { login, __typename: kind },
        pullRequestReview: review
      },
      ...(author.replies ?? []).map((reply) => ({
        url: "https://github.com/octo/repo/pull/7#discussion_r2",
        author: { login: reply, __typename: "User" },
        pullRequestReview: null
      }))
    ];
    return {
      isResolved: author.resolved ?? false,
      path: author.path ?? "src/a.py",
      line: author.line ?? 12,
      originalLine: author.line ?? 12,
      comments: { totalCount: author.total ?? comments.length, nodes: comments }
    };
  });
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
    // readyPr()'s head: an ordinary commit, never a merge from main.
    [HEAD]: { parents: ["rev"], files: { app: "app2", lib: "lib0" } },
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
// updateError (thrown by update-branch), pat (false: no RELEASE_PR_PAT),
// push (a push to main, which sweeps the open PRs), requiredChecks (the check
// names main's rulesets require; rulesError makes reading them throw) and
// poster (the login the PAT posts comments as), and workflowRun (a
// workflow_run event: { name, head_sha }) with associated (the PRs GitHub
// associates with its commit).
const POSTER = "release-bot";
const PAT_TOKEN = "pat-token";
async function evaluate(pr, events = [], options = {}) {
  const {
    commits = graph(),
    onMain = ON_MAIN,
    prCommits = [],
    comments = [],
    updateError,
    pat = true,
    push = false,
    requiredChecks = ["Build Solution"],
    rulesError,
    poster = POSTER,
    workflowRun,
    associated = [],
    removeLabelError,
    addLabelError,
    eventsError,
    // Which label-events read eventsError fails, counting from 1.
    eventsErrorAt = 1,
    // Claude Review's workflow runs for the head, and an error reading them.
    claudeRuns = [],
    claudeRunsTotal,
    claudeRunsError,
    // Every workflow run for the head, whatever its workflow, as
    // actions.listWorkflowRunsForRepo reads them ({ status, ... }), filtered by
    // the request's head_sha and status.
    headRuns = [],
    // An error reading them.
    headRunsError,
    // The open PRs a sweep lists, oldest first.
    openPrs = [7],
    // Snapshots per PR number ({ 7: [...], 8: [...] }), each read in turn
    // and the last repeated; overrides pr for the numbers it names. An
    // Error in place of a snapshot is thrown by that read.
    byNumber = {},
    // PR numbers whose read throws.
    readErrors = [],
    // What happens to PR Auto-Merge's one Copilot request (mpaulosky/dotfiles#360):
    // "drops" (GitHub accepts the call and registers nothing, as it does
    // without Copilot code review budget), "registers" (Copilot shows as
    // requested on every later read), "quota-note" (Copilot answers with its
    // quota note on the head) or an Error the PAT's call throws.
    copilotRequest = "drops",
    // With "registers": the request only shows from this many reads after it.
    registersAfterReads = 0,
    // An error thrown by the comment that records the ask.
    askCommentError,
    // The read-back window and its poll interval, in ms (the workflow's
    // COPILOT_ASK_WAIT_MS and COPILOT_ASK_POLL_MS).
    askWaitMs = 0,
    askPollMs = 0,
    // A second run's record of the same ask (mpaulosky/dotfiles#369): it shows
    // on every read after this run posted its own, by rivalLogin, with a
    // createdAt rivalOffsetMs after this run's (negative: before it). Only its
    // createdAt follows the offset; where it is listed follows rivalFirst. The
    // first read, before this run posted, never shows it: that's the race,
    // both runs read "none".
    rivalOffsetMs,
    rivalLogin = ACTIONS,
    // The re-reads after this run's record that don't show it yet (GraphQL
    // lagging behind the REST write), and the ones that throw.
    ownRecordHiddenReads = 0,
    reReadErrors = 0,
    // What those throw: a plain server error, or one carrying a status (a 401
    // or 429 ends a run).
    reReadError = new Error("Server error on the re-read"),
    // Whether the rival's record is listed before this run's own, whatever its
    // createdAt: GitHub lists comments oldest first, and the first record
    // listed is the one that decides. Unset, the rival is listed first when its
    // offset is negative, as it would be if its createdAt were true to the order.
    rivalFirst,
    // The pause between the re-reads, in ms (the workflow's COPILOT_ASK_REREAD_MS).
    askRereadMs = 0
  } = options;
  const rulesRequests = [];
  const updates = [];
  const posted = [];
  const merges = [];
  const logs = [];
  const eventRequests = [];
  const runRequests = [];
  const headRunRequests = [];
  const queries = [];
  // Every client call as { client: "token" | "pat", call }, in order, and the
  // tokens getOctokit was given.
  const calls = [];
  const patTokens = [];
  const clientCall = (client, call) => calls.push({ client, call });
  // A GITHUB_TOKEN method, and the name a paginate call reports it under.
  const methodNames = new Map();
  const viaToken = (call, method) => {
    const wrapped = async (...args) => {
      clientCall("token", call);
      return method(...args);
    };
    methodNames.set(wrapped, call);
    return wrapped;
  };
  // A call that must go through the PAT: GITHUB_TOKEN's client records it and throws.
  const refusedByToken = (call) => {
    return async () => {
      clientCall("token", call);
      throw new Error(`${call} goes through the PAT client`);
    };
  };
  const removedLabels = [];
  const addedLabels = [];
  const listRequests = [];
  let graphqlRequests = 0;
  const pullRequests = Array.isArray(pr) ? [...pr] : [pr];
  const reads = {};
  const eventSets = Array.isArray(events[0]) ? [...events] : [events];
  // The Copilot ask (mpaulosky/dotfiles#360): the record comments GITHUB_TOKEN
  // posted, the PAT's review requests, and every ask-related step in order.
  const asked = [];
  // When each record in asked was written.
  const askedAt = [];
  const requests = [];
  const order = [];
  let readsSinceRequest = 0;
  let requested = false;
  let reReads = 0;
  // What a read shows once this run has acted: its own record comment, and
  // Copilot's request if it registered.
  const withRunsOwnWrites = (snapshot) => {
    if (!snapshot || typeof snapshot !== "object" || snapshot instanceof Error) {
      return snapshot;
    }
    let shown = snapshot;
    if (asked.length > 0 && snapshot.comments) {
      const own = reReads <= ownRecordHiddenReads && !requested ? [] : asked.map((comment, index) => ({ author: { login: ACTIONS }, body: comment.body, createdAt: new Date(askedAt[index]).toISOString() }));
      const rival = rivalOffsetMs === undefined ? [] : [{
        author: { login: rivalLogin },
        body: "PR Auto-Merge asked Copilot to review this PR.\n\n<!-- pr-automerge:copilot-asked -->",
        createdAt: new Date(askedAt[0] + rivalOffsetMs).toISOString()
      }];
      const rivalListedFirst = rivalFirst ?? (rivalOffsetMs !== undefined && rivalOffsetMs < 0);
      const nodes = rivalListedFirst
        ? [...snapshot.comments.nodes, ...rival, ...own]
        : [...snapshot.comments.nodes, ...own, ...rival];
      shown = { ...shown, comments: { totalCount: snapshot.comments.totalCount + own.length + rival.length, nodes } };
    }
    if (requested && copilotRequest === "registers" && readsSinceRequest > registersAfterReads) {
      const present = shown.reviewRequests ?? { totalCount: 0, nodes: [] };
      shown = { ...shown, reviewRequests: { totalCount: present.totalCount + 1, nodes: [...present.nodes, ...COPILOT_PENDING.nodes] } };
    }
    if (requested && copilotRequest === "quota-note" && readsSinceRequest > registersAfterReads) {
      const note = { body: COPILOT_QUOTA_NOTE, commit: { oid: shown.headRefOid, parents: { totalCount: 1 } } };
      shown = { ...shown, copilotReviews: { nodes: [...shown.copilotReviews.nodes, note] } };
    }
    return shown;
  };
  const rest = {
    pulls: {
      merge: refusedByToken("pulls.merge"),
      updateBranch: refusedByToken("pulls.updateBranch"),
      list: viaToken("pulls.list", async () => {
        throw new Error("pulls.list is only called through paginate");
      }),
      listCommits: viaToken("pulls.listCommits", async () => {
        throw new Error("pulls.listCommits is only called through paginate");
      })
    },
    issues: {
      listEvents: viaToken("issues.listEvents", async () => {
        throw new Error("issues.listEvents is only called through paginate");
      }),
      listComments: viaToken("issues.listComments", async () => {
        throw new Error("issues.listComments is only called through paginate");
      }),
      // GITHUB_TOKEN: the record that Copilot was asked.
      createComment: viaToken("issues.createComment", async (params) => {
        order.push("record");
        if (askCommentError) {
          throw askCommentError;
        }
        asked.push(params);
        askedAt.push(Date.now());
      }),
      // GITHUB_TOKEN: a removal that starts no workflow is what's wanted.
      removeLabel: viaToken("issues.removeLabel", async (params) => {
        removedLabels.push(params);
        if (removeLabelError) {
          throw removeLabelError;
        }
      }),
      // With the PAT: a label added with GITHUB_TOKEN starts no workflow.
      addLabels: refusedByToken("issues.addLabels")
    },
    users: {
      getAuthenticated: refusedByToken("users.getAuthenticated")
    },
    git: {
      getCommit: viaToken("git.getCommit", async ({ commit_sha: sha }) => {
        if (!commits[sha]) {
          throw Object.assign(new Error(`No commit ${sha}`), { status: 404 });
        }
        return { data: { sha, parents: commits[sha].parents.map((parent) => ({ sha: parent })), tree: { sha: `tree:${sha}` } } };
      }),
      getTree: viaToken("git.getTree", async ({ tree_sha: treeSha, recursive }) => {
        assert.equal(recursive, "true");
        const commit = commits[treeSha.slice("tree:".length)];
        // A file is a blob sha, or { sha, mode } for another mode (an executable, a symlink).
        const files = Object.entries(commit.files).map(([path, file]) => {
          const { sha, mode = "100644" } = typeof file === "string" ? { sha: file } : file;
          return { path, mode, type: "blob", sha };
        });
        // A directory entry, which the comparison has to leave out.
        return { data: { truncated: commit.truncated ?? false, tree: [{ path: "src", mode: "040000", type: "tree", sha: "t" }, ...files] } };
      })
    },
    repos: {
      listPullRequestsAssociatedWithCommit: viaToken("repos.listPullRequestsAssociatedWithCommit", async ({ commit_sha: sha }) => {
        assert.equal(sha, workflowRun.head_sha);
        return { data: associated };
      }),
      getBranchRules: viaToken("repos.getBranchRules", async () => {
        throw new Error("repos.getBranchRules is only called through paginate");
      }),
      compareCommitsWithBasehead: viaToken("repos.compareCommitsWithBasehead", async ({ basehead }) => {
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
      })
    }
  };
  const github = {
    rest,
    graphql: async (query, variables = {}) => {
      clientCall("token", "graphql");
      queries.push(query);
      if (requested) {
        readsSinceRequest++;
        order.push("read-back");
      } else if (asked.length > 0) {
        // A read of the PR after the record was posted and before the request.
        order.push("re-read");
        reReads++;
        if (reReads <= reReadErrors) {
          throw reReadError;
        }
      }
      const number = variables.number;
      if (readErrors.includes(number)) {
        graphqlRequests++;
        throw new Error(`Server error reading PR #${number}`);
      }
      if (byNumber[number]) {
        graphqlRequests++;
        const snapshots = byNumber[number];
        reads[number] = (reads[number] ?? 0) + 1;
        const snapshot = snapshots[Math.min(reads[number] - 1, snapshots.length - 1)];
        if (snapshot instanceof Error) {
          throw snapshot;
        }
        return { repository: { pullRequest: withRunsOwnWrites(snapshot) } };
      }
      return { repository: { pullRequest: withRunsOwnWrites(pullRequests[Math.min(graphqlRequests++, pullRequests.length - 1)]) } };
    },
    paginate: async (method, params) => {
      clientCall("token", methodNames.get(method) ?? "unknown paginate method");
      if (method === rest.pulls.listCommits) {
        assert.equal(params.pull_number, 7);
        return prCommits;
      }
      if (method === rest.pulls.list) {
        listRequests.push(params);
        return openPrs.map((number) => ({ number }));
      }
      if (method === rest.repos.getBranchRules) {
        rulesRequests.push(params);
        if (rulesError) {
          throw rulesError;
        }
        // An unrelated rule, and the required checks.
        return [
          { type: "pull_request", parameters: {} },
          { type: "required_status_checks", parameters: { required_status_checks: requiredChecks.map((context) => ({ context })) } }
        ];
      }
      if (method === rest.issues.listEvents) {
        eventRequests.push(params);
        // Only one read fails (the first, unless eventsErrorAt says), so a later one (the hand-back check) still works.
        if (eventsError && eventRequests.length === eventsErrorAt) {
          throw eventsError;
        }
        return eventSets[Math.min(eventRequests.length - 1, eventSets.length - 1)];
      }
      if (method === rest.issues.listComments) {
        return comments;
      }
      if (method === rest.actions.listWorkflowRunsForRepo) {
        headRunRequests.push(params);
        if (headRunsError) {
          throw headRunsError;
        }
        return headRunsFor(params);
      }
      throw new Error("unexpected paginate call");
    }
  };
  // The head's runs, filtered as GitHub filters them by head_sha and status.
  const headRunsFor = (params) => {
    return headRuns.filter((run) => {
      return (params.head_sha === undefined || run.head_sha === params.head_sha) &&
        (params.status === undefined || run.status === params.status);
    });
  };
  rest.actions = {
    listWorkflowRuns: viaToken("actions.listWorkflowRuns", async (params) => {
      runRequests.push(params);
      if (claudeRunsError) {
        throw claudeRunsError;
      }
      return { data: { total_count: claudeRunsTotal ?? claudeRuns.length, workflow_runs: claudeRuns } };
    }),
    listWorkflowRunsForRepo: viaToken("actions.listWorkflowRunsForRepo", async (params) => {
      headRunRequests.push(params);
      if (headRunsError) {
        throw headRunsError;
      }
      const runs = headRunsFor(params);
      return { data: { total_count: runs.length, workflow_runs: runs } };
    })
  };
  // The PAT client has only the calls GitHub must treat as a person's. Any
  // other property is a read or write that belongs to GITHUB_TOKEN.
  const patOnly = (path, target) => {
    return new Proxy(target, {
      get(object, property) {
        if (property in object || typeof property === "symbol" || property === "then") {
          return object[property];
        }
        clientCall("pat", `${path}.${property}`);
        throw new Error(`${path}.${property} goes through GITHUB_TOKEN, not the PAT`);
      }
    });
  };
  // A PAT method, recorded as the PAT's call.
  const viaPat = (call, method) => {
    return async (...args) => {
      clientCall("pat", call);
      return method(...args);
    };
  };
  const patClient = patOnly("patClient", {
    // The one Copilot review request (mpaulosky/dotfiles#360): GitHub treats a
    // request from a person's token differently from an Actions token's.
    graphql: viaPat("graphql", async (query, variables) => {
      order.push("request");
      requests.push({ query, variables });
      requested = true;
      if (copilotRequest instanceof Error) {
        throw copilotRequest;
      }
      return { requestReviewsByLogin: { clientMutationId: null } };
    }),
    rest: patOnly("patClient.rest", {
      pulls: patOnly("patClient.rest.pulls", {
        merge: viaPat("pulls.merge", async (params) => {
          merges.push(params);
        }),
        updateBranch: viaPat("pulls.updateBranch", async (params) => {
          updates.push(params);
          if (updateError) {
            throw updateError;
          }
        })
      }),
      issues: patOnly("patClient.rest.issues", {
        createComment: viaPat("issues.createComment", async (params) => {
          posted.push(params);
        }),
        // A label added with GITHUB_TOKEN starts no workflow.
        addLabels: viaPat("issues.addLabels", async (params) => {
          addedLabels.push(params);
          if (addLabelError) {
            throw addLabelError;
          }
        })
      }),
      users: patOnly("patClient.rest.users", {
        getAuthenticated: viaPat("users.getAuthenticated", async () => ({ data: { login: poster } }))
      })
    })
  });
  const getOctokit = (token) => {
    patTokens.push(token);
    assert.equal(token, PAT_TOKEN, "getOctokit authenticates with the PAT");
    return patClient;
  };
  const core = {
    info: (message) => logs.push(message),
    notice: (message) => logs.push("notice: " + message),
    warning: (message) => logs.push("warning: " + message),
    setFailed: (message) => logs.push("failed: " + message)
  };
  const context = {
    repo: { owner: OWNER, repo: "demo" },
    payload: workflowRun ? { workflow_run: workflowRun } : push ? { ref: "refs/heads/main" } : { pull_request: { number: 7 } }
  };

  process.env.HAS_RELEASE_PR_PAT = pat ? "true" : "false";
  process.env.PAT_TOKEN = PAT_TOKEN;
  process.env.MERGE_STATE_RETRY_MS = "0";
  process.env.COPILOT_ASK_WAIT_MS = String(askWaitMs);
  process.env.COPILOT_ASK_POLL_MS = String(askPollMs);
  process.env.COPILOT_ASK_REREAD_MS = String(askRereadMs);
  try {
    await run(github, context, core, getOctokit);
  } catch (error) {
    // What the run did before it threw, for tests of a run that ends early.
    error.observed = { updates, reads, logs, order, requests };
    throw error;
  }
  return {
    merges, updates, posted, logs, eventRequests, queries, patTokens, calls, graphqlRequests, rulesRequests, removedLabels,
    addedLabels, listRequests, runRequests, headRunRequests, asked, requests, order
  };
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

test("reads label events with GITHUB_TOKEN, and makes one PAT client a run", async () => {
  const { merges, eventRequests, patTokens, calls } = await evaluate(readyPr());

  assert.equal(merges.length, 1);
  assert.ok(eventRequests.length > 0);
  assert.deepEqual(patTokens, [PAT_TOKEN]);
  assert.ok(calls.some((call) => call.client === "token" && call.call === "issues.listEvents"), JSON.stringify(calls));
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

test("waits when Copilot's only review of the head is its quota note", async () => {
  const { merges, logs } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", { oid: HEAD, note: true }) }));

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of " + HEAD)), logs.join("\n"));
});

// Calling in Claude (mpaulosky/dotfiles#190): Copilot's quota note on the head means no review of it is coming.
const DECLINED = copilotReviewsOf("one", { oid: HEAD, note: true });

test("calls in Claude with the PAT when Copilot's quota note is the head's only review and its checks passed", async () => {
  const { merges, addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED }));

  assert.deepEqual(merges, []);
  assert.deepEqual(addedLabels, [{ owner: OWNER, repo: "demo", issue_number: 7, labels: [CLAUDE_LABEL] }]);
  assert.ok(logs.some((line) => line.includes(`added ${CLAUDE_LABEL} to PR #7`)), logs.join("\n"));
});

test("calls in Claude past Claude Review's own failed checks and this job's own", async () => {
  const pr = readyPr({
    copilotReviews: DECLINED,
    headRef: checksOn(
      HEAD,
      requiredCheck("Build Solution"),
      requiredCheck("Review with Claude", { isRequired: false, conclusion: "FAILURE" }),
      requiredCheck("Merge same-repo PRs when ready", { isRequired: false, conclusion: "FAILURE" })
    )
  });
  const { addedLabels } = await evaluate(pr);

  assert.equal(addedLabels.length, 1);
});

test("calls in Claude while a check that isn't required still runs, whose completion may never start this workflow", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Build Solution"), requiredCheck("CodeQL", { isRequired: false, status: "IN_PROGRESS", conclusion: null }));
  const { addedLabels } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }));

  assert.equal(addedLabels.length, 1);
});

test("doesn't call in Claude while a required check runs, after one failed, or before CI reports", async () => {
  const cases = {
    failed: checksOn(HEAD, requiredCheck("Build Solution"), requiredCheck("Lint", { isRequired: false, conclusion: "FAILURE" })),
    "required not passed": checksOn(HEAD, requiredCheck("Build Solution", { status: "QUEUED", conclusion: null })),
    "no checks yet": checksOn(HEAD)
  };
  for (const [name, headRef] of Object.entries(cases)) {
    const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }));
    assert.deepEqual(addedLabels, [], name);
    assert.ok(logs.some((line) => line.startsWith("Not calling in Claude for PR #7 yet")), `${name}: ${logs.join("\n")}`);
  }
});

test("calls in Claude, with a notice, when no check is required and the head's checks have all settled (mpaulosky/dotfiles#216)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }), requiredCheck("Docs", { isRequired: false }));
  const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [] });

  assert.deepEqual(addedLabels, [{ owner: OWNER, repo: "demo", issue_number: 7, labels: [CLAUDE_LABEL] }]);
  assert.ok(logs.some((line) => line.startsWith("notice: ") && line.includes("no required check")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("Not calling in Claude for PR #7 yet")), logs.join("\n"));
});

test("calls in Claude with no required check when the settled head's only failure is Claude Review's own (mpaulosky/dotfiles#216)", async () => {
  const headRef = checksOn(
    HEAD,
    requiredCheck("Lint", { isRequired: false }),
    requiredCheck("Review with Claude", { isRequired: false, conclusion: "FAILURE" })
  );
  const { addedLabels } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [] });

  assert.equal(addedLabels.length, 1);
});

test("doesn't call in Claude with no required check while a check is still running or one failed (mpaulosky/dotfiles#216)", async () => {
  const cases = {
    "a check running": checksOn(HEAD, requiredCheck("Lint", { isRequired: false }), requiredCheck("Detect Changes", { isRequired: false, status: "IN_PROGRESS", conclusion: null })),
    "a status pending": checksOn(HEAD, requiredCheck("Lint", { isRequired: false }), { __typename: "StatusContext", context: "ci/legacy", state: "PENDING", createdAt: "2026-01-01T00:00:00Z" }),
    "a failed check": checksOn(HEAD, requiredCheck("Lint", { isRequired: false, conclusion: "FAILURE" }))
  };
  for (const [name, headRef] of Object.entries(cases)) {
    const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [] });
    assert.deepEqual(addedLabels, [], name);
    assert.ok(logs.some((line) => line.startsWith("Not calling in Claude for PR #7 yet")), `${name}: ${logs.join("\n")}`);
  }
});

// The notice for a head with no CI check tells the owner to review and merge by hand, and no longer to add the label,
// since Claude's review of such a head never counts (mpaulosky/dotfiles#331).
const NO_CI_ADVICE_TEXT = /review and merge it by hand/;
const NO_CI_ADVICE = {
  test: (line) => NO_CI_ADVICE_TEXT.test(line) && !line.includes(CLAUDE_LABEL) && line.includes("Claude isn't called in")
};

// A head whose only checks are Claude Review's, or this job's own, says nothing of CI (mpaulosky/dotfiles#233).
test("doesn't call in Claude with no required check when the head has only Claude Review's SKIPPED checks (mpaulosky/dotfiles#233)", async () => {
  const skipped = (name) => requiredCheck(name, { isRequired: false, conclusion: "SKIPPED" });
  const cases = {
    "Claude Review's skipped checks": checksOn(HEAD, skipped("Check for a merge from main"), skipped("Review with Claude"), skipped("Post Claude's review")),
    "this job's own check": checksOn(HEAD, requiredCheck("Merge same-repo PRs when ready", { isRequired: false })),
    "Claude Review's checks and this job's own": checksOn(HEAD, skipped("Review with Claude"), requiredCheck("Merge same-repo PRs when ready", { isRequired: false })),
    "no checks at all": checksOn(HEAD)
  };
  for (const [name, headRef] of Object.entries(cases)) {
    const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [] });
    assert.deepEqual(addedLabels, [], name);
    // Every one is a quiet head CI never reported on, which tells the owner (mpaulosky/dotfiles#236).
    assert.ok(logs.some((line) => line.startsWith("notice: PR #7") && line.includes("no CI check")), `${name}: ${logs.join("\n")}`);
    assert.ok(!logs.some((line) => line.includes("no required check") && line.startsWith("notice: ")), `${name}: ${logs.join("\n")}`);
  }
});

// Nothing will start the workflow again for a head CI skips, so the owner is told what to do (mpaulosky/dotfiles#233).
test("tells the owner when a quiet head has no CI check and no workflow run is active, and waits when CI is still running (mpaulosky/dotfiles#233)", async () => {
  const skipped = (name) => requiredCheck(name, { isRequired: false, conclusion: "SKIPPED" });
  const headRef = checksOn(HEAD, skipped("Review with Claude"), requiredCheck("Merge same-repo PRs when ready", { isRequired: false }));
  const pr = readyPr({ copilotReviews: DECLINED, headRef });
  const options = { push: true, requiredChecks: [] };

  const quiet = await evaluate(pr, [], options);
  assert.deepEqual(quiet.addedLabels, []);
  assert.ok(
    quiet.logs.some((line) => line.startsWith("notice: PR #7") && line.includes("no CI check") && NO_CI_ADVICE.test(line)),
    quiet.logs.join("\n")
  );

  // A run still queued may yet create CI's checks: no notice, and still no Claude.
  const running = await evaluate(pr, [], { ...options, headRuns: [{ id: 1, head_sha: HEAD, status: "queued" }] });
  assert.deepEqual(running.addedLabels, []);
  assert.ok(!running.logs.some((line) => line.startsWith("notice: PR #7")), running.logs.join("\n"));
  assert.ok(running.logs.some((line) => line.startsWith("Not calling in Claude for PR #7 yet")), running.logs.join("\n"));
});

// A held run has created no checks yet, so a head with one isn't settled (mpaulosky/dotfiles#236).
const heldCiRun = (shape, overrides = {}) => ({
  id: 3,
  head_sha: HEAD,
  name: "Build and Test Suite",
  path: ".github/workflows/ci.yml",
  ...(shape === "status" ? { status: "action_required", conclusion: null } : { status: "completed", conclusion: "action_required" }),
  ...overrides
});

// A held run gets the notice that asks the owner to approve the PR's workflow runs; the quiet
// "Not calling in Claude yet" info line isn't enough (mpaulosky/dotfiles#238).
function asksForApproval(logs) {
  return logs.some((line) => line.startsWith("notice: PR #7") && /approve the PR's workflow runs/i.test(line));
}

test("doesn't call in Claude with no required check while a CI run for the head is held for approval (mpaulosky/dotfiles#236)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  for (const shape of ["status", "conclusion"]) {
    const headRuns = [{ id: 1, head_sha: HEAD, status: "completed", conclusion: "success" }, heldCiRun(shape)];
    const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [], headRuns });
    assert.deepEqual(addedLabels, [], `held by ${shape}`);
    assert.ok(asksForApproval(logs), `held by ${shape}: ${logs.join("\n")}`);
    assert.ok(!logs.some((line) => line.startsWith("notice: ") && line.includes("no required check")), `held by ${shape}: ${logs.join("\n")}`);
  }
});

test("doesn't tell the owner there is no CI while a CI run for the head is held for approval (mpaulosky/dotfiles#236)", async () => {
  const skipped = (name) => requiredCheck(name, { isRequired: false, conclusion: "SKIPPED" });
  const headRef = checksOn(HEAD, skipped("Review with Claude"), requiredCheck("Merge same-repo PRs when ready", { isRequired: false }));
  for (const shape of ["status", "conclusion"]) {
    const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], {
      push: true,
      requiredChecks: [],
      headRuns: [heldCiRun(shape)]
    });
    assert.deepEqual(addedLabels, [], `held by ${shape}`);
    assert.ok(asksForApproval(logs), `held by ${shape}: ${logs.join("\n")}`);
    assert.ok(!logs.some((line) => line.includes("no CI check")), `held by ${shape}: ${logs.join("\n")}`);
  }
});

test("doesn't hold the PR for a held run that a later run of the same workflow and event has replaced (mpaulosky/dotfiles#238)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  const ci = { path: ".github/workflows/ci.yml", event: "push" };
  const completedRun = (id, overrides = {}) => ({ id, head_sha: HEAD, ...ci, status: "completed", conclusion: "success", ...overrides });
  const evaluateHeadRuns = (headRuns) => evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [], headRuns });
  for (const shape of ["status", "conclusion"]) {
    // A held run followed by a completed run of the same workflow: the PR isn't held, and Claude is called in.
    const replaced = await evaluateHeadRuns([heldCiRun(shape, { id: 3, ...ci }), completedRun(8)]);
    assert.equal(replaced.addedLabels.length, 1, `held by ${shape}: ${replaced.logs.join("\n")}`);
    assert.ok(!asksForApproval(replaced.logs), `held by ${shape}: ${replaced.logs.join("\n")}`);

    // The order of the runs in the response doesn't matter, only their ids.
    const reversed = await evaluateHeadRuns([completedRun(8), heldCiRun(shape, { id: 3, ...ci })]);
    assert.equal(reversed.addedLabels.length, 1, `held by ${shape}: ${reversed.logs.join("\n")}`);

    // A held run that is the newest of its workflow and event still holds the PR.
    const newest = await evaluateHeadRuns([completedRun(2), heldCiRun(shape, { id: 3, ...ci })]);
    assert.deepEqual(newest.addedLabels, [], `held by ${shape}`);
    assert.ok(asksForApproval(newest.logs), `held by ${shape}: ${newest.logs.join("\n")}`);

    // A later run of another workflow doesn't replace it.
    const otherPath = await evaluateHeadRuns([heldCiRun(shape, { id: 3, ...ci }), completedRun(8, { path: ".github/workflows/lint.yml" })]);
    assert.deepEqual(otherPath.addedLabels, [], `held by ${shape}`);
    assert.ok(asksForApproval(otherPath.logs), `held by ${shape}: ${otherPath.logs.join("\n")}`);

    // Nor does a later run of the same workflow for another event.
    const otherEvent = await evaluateHeadRuns([heldCiRun(shape, { id: 3, ...ci }), completedRun(8, { event: "pull_request" })]);
    assert.deepEqual(otherEvent.addedLabels, [], `held by ${shape}`);
    assert.ok(asksForApproval(otherEvent.logs), `held by ${shape}: ${otherEvent.logs.join("\n")}`);

    // A later run that never ran CI doesn't replace it: the PR stays held and the owner is asked to approve.
    for (const conclusion of ["skipped", "cancelled", "startup_failure"]) {
      const neverRan = await evaluateHeadRuns([heldCiRun(shape, { id: 3, ...ci }), completedRun(8, { conclusion })]);
      assert.deepEqual(neverRan.addedLabels, [], `held by ${shape}, later run ${conclusion}`);
      assert.ok(asksForApproval(neverRan.logs), `held by ${shape}, later run ${conclusion}: ${neverRan.logs.join("\n")}`);
    }

    // A replacing run that is itself held still holds the PR.
    const stillHeld = await evaluateHeadRuns([heldCiRun(shape, { id: 3, ...ci }), heldCiRun(shape, { id: 8, ...ci })]);
    assert.deepEqual(stillHeld.addedLabels, [], `held by ${shape}`);
    assert.ok(asksForApproval(stillHeld.logs), `held by ${shape}: ${stillHeld.logs.join("\n")}`);
  }
});

test("doesn't count PR Review Submitted's, Claude Review's or this job's own held runs as held CI (mpaulosky/dotfiles#236)", async () => {
  const ownRuns = (shape) => [
    heldCiRun(shape, { id: 4, name: "PR Review Submitted", path: ".github/workflows/pr-review-submitted.yml" }),
    heldCiRun(shape, { id: 5, name: "Claude Review", path: ".github/workflows/claude-review.yml" }),
    heldCiRun(shape, { id: 6, name: "PR Auto-Merge", path: ".github/workflows/pr-automerge.yml" })
  ];
  const settled = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  const quiet = checksOn(HEAD, requiredCheck("Review with Claude", { isRequired: false, conclusion: "SKIPPED" }));
  for (const shape of ["status", "conclusion"]) {
    // CI has reported: the held runs of those workflows don't hold Claude back.
    const called = await evaluate(readyPr({ copilotReviews: DECLINED, headRef: settled }), [], {
      push: true,
      requiredChecks: [],
      headRuns: ownRuns(shape)
    });
    assert.equal(called.addedLabels.length, 1, `held by ${shape}: ${called.logs.join("\n")}`);

    // CI has not: the owner is still told there is no CI.
    const told = await evaluate(readyPr({ copilotReviews: DECLINED, headRef: quiet }), [], {
      push: true,
      requiredChecks: [],
      headRuns: ownRuns(shape)
    });
    assert.deepEqual(told.addedLabels, [], `held by ${shape}`);
    assert.ok(told.logs.some((line) => line.startsWith("notice: PR #7") && line.includes("no CI check")), `held by ${shape}: ${told.logs.join("\n")}`);
  }
});

// GraphQL returns a null statusCheckRollup for a head no check has reported on, as for one pushed with GITHUB_TOKEN (mpaulosky/dotfiles#236).
test("tells the owner when a head has no status check rollup and no workflow run is active, outside a PR event (mpaulosky/dotfiles#236)", async () => {
  const noRollup = { target: { oid: HEAD, statusCheckRollup: null } };
  const pr = readyPr({ copilotReviews: DECLINED, headRef: noRollup });
  const options = { push: true, requiredChecks: [] };

  const quiet = await evaluate(pr, [], options);
  assert.deepEqual(quiet.addedLabels, []);
  assert.ok(
    quiet.logs.some((line) => line.startsWith("notice: PR #7") && line.includes("no CI check") && NO_CI_ADVICE.test(line)),
    quiet.logs.join("\n")
  );
  assert.ok(quiet.headRunRequests.length > 0 && quiet.headRunRequests.every((params) => params.head_sha === HEAD), "the runs check");

  // Completed runs are not active runs.
  const done = await evaluate(pr, [], { ...options, headRuns: [{ id: 1, head_sha: HEAD, status: "completed", conclusion: "skipped" }] });
  assert.ok(done.logs.some((line) => line.startsWith("notice: PR #7") && line.includes("no CI check")), done.logs.join("\n"));

  // A run still active may yet create checks: no notice, and no Claude.
  const running = await evaluate(pr, [], { ...options, headRuns: [{ id: 1, head_sha: HEAD, status: "queued" }] });
  assert.deepEqual(running.addedLabels, []);
  assert.ok(!running.logs.some((line) => line.startsWith("notice: PR #7")), running.logs.join("\n"));

  // A held run is waiting for approval, not absent.
  for (const shape of ["status", "conclusion"]) {
    const held = await evaluate(pr, [], { ...options, headRuns: [heldCiRun(shape)] });
    assert.deepEqual(held.addedLabels, [], `held by ${shape}`);
    assert.ok(asksForApproval(held.logs), `held by ${shape}: ${held.logs.join("\n")}`);
    assert.ok(!held.logs.some((line) => line.includes("no CI check")), `held by ${shape}: ${held.logs.join("\n")}`);
  }

  // On a PR event CI may not have started yet: no notice.
  const onPr = await evaluate(pr, [], { requiredChecks: [] });
  assert.deepEqual(onPr.addedLabels, []);
  assert.ok(!onPr.logs.some((line) => line.includes("no CI check")), onPr.logs.join("\n"));
});

test("calls in Claude with no required check once a check outside Claude Review's and this job's own has finished (mpaulosky/dotfiles#233)", async () => {
  const headRef = checksOn(
    HEAD,
    requiredCheck("Review with Claude", { isRequired: false, conclusion: "SKIPPED" }),
    requiredCheck("Merge same-repo PRs when ready", { isRequired: false }),
    requiredCheck("Lint", { isRequired: false, conclusion: "SKIPPED" })
  );
  const { addedLabels } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [] });

  assert.equal(addedLabels.length, 1);
});

test("doesn't call in Claude with no required check while a workflow run for the head is queued, waiting or in progress (mpaulosky/dotfiles#233)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  for (const status of ["requested", "queued", "pending", "waiting", "in_progress"]) {
    const headRuns = [{ id: 1, head_sha: HEAD, status: "completed", conclusion: "success" }, { id: 2, head_sha: HEAD, status }];
    const { addedLabels, logs, headRunRequests } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], {
      push: true,
      requiredChecks: [],
      headRuns
    });
    assert.deepEqual(addedLabels, [], status);
    assert.ok(logs.some((line) => line.startsWith("Not calling in Claude for PR #7 yet")), `${status}: ${logs.join("\n")}`);
    assert.ok(headRunRequests.length > 0 && headRunRequests.every((params) => params.head_sha === HEAD), status);
  }
});

test("calls in Claude with no required check when the head's workflow runs have all completed, or a run is for another head (mpaulosky/dotfiles#233)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  const headRuns = [
    { id: 1, head_sha: HEAD, status: "completed", conclusion: "success" },
    { id: 2, head_sha: HEAD, status: "completed", conclusion: "skipped" },
    { id: 3, head_sha: "older", status: "in_progress" }
  ];
  const { addedLabels } = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [], headRuns });

  assert.equal(addedLabels.length, 1);
});

// A run's checks can land between the snapshot and the runs read (mpaulosky/dotfiles#233).
test("doesn't call in Claude with no required check when the head's checks changed while its workflow runs were read (mpaulosky/dotfiles#233)", async () => {
  const lint = (overrides) => requiredCheck("Lint", { isRequired: false, ...overrides });
  const before = readyPr({ copilotReviews: DECLINED, headRef: checksOn(HEAD, lint({ databaseId: 1 })) });
  // The run finished, failing, after the first snapshot: its check run is new.
  const after = readyPr({
    copilotReviews: DECLINED,
    headRef: checksOn(HEAD, lint({ databaseId: 1 }), requiredCheck("Test", { isRequired: false, conclusion: "FAILURE", databaseId: 2 }))
  });
  const options = { push: true, requiredChecks: [] };

  // Control: the same snapshot every time settles.
  const steady = await evaluate([before], [], options);
  assert.equal(steady.addedLabels.length, 1, steady.logs.join("\n"));

  // The third read, made after the runs, sees the new check: the head isn't settled, so the label stays off.
  const changed = await evaluate([before, before, after], [], options);
  assert.deepEqual(changed.addedLabels, [], changed.logs.join("\n"));
});

// The runs read fails: not settled (mpaulosky/dotfiles#233).
test("doesn't call in Claude with no required check when the head's workflow runs can't be read (mpaulosky/dotfiles#233)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  const pr = readyPr({ copilotReviews: DECLINED, headRef });
  const headRunsError = Object.assign(new Error("Server Error"), { status: 500 });

  const { addedLabels, logs } = await evaluate(pr, [], { push: true, requiredChecks: [], headRunsError });
  assert.deepEqual(addedLabels, []);
  assert.ok(logs.some((line) => line.startsWith(`warning: Couldn't read the workflow runs for ${HEAD} on PR #7: Server Error`)), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("failed: ")), logs.join("\n"));

  // On a workflow_run event too: a warning, not a failed run.
  const onRun = await evaluate(pr, [], { workflowRun: { head_sha: HEAD, pull_requests: [{ number: 7 }] }, requiredChecks: [], headRunsError });
  assert.deepEqual(onRun.addedLabels, []);
  assert.ok(!onRun.logs.some((line) => line.startsWith("failed: ")), onRun.logs.join("\n"));
});

test("a sweep stops when reading the head's workflow runs hits a rate limit (mpaulosky/dotfiles#233)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  const pr = readyPr({ copilotReviews: DECLINED, headRef });
  const headRunsError = Object.assign(new Error("Too many requests"), { status: 429 });
  const thrown = await evaluate(pr, [], { push: true, openPrs: [7], requiredChecks: [], headRunsError }).then(() => null, (e) => e);

  assert.equal(thrown, headRunsError);
});

// The notice follows the decision (mpaulosky/dotfiles#233): it says Claude is called in, so it comes after addLabels succeeds.
test("logs the no-required-check notice only once review:claude is added (mpaulosky/dotfiles#233)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  const pr = readyPr({ copilotReviews: DECLINED, headRef });
  const noticed = (logs) => logs.some((line) => line.startsWith("notice: ") && line.includes("no required check"));
  const options = { push: true, requiredChecks: [] };

  const added = await evaluate(pr, [], options);
  assert.equal(added.addedLabels.length, 1);
  assert.ok(noticed(added.logs), added.logs.join("\n"));

  // addLabels fails.
  const failed = await evaluate(pr, [], { ...options, addLabelError: Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 }) });
  assert.ok(failed.logs.some((line) => line.startsWith(`warning: Couldn't add ${CLAUDE_LABEL} to PR #7`)), failed.logs.join("\n"));
  assert.ok(!noticed(failed.logs), failed.logs.join("\n"));

  // No PAT, so nothing is added.
  const noPat = await evaluate(pr, [], { ...options, pat: false });
  assert.deepEqual(noPat.addedLabels, []);
  assert.ok(!noticed(noPat.logs), noPat.logs.join("\n"));
});

test("with no required check, doesn't log the notice when a person took review:claude off (mpaulosky/dotfiles#233)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Lint", { isRequired: false }));
  const pr = readyPr({ copilotReviews: DECLINED, headRef });
  const events = [labeledEvent(CLAUDE_LABEL, "octo"), unlabeledEvent(CLAUDE_LABEL, "octo")];
  const { addedLabels, logs } = await evaluate(pr, events, { push: true, requiredChecks: [] });

  assert.deepEqual(addedLabels, []);
  assert.ok(logs.some((line) => line.startsWith("notice: PR #7") && line.includes(`@octo took ${CLAUDE_LABEL} off`)), logs.join("\n"));
  assert.ok(!logs.some((line) => line.includes("no required check")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.includes("called in")), logs.join("\n"));
});

test("doesn't call in Claude for a head with a merge conflict, as landing.decide blocks on it", async () => {
  for (const conflict of [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, { mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }]) {
    const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, ...conflict }));
    assert.deepEqual(addedLabels, []);
    assert.ok(logs.some((line) => line.includes("it has a merge conflict with main")), logs.join("\n"));
  }
});

test("doesn't call in Claude while Copilot's request for the head is pending, whatever it reviewed or noted before", async () => {
  for (const copilotReviews of [copilotReviewsOf("one"), copilotReviewsOf({ oid: "one", note: true })]) {
    const { addedLabels } = await evaluate(readyPr({ copilotReviews, reviewRequests: COPILOT_PENDING }));
    assert.deepEqual(addedLabels, []);
  }
});

test("doesn't add review:claude when it's already on", async () => {
  const { addedLabels } = await evaluate(readyPr({ copilotReviews: DECLINED, labels: labelled(CLAUDE_LABEL) }));

  assert.deepEqual(addedLabels, []);
});

test("says so when review:claude is on but Claude Review won't review the head (mpaulosky/dotfiles#209)", async () => {
  const labelledAt = "2026-10-18T10:00:00Z";
  const events = [{ ...labeledEvent(CLAUDE_LABEL, "octo"), created_at: labelledAt }];
  const run = (login, conclusion, createdAt = "2026-10-18T11:00:00Z", status = "completed", rerunBy = login) => ({
    status, conclusion, created_at: createdAt, actor: { login }, triggering_actor: { login: rerunBy }
  });
  const pr = readyPr({ copilotReviews: DECLINED, labels: labelled(CLAUDE_LABEL) });
  const notices = (logs) => logs.filter((line) => line.startsWith("notice: PR #7") && line.includes("Claude Review won't"));
  const check = async (why, claudeRuns, expected, options = {}) => {
    const { addedLabels, logs, runRequests } = await evaluate(options.pr ?? pr, options.events ?? events, { claudeRuns, ...options });
    assert.deepEqual(addedLabels, [], why);
    assert.equal(notices(logs).length, expected ? 1 : 0, `${why}\n${logs.join("\n")}`);
    return { logs, runRequests };
  };

  // No review is coming: a Copilot push held for approval, or a skip of a push by a bot or Copilot, since the label.
  const held = await check("a Copilot push held for approval", [run("Copilot", "action_required")], true);
  assert.deepEqual(held.runRequests.map(({ workflow_id, head_sha }) => ({ workflow_id, head_sha })),
    [{ workflow_id: "claude-review.yml", head_sha: HEAD }]);
  await check("a held run reported by its status", [run("Copilot", null, undefined, "action_required")], true);
  await check("an app's push skipped", [run("renovate[bot]", "skipped"), run("octo", "skipped", "2026-10-18T09:00:00Z")], true);
  await check("Copilot's push skipped", [run("Copilot", "skipped")], true);
  // A person's re-run of a bot's skipped run skips again: Claude Review goes by the original actor.
  await check("a person's re-run of a bot's skip", [run("renovate[bot]", "skipped", undefined, "completed", "octo")], true);
  // A bot adding the label starts a run in the same second as the label event.
  await check("a bot's skip in the label's second", [run("renovate[bot]", "skipped", labelledAt)], true);
  // With no labeled event read, every skip counts; with several, the last one does.
  await check("no labeled event", [run("renovate[bot]", "skipped", "2026-10-18T09:00:00Z")], true, { events: [] });
  await check("relabelled after the bot's push", [run("renovate[bot]", "skipped")], false, {
    events: [
      { ...labeledEvent(CLAUDE_LABEL, "octo"), created_at: "2026-10-18T08:00:00Z" },
      { ...unlabeledEvent(CLAUDE_LABEL, "octo"), created_at: "2026-10-18T09:00:00Z" },
      { ...labeledEvent(CLAUDE_LABEL, "octo"), created_at: "2026-10-18T12:00:00Z" }
    ]
  });

  // A review may still come.
  await check("a person's skip (another label, a draft)", [run("octo", "skipped")], false);
  await check("a bot's skip from before the label", [run("renovate[bot]", "skipped", "2026-10-18T09:00:00Z")], false);
  await check("one run still going", [run("renovate[bot]", "skipped"), run("octo", null, undefined, "in_progress")], false);
  await check("one run done", [run("renovate[bot]", "skipped"), run("octo", "success")], false);
  await check("no run yet, or a GITHUB_TOKEN push", [], false);
  await check("more runs than one page", [run("renovate[bot]", "skipped")], false, { claudeRunsTotal: 101 });

  // A failed read is a warning on a PR event, never a failed check.
  // This one's label-events read is the PR's third: the two before it are other checks', which would fail first.
  const ownWarning = (logs) => logs.some((line) => line.startsWith("warning: Couldn't tell whether Claude Review will review"));
  for (const [why, claudeRuns, options] of [
    ["a failed runs read", [], { claudeRunsError: Object.assign(new Error("Server Error"), { status: 500 }) }],
    ["a failed events read", [run("renovate[bot]", "skipped")], { eventsError: Object.assign(new Error("Server Error"), { status: 500 }), eventsErrorAt: 3 }]
  ]) {
    const { logs, runRequests } = await check(why, claudeRuns, false, options);
    assert.equal(runRequests.length, 1, why);
    assert.ok(ownWarning(logs), `${why}\n${logs.join("\n")}`);
    assert.ok(!logs.some((line) => line.startsWith("failed: ")), `${why}\n${logs.join("\n")}`);
  }

  // Dependabot's PR gets the by-hand notice, and its runs aren't read: Claude Review skips it whoever pushes.
  const dependabot = await check("Dependabot's PR", [run("dependabot[bot]", "skipped")], false, {
    pr: readyPr({ copilotReviews: DECLINED, labels: labelled(CLAUDE_LABEL), author: { login: "dependabot[bot]" } })
  });
  assert.deepEqual(dependabot.runRequests, []);
  assert.ok(dependabot.logs.some((line) => line.startsWith("notice: PR #7") && line.includes("by hand")), dependabot.logs.join("\n"));
});

test("a sweep stops when reading Claude Review's runs hits a rate limit (mpaulosky/dotfiles#209)", async () => {
  const pr = readyPr({ copilotReviews: DECLINED, labels: labelled(CLAUDE_LABEL) });
  const claudeRunsError = Object.assign(new Error("Too many requests"), { status: 429 });
  const thrown = await evaluate(pr, [], { push: true, openPrs: [7], claudeRunsError }).then(() => null, (e) => e);

  assert.equal(thrown, claudeRunsError);
});

test("stops calling in Claude after MAX_CLAUDE_ROUNDS of its reviews, and leaves it to the owner", async () => {
  // Three commits Claude reviewed, two of them merges, which the cap doesn't count.
  const merges = [{ oid: "m1", merge: true }, { oid: "m2", merge: true }];
  const pr = readyPr({ copilotReviews: DECLINED, claudeReviews: claudeReviewsOf("one", ...merges) });
  const { addedLabels, logs } = await evaluate(pr);

  assert.deepEqual(addedLabels, []);
  // A notice, so the stalled PR shows on the run, not only in its log (mpaulosky/dotfiles#199).
  assert.ok(logs.some((line) => line.startsWith("notice: PR #7") && line.includes("the owner decides")), logs.join("\n"));
  // Two rounds are under the limit (mpaulosky/dotfiles#193).
  const twice = await evaluate(readyPr({ copilotReviews: DECLINED, claudeReviews: claudeReviewsOf("one", "m1") }));
  assert.equal(twice.addedLabels.length, 1);
});

test("doesn't put review:claude back after a person took it off, but does after the cap removal", async () => {
  const pr = readyPr({ copilotReviews: DECLINED });
  const byPerson = await evaluate(pr, [labeledEvent(CLAUDE_LABEL, "octo"), unlabeledEvent(CLAUDE_LABEL, "octo")]);
  assert.deepEqual(byPerson.addedLabels, []);
  // A notice, so the stalled PR shows on the run, not only in its log (mpaulosky/dotfiles#215).
  assert.ok(
    byPerson.logs.some((line) => {
      return line.startsWith("notice: PR #7") && line.includes("Copilot couldn't review") &&
        line.includes(`@octo took ${CLAUDE_LABEL} off`) && line.includes("by hand");
    }),
    byPerson.logs.join("\n")
  );

  const byWorkflow = await evaluate(pr, [unlabeledEvent(CLAUDE_LABEL, "github-actions[bot]")]);
  assert.equal(byWorkflow.addedLabels.length, 1);
  assert.ok(!byWorkflow.logs.some((line) => line.includes("took")), byWorkflow.logs.join("\n"));
  // Added again by a person since: the latest change counts.
  const readded = await evaluate(pr, [unlabeledEvent(CLAUDE_LABEL, "octo"), labeledEvent(CLAUDE_LABEL, "octo")]);
  assert.equal(readded.addedLabels.length, 1);
});

test("without the PAT, says to add review:claude by hand instead of adding it with GITHUB_TOKEN", async () => {
  const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED }), [], { pat: false });

  assert.deepEqual(addedLabels, []);
  assert.ok(logs.some((line) => line.startsWith("notice: PR #7") && line.includes("by hand")), logs.join("\n"));
});

test("a failure to add review:claude is a warning on a PR event, never a failed check", async () => {
  const { logs } = await evaluate(readyPr({ copilotReviews: DECLINED }), [], {
    addLabelError: Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 })
  });

  assert.ok(logs.some((line) => line.startsWith(`warning: Couldn't add ${CLAUDE_LABEL} to PR #7`)), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("failed:")), logs.join("\n"));
});

test("doesn't call in Claude for a draft, a handed-back PR or one past the cap", async () => {
  const draft = await evaluate(readyPr({ copilotReviews: DECLINED, isDraft: true }));
  assert.deepEqual(draft.addedLabels, []);
  const handedBack = await evaluate(readyPr({ copilotReviews: DECLINED, labels: labelled(NEEDS_HUMAN) }));
  assert.deepEqual(handedBack.addedLabels, []);
  const capped = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three", { oid: HEAD, note: true }) }));
  assert.deepEqual(capped.addedLabels, []);
});

test("doesn't call in Claude for Dependabot's PR, which Claude Review never reviews (mpaulosky/dotfiles#201)", async () => {
  for (const login of ["dependabot", "dependabot[bot]"]) {
    const { addedLabels, logs } = await evaluate(readyPr({ copilotReviews: DECLINED, author: { login } }));
    assert.deepEqual(addedLabels, [], login);
    // A notice: no review of this head is coming, so the owner reviews and merges it.
    assert.ok(logs.some((line) => line.startsWith("notice: PR #7") && line.includes("by hand")), logs.join("\n"));
  }
});

test("doesn't count Copilot's quota notes toward the review cap", async () => {
  const reviews = copilotReviewsOf("one", { oid: "two", note: true }, { oid: "three", note: true });
  const { merges } = await evaluate(readyPr({ copilotReviews: reviews }));

  assert.deepEqual(merges, []);
});

test("merges on Claude's review of the head when Copilot only posted its quota note", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf({ oid: HEAD, note: true }),
    claudeReviews: claudeReviewsOf(HEAD),
    labels: labelled(CLAUDE_LABEL)
  });
  const { merges } = await evaluate(pr);

  assert.equal(merges.length, 1);
});

// ── Ask Copilot once per PR, then fall back to Claude (mpaulosky/dotfiles#360) ──
// PR Auto-Merge asks for Copilot's review of a PR's first reviewable head once,
// records the ask in a PR comment, and reads back whether the request registered.
// A request that fails or doesn't register, or is answered with the quota note,
// brings review:claude in at once; a record 30 seconds old with nothing pending
// does the same. Copilot isn't asked again for the PR. This replaces #318's grace.
const COPILOT_PENDING = {
  totalCount: 1,
  nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }]
};
const COPILOT_ASKED_MARKER = "<!-- pr-automerge:copilot-asked -->";
const LABEL_FOR_CLAUDE = [{ owner: OWNER, repo: "demo", issue_number: 7, labels: ["review:claude"] }];

// The record that Copilot was asked, as the comments query reports it: posted by login, ageSeconds ago.
function askedBy(login, ageSeconds, body = "PR Auto-Merge asked Copilot to review this PR.\n\n" + COPILOT_ASKED_MARKER) {
  return { author: login === null ? null : { login }, body, createdAt: new Date(Date.now() - ageSeconds * 1000).toISOString() };
}

function commentsOf(...nodes) {
  return { totalCount: nodes.length, nodes };
}

// A head Copilot hasn't reviewed (it reviewed an earlier commit only), whose checks passed.
const unreviewed = { copilotReviews: copilotReviewsOf("one") };
// Claude's review of the head, with review:claude on and no quota note from Copilot.
const claudeOnly = () => ({ copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf(HEAD), labels: labelled(CLAUDE_LABEL), quotaNotes: false });
const noAsk = ({ asked, requests }, scenario) => {
  assert.deepEqual(asked, [], `${scenario}: no record comment`);
  assert.deepEqual(requests, [], `${scenario}: no Copilot request`);
};

test("asks Copilot once for an unreviewed head: a record comment from GITHUB_TOKEN, then one request from the PAT, then a read-back (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr(unreviewed));

  assert.equal(result.asked.length, 1);
  assert.equal(result.asked[0].owner, OWNER);
  assert.equal(result.asked[0].repo, "demo");
  assert.equal(result.asked[0].issue_number, 7);
  assert.ok(result.asked[0].body.includes(COPILOT_ASKED_MARKER), result.asked[0].body);
  assert.equal(result.requests.length, 1);
  assert.match(result.requests[0].query, /requestReviewsByLogin/);
  assert.match(result.requests[0].query, /copilot-pull-request-reviewer\[bot\]/);
  assert.match(result.requests[0].query, /union:\s*true/);
  assert.equal(result.requests[0].variables.pullRequestId, PR_NODE_ID);
  assert.ok(result.calls.some(({ client, call }) => client === "token" && call === "issues.createComment"), JSON.stringify(result.calls));
  assert.ok(result.calls.some(({ client, call }) => client === "pat" && call === "graphql"), JSON.stringify(result.calls));
  // The record is written before the request, so a crash between them can't make a second ask; the read-back follows.
  const record = result.order.indexOf("record");
  const request = result.order.indexOf("request");
  assert.ok(record !== -1 && record < request, result.order.join(","));
  assert.ok(result.order.indexOf("read-back") > request, result.order.join(","));
});

test("adds review:claude in the same run when the request reads back as dropped, without waiting 30 seconds (mpaulosky/dotfiles#360)", async () => {
  const { merges, addedLabels, logs, requests } = await evaluate(readyPr(unreviewed));

  assert.equal(requests.length, 1);
  assert.deepEqual(merges, []);
  assert.deepEqual(addedLabels, LABEL_FOR_CLAUDE);
  assert.ok(logs.some((line) => line.includes("didn't register")), logs.join("\n"));
  assert.ok(logs.some((line) => line.includes(`added ${CLAUDE_LABEL} to PR #7`) && line.includes("a request that didn't register")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.includes("no review and no request pending")), "the old wording is gone");
});

test("keeps waiting when the request registers: no label, no merge, no second request (mpaulosky/dotfiles#360)", async () => {
  const { merges, addedLabels, requests, asked, logs } = await evaluate(readyPr(unreviewed), [], { copilotRequest: "registers" });

  assert.deepEqual(addedLabels, []);
  assert.deepEqual(merges, []);
  assert.equal(requests.length, 1);
  assert.equal(asked.length, 1);
  assert.ok(logs.some((line) => line.includes("registered")), logs.join("\n"));
});

test("adds review:claude when Copilot answers the request with its quota note (mpaulosky/dotfiles#360)", async () => {
  const { addedLabels, requests, merges } = await evaluate(readyPr(unreviewed), [], { copilotRequest: "quota-note" });

  assert.equal(requests.length, 1);
  assert.deepEqual(addedLabels, LABEL_FOR_CLAUDE);
  assert.deepEqual(merges, []);
});

test("reads the request back until it registers, within the window (mpaulosky/dotfiles#360)", async () => {
  const { addedLabels, merges, requests, order } = await evaluate(readyPr(unreviewed), [], {
    copilotRequest: "registers",
    registersAfterReads: 2,
    askWaitMs: 2000,
    askPollMs: 5
  });

  assert.deepEqual(addedLabels, []);
  assert.deepEqual(merges, []);
  assert.equal(requests.length, 1);
  assert.ok(order.filter((step) => step === "read-back").length >= 3, order.join(","));
});

test("reads a dropped request back for the whole window before calling in Claude (mpaulosky/dotfiles#360)", async () => {
  const started = Date.now();
  const { addedLabels, order } = await evaluate(readyPr(unreviewed), [], { askWaitMs: 80, askPollMs: 10 });

  assert.deepEqual(addedLabels, LABEL_FOR_CLAUDE);
  assert.ok(Date.now() - started >= 60, `the run took ${Date.now() - started} ms`);
  assert.ok(order.filter((step) => step === "read-back").length >= 2, order.join(","));
});

test("adds review:claude at once when the request fails, without waiting out the window (mpaulosky/dotfiles#360)", async () => {
  const started = Date.now();
  const { addedLabels, requests, logs } = await evaluate(readyPr(unreviewed), [], {
    copilotRequest: Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 }),
    askWaitMs: 4000,
    askPollMs: 1000
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(addedLabels, LABEL_FOR_CLAUDE);
  assert.ok(logs.some((line) => line.startsWith("warning: ") && line.includes("Resource not accessible")), logs.join("\n"));
  assert.ok(Date.now() - started < 2000, `the run took ${Date.now() - started} ms`);
});

test("makes no request and adds no label when the record comment can't be posted (mpaulosky/dotfiles#360)", async () => {
  const { addedLabels, requests, merges, logs } = await evaluate(readyPr(unreviewed), [], {
    askCommentError: Object.assign(new Error("Resource not accessible by integration"), { status: 403 })
  });

  assert.deepEqual(requests, []);
  assert.deepEqual(addedLabels, []);
  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.startsWith("warning: ") && line.includes("Resource not accessible")), logs.join("\n"));
});

test("a record 31 seconds old with nothing pending adds review:claude with no ask, and one 29 seconds old waits (mpaulosky/dotfiles#360)", async () => {
  const settled = await evaluate(readyPr({ ...unreviewed, comments: commentsOf(askedBy(ACTIONS, 31)) }));
  noAsk(settled, "a settled record");
  assert.deepEqual(settled.addedLabels, LABEL_FOR_CLAUDE);

  const fresh = await evaluate(readyPr({ ...unreviewed, comments: commentsOf(askedBy(ACTIONS, 29)) }));
  noAsk(fresh, "a record 29 seconds old");
  assert.deepEqual(fresh.addedLabels, []);
  assert.ok(fresh.logs.some((line) => line.startsWith("Not calling in Claude for PR #7 yet")), fresh.logs.join("\n"));
});

test("a record with Copilot's request pending keeps waiting however old it is (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ ...unreviewed, reviewRequests: COPILOT_PENDING, comments: commentsOf(askedBy(ACTIONS, 3600)) }));

  noAsk(result, "a pending request");
  assert.deepEqual(result.addedLabels, []);
  assert.deepEqual(result.merges, []);
});

test("the settle time is 30 seconds, and the 5-minute grace and its timeline query are gone (mpaulosky/dotfiles#360)", () => {
  const source = readFileSync(WORKFLOW, "utf8");

  assert.match(source, /const COPILOT_ASK_SETTLE_MS = 30 \* 1000;/);
  assert.match(source, /const COPILOT_ASKED_MARKER = "<!-- pr-automerge:copilot-asked -->";/);
  assert.ok(!/COPILOT_GRACE_MS/.test(source), "COPILOT_GRACE_MS is gone");
  assert.ok(!/\bgraceState\b/.test(source), "graceState is gone");
  assert.ok(!/reviewableEvents|READY_FOR_REVIEW_EVENT/.test(source), "the reviewable-events query is gone");
  assert.ok(!/5-minute grace/.test(source), "the 5-minute grace wording is gone");
});

// Many events start a run for one PR within seconds, and the workflow has no
// concurrency group, so two runs can both read "no record", both post one and
// both request. Each run re-reads the comments after posting its record and
// only the run whose record is listed first makes the request (mpaulosky/dotfiles#369).
test("doesn't request Copilot's review when a second run's record is earlier than its own (mpaulosky/dotfiles#369)", async () => {
  const { asked, requests, addedLabels, merges, order } = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: -50 });

  assert.equal(asked.length, 1, "it still posts its record: the read before it showed none");
  assert.deepEqual(requests, [], "the earlier run makes the request");
  assert.deepEqual(addedLabels, [], "the earlier run reads the request back and calls in Claude");
  assert.deepEqual(merges, []);
  assert.ok(!order.includes("request"), order.join(","));
});

test("requests Copilot's review once when a second run's record is later than its own (mpaulosky/dotfiles#369)", async () => {
  const { asked, requests, addedLabels } = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: 50 });

  assert.equal(asked.length, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(addedLabels, LABEL_FOR_CLAUDE);
});

test("re-reads the PR after posting its record and before it requests (mpaulosky/dotfiles#369)", async () => {
  const { order } = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: 50 });
  const record = order.indexOf("record");
  const request = order.indexOf("request");
  const reRead = order.indexOf("re-read");

  assert.ok(record !== -1 && request !== -1, order.join(","));
  assert.ok(reRead > record && reRead < request, order.join(","));
});

test("an earlier record from someone else doesn't make the run stand down: only github-actions' and the owner's records count (mpaulosky/dotfiles#369)", async () => {
  const { asked, requests } = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: -50, rivalLogin: "stranger" });

  assert.equal(asked.length, 1);
  assert.equal(requests.length, 1);
});

test("an earlier record from the owner makes the run stand down too (mpaulosky/dotfiles#369)", async () => {
  const { requests, addedLabels } = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: -50, rivalLogin: OWNER });

  assert.deepEqual(requests, []);
  assert.deepEqual(addedLabels, []);
});

test("the losing run in a sweep asks nothing more of Copilot and its second pass over the PR adds no request (mpaulosky/dotfiles#369)", async () => {
  const { asked, requests } = await evaluate(readyPr(unreviewed), [], { push: true, openPrs: [7, 7], rivalOffsetMs: -50 });

  assert.equal(asked.length, 1);
  assert.deepEqual(requests, []);
});

test("retries the re-read when its own record doesn't show yet and requests once it does (mpaulosky/dotfiles#369)", async () => {
  const { requests, order } = await evaluate(readyPr(unreviewed), [], { ownRecordHiddenReads: 1 });

  assert.equal(requests.length, 1);
  assert.equal(order.filter((step) => step === "re-read").length, 2, order.join(","));
});

test("retries the re-read when it throws and requests once a read works (mpaulosky/dotfiles#369)", async () => {
  const { requests, order } = await evaluate(readyPr(unreviewed), [], { reReadErrors: 1 });

  assert.equal(requests.length, 1);
  assert.equal(order.filter((step) => step === "re-read").length, 2, order.join(","));
});

test("makes no request when its own record never shows in the re-reads, and says so (mpaulosky/dotfiles#369)", async () => {
  const { asked, requests, order, logs } = await evaluate(readyPr(unreviewed), [], { ownRecordHiddenReads: 3 });

  assert.equal(asked.length, 1, "the record stays");
  assert.deepEqual(requests, []);
  assert.equal(order.filter((step) => step === "re-read").length, 3, order.join(","));
  assert.ok(logs.some((line) => /Couldn't find this run's record of the ask/.test(line)), logs.join("\n"));
});

test("makes no request when every re-read throws, and says so (mpaulosky/dotfiles#369)", async () => {
  const { asked, requests, logs } = await evaluate(readyPr(unreviewed), [], { reReadErrors: 3 });

  assert.equal(asked.length, 1, "the record stays");
  assert.deepEqual(requests, []);
  assert.ok(logs.some((line) => /Couldn't re-read PR #7 after recording the ask/.test(line)), logs.join("\n"));
});

// An error that ends a run: a 429 (rate limit) or a 401 (bad token).
const endsRunWith = (status) => Object.assign(new Error(status === 429 ? "Rate limited" : "Bad credentials"), { status });

for (const status of [429, 401]) {
  test(`a sweep whose re-read fails with a ${status} ends the run at once: no retry and no request (mpaulosky/dotfiles#369)`, async () => {
    await assert.rejects(
      () => evaluate(readyPr(unreviewed), [], { push: true, reReadErrors: 3, reReadError: endsRunWith(status) }),
      (error) => {
        assert.equal(error.status, status);
        assert.deepEqual(error.observed.requests, []);
        assert.equal(error.observed.order.filter((step) => step === "re-read").length, 1, error.observed.order.join(","));
        return true;
      }
    );
  });

  test(`a PR event whose re-read fails with a ${status} doesn't retry it, makes no request and warns (mpaulosky/dotfiles#369)`, async () => {
    const { asked, requests, order, logs } = await evaluate(readyPr(unreviewed), [], { reReadErrors: 3, reReadError: endsRunWith(status) });

    assert.equal(asked.length, 1, "the record stays");
    assert.deepEqual(requests, []);
    assert.equal(order.filter((step) => step === "re-read").length, 1, order.join(","));
    assert.ok(logs.some((line) => /Couldn't re-read PR #7 after recording the ask/.test(line)), logs.join("\n"));
  });
}

test("finds its own record by its id: another run's visible record doesn't stand in for a hidden one (mpaulosky/dotfiles#369)", async () => {
  const hidden = await evaluate(readyPr(unreviewed), [], { ownRecordHiddenReads: 3, rivalOffsetMs: 50 });

  assert.deepEqual(hidden.requests, []);
  assert.equal(hidden.order.filter((step) => step === "re-read").length, 3, hidden.order.join(","));
  assert.ok(hidden.logs.some((line) => /Couldn't find this run's record of the ask/.test(line)), hidden.logs.join("\n"));

  const lagging = await evaluate(readyPr(unreviewed), [], { ownRecordHiddenReads: 1, rivalOffsetMs: 50 });

  assert.equal(lagging.requests.length, 1, "its own record shows on the second read and is listed first");
});

test("the record listed first wins whatever the createdAt says, and a tie goes to the one listed first (mpaulosky/dotfiles#369)", async () => {
  const tieRivalFirst = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: 0, rivalFirst: true });
  const tieOwnFirst = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: 0, rivalFirst: false });
  const rivalListedFirstButStamped = await evaluate(readyPr(unreviewed), [], { rivalOffsetMs: 50, rivalFirst: true });

  assert.deepEqual(tieRivalFirst.requests, []);
  assert.equal(tieOwnFirst.requests.length, 1);
  assert.deepEqual(rivalListedFirstButStamped.requests, [], "listed first, stamped later: GitHub's order decides, as it does for every run");
});

test("pauses between the re-reads (mpaulosky/dotfiles#369)", async () => {
  const started = Date.now();
  await evaluate(readyPr(unreviewed), [], { ownRecordHiddenReads: 3, askRereadMs: 40 });

  assert.ok(Date.now() - started >= 70, "two pauses of 40 ms");
});

test("asks for the PR's last 100 comments with their author, body and time, and not the reviewable events (mpaulosky/dotfiles#360)", async () => {
  const { queries } = await evaluate(readyPr());

  assert.ok(queries.length > 0);
  assert.ok(
    queries.every((query) => /\bcomments\(last: 100\)\s*\{\s*totalCount\s+nodes\s*\{[^}]*author\s*\{\s*login\s*\}[^}]*\bbody\b[^}]*\bcreatedAt\b/.test(query)),
    queries.join("\n")
  );
  assert.ok(queries.every((query) => !/reviewableEvents|READY_FOR_REVIEW_EVENT/.test(query)), queries.join("\n"));
});

// A head Copilot answered, or that Claude must call in, never gets a second ask.
test("doesn't ask when Copilot's quota note is on the head, and adds review:claude (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ copilotReviews: DECLINED }));

  noAsk(result, "a quota note");
  assert.deepEqual(result.addedLabels, LABEL_FOR_CLAUDE);
});

test("doesn't ask when Copilot has really reviewed the head (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ copilotReviews: copilotReviewsOf(HEAD) }));

  noAsk(result, "a Copilot review of the head");
  assert.equal(result.merges.length, 1);
});

test("doesn't ask when Copilot's request is already pending (the ruleset's own), and waits (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ ...unreviewed, reviewRequests: COPILOT_PENDING }));

  noAsk(result, "a pending request");
  assert.deepEqual(result.addedLabels, []);
});

test("doesn't ask Copilot again for a later head: it goes to review:claude with no comment or request (mpaulosky/dotfiles#360)", async () => {
  // The record is two hours old, written for an earlier head; this head has no Copilot review and no request.
  const result = await evaluate(readyPr({ ...unreviewed, comments: commentsOf(askedBy(ACTIONS, 7200)) }));

  noAsk(result, "a later head");
  assert.deepEqual(result.addedLabels, LABEL_FOR_CLAUDE);
});

test("doesn't ask for a later head either when Claude already reviewed an earlier one (mpaulosky/dotfiles#360)", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one"),
    claudeReviews: claudeReviewsOf("one"),
    labels: labelled(CLAUDE_LABEL),
    comments: commentsOf(askedBy(ACTIONS, 7200)),
    quotaNotes: false
  });
  const result = await evaluate(pr);

  noAsk(result, "a later head with the label on");
  assert.deepEqual(result.addedLabels, []);
  assert.deepEqual(result.merges, []);
});

test("waits for a later head's pending request, and still doesn't ask (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ ...unreviewed, reviewRequests: COPILOT_PENDING, comments: commentsOf(askedBy(ACTIONS, 7200)) }));

  noAsk(result, "a later head with a request pending");
  assert.deepEqual(result.addedLabels, []);
});

test("a second sweep over the same PR asks nothing more, whether the first request registered or was dropped (mpaulosky/dotfiles#360)", async () => {
  for (const copilotRequest of ["registers", "drops"]) {
    const { asked, requests, addedLabels } = await evaluate(readyPr(unreviewed), [], { push: true, openPrs: [7, 7], copilotRequest });

    assert.equal(asked.length, 1, copilotRequest);
    assert.equal(requests.length, 1, copilotRequest);
    assert.ok(addedLabels.length <= 1, copilotRequest);
  }
});

test("doesn't ask for a draft, a cross-repository PR, a handed-back PR, one with auto-merge armed, one past the cap or one a clean merge covers (mpaulosky/dotfiles#360)", async () => {
  const cases = {
    draft: readyPr({ ...unreviewed, isDraft: true }),
    "cross-repository": readyPr({ ...unreviewed, isCrossRepository: true }),
    "handed back": readyPr({ ...unreviewed, labels: labelled(NEEDS_HUMAN) }),
    "auto-merge armed": readyPr({ ...unreviewed, autoMergeRequest: { enabledAt: "2026-01-01T00:00:00Z" } }),
    "past the cap": readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three") }),
    "covered by a clean merge": mergedPr("merge1")
  };
  for (const [name, pr] of Object.entries(cases)) {
    noAsk(await evaluate(pr), name);
  }
});

// Claude's review counts at the gate once Copilot can't review the head.
test("counts Claude's review of the head under a record 31 seconds old with nothing pending, and merges (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ ...claudeOnly(), comments: commentsOf(askedBy(ACTIONS, 31)) }));

  noAsk(result, "a settled record");
  assert.equal(result.merges.length, 1);
});

test("counts Claude's review of the head in the run that asked, when the request reads back as dropped (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr(claudeOnly()));

  assert.equal(result.requests.length, 1);
  assert.equal(result.merges.length, 1);
});

test("doesn't count Claude's review of the head when the request the run just made registered (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr(claudeOnly()), [], { copilotRequest: "registers" });

  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.merges, []);
});

test("doesn't count Claude's review of the head under a record 29 seconds old, a pending request or an unread record (mpaulosky/dotfiles#360)", async () => {
  const manyComments = { totalCount: 150, nodes: Array.from({ length: 100 }, () => askedBy("someone", 3600, "Looks good.")) };
  const cases = {
    "a record 29 seconds old": { comments: commentsOf(askedBy(ACTIONS, 29)) },
    "a pending request": { comments: commentsOf(askedBy(ACTIONS, 3600)), reviewRequests: COPILOT_PENDING },
    "comments that weren't read": { comments: undefined },
    "more comments than one page, the record not among them": { comments: manyComments }
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const result = await evaluate(readyPr({ ...claudeOnly(), ...overrides }));

    assert.deepEqual(result.merges, [], name);
    noAsk(result, name);
  }
});

test("neither asks nor adds review:claude when the record can't be read, and never infers a dropped request (mpaulosky/dotfiles#360)", async () => {
  const manyComments = { totalCount: 150, nodes: Array.from({ length: 100 }, () => askedBy("someone", 3600, "Looks good.")) };
  for (const comments of [undefined, null, manyComments]) {
    const result = await evaluate(readyPr({ ...unreviewed, comments }));

    noAsk(result, JSON.stringify(comments)?.slice(0, 40));
    assert.deepEqual(result.addedLabels, []);
    assert.deepEqual(result.merges, []);
  }
});

test("finds the record among more comments than one page when it is in the last 100 (mpaulosky/dotfiles#360)", async () => {
  const nodes = [...Array.from({ length: 99 }, () => askedBy("someone", 3600, "Looks good.")), askedBy(ACTIONS, 3600)];
  const result = await evaluate(readyPr({ ...unreviewed, comments: { totalCount: 150, nodes } }));

  noAsk(result, "a record on the page");
  assert.deepEqual(result.addedLabels, LABEL_FOR_CLAUDE);
});

test("trusts a record only from github-actions or the repository owner, and asks when a stranger left the marker (mpaulosky/dotfiles#360)", async () => {
  for (const login of [ACTIONS, OWNER]) {
    const result = await evaluate(readyPr({ ...unreviewed, comments: commentsOf(askedBy(login, 3600)) }));

    noAsk(result, login);
    assert.deepEqual(result.addedLabels, LABEL_FOR_CLAUDE, login);
  }
  for (const author of ["stranger", "copilot-pull-request-reviewer", null]) {
    const result = await evaluate(readyPr({ ...unreviewed, comments: commentsOf(askedBy(author, 3600)) }), [], { copilotRequest: "registers" });

    assert.equal(result.requests.length, 1, String(author));
    assert.equal(result.asked.length, 1, String(author));
    assert.deepEqual(result.addedLabels, [], String(author));
  }
});

test("ignores a comment by github-actions that lacks the marker (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ ...unreviewed, comments: commentsOf(askedBy(ACTIONS, 3600, "PR Auto-Merge asked Copilot.")) }), [], { copilotRequest: "registers" });

  assert.equal(result.requests.length, 1);
});

test("a labelled head with no CI check and a settled record merges on Claude's review (mpaulosky/dotfiles#360)", async () => {
  const skipped = (name) => requiredCheck(name, { isRequired: false, conclusion: "SKIPPED" });
  const headRef = checksOn(HEAD, skipped("Review with Claude"), requiredCheck("Merge same-repo PRs when ready", { isRequired: false }));
  const result = await evaluate(readyPr({ ...claudeOnly(), headRef, comments: commentsOf(askedBy(ACTIONS, 31)) }), [], { push: true, requiredChecks: [] });

  assert.equal(result.merges.length, 1);
  assert.ok(!result.logs.some((line) => line.includes("no CI check")), result.logs.join("\n"));
});

// The rest of the Claude flow is unchanged after the ask.
test("counts Claude's review of the head only for the head, not an earlier commit Copilot left without a note (mpaulosky/dotfiles#360)", async () => {
  const result = await evaluate(readyPr({ ...claudeOnly(), claudeReviews: claudeReviewsOf("older"), comments: commentsOf(askedBy(ACTIONS, 31)) }));

  assert.deepEqual(result.merges, []);
  assert.ok(result.logs.some((line) => line.includes("no Copilot or Claude review of")), result.logs.join("\n"));
});

test("doesn't reach the cap on Claude's reviews of earlier commits that carry no quota note (mpaulosky/dotfiles#360)", async () => {
  const pr = readyPr({ ...claudeOnly(), claudeReviews: claudeReviewsOf("one", "two", "three"), comments: commentsOf(askedBy(ACTIONS, 31)) });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("counts Claude's reviews of earlier commits that carry Copilot's quota note even while a request is pending", async () => {
  // Three reviewed commits reach the review cap, which merges the PR at a head no review covers: only if the notes' commits count.
  const notes = ["one", "two", "three"].map((oid) => ({ oid, note: true }));
  const pr = readyPr({
    copilotReviews: copilotReviewsOf(...notes),
    reviewRequests: COPILOT_PENDING,
    claudeReviews: claudeReviewsOf("one", "two", "three"),
    labels: labelled(CLAUDE_LABEL),
    quotaNotes: false
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(logs.some((line) => line.includes("Review cap (3) reached")), logs.join("\n"));
});

test("fails closed when Copilot's pending request can't be seen: too many requests, or one without a reviewer", async () => {
  const manyRequests = { totalCount: 21, nodes: [] };
  const nullReviewer = { totalCount: 1, nodes: [{ requestedReviewer: null }] };
  for (const reviewRequests of [manyRequests, nullReviewer, undefined]) {
    const counted = await evaluate(readyPr({ ...claudeOnly(), reviewRequests, comments: commentsOf(askedBy(ACTIONS, 3600)) }));
    assert.deepEqual(counted.merges, [], "Claude's review of the head doesn't count");
    const called = await evaluate(readyPr({ ...unreviewed, reviewRequests, comments: commentsOf(askedBy(ACTIONS, 3600)) }));
    assert.deepEqual(called.addedLabels, [], "Claude isn't called in");
    noAsk(called, "an unreadable request list");
  }
});

test("asks for Copilot's pending requests with their total", async () => {
  const { queries } = await evaluate(readyPr());

  assert.ok(queries.every((query) => /reviewRequests\(first: \d+\)\s*\{\s*totalCount\s+nodes\s*\{\s*requestedReviewer\s*\{[^}]*\.\.\. on Bot \{ login \}/.test(query)), queries.join("\n"));
});

test("calls in Claude past a still-pending Copilot request when its quota note is on the head", async () => {
  const { addedLabels } = await evaluate(readyPr({ copilotReviews: DECLINED, reviewRequests: COPILOT_PENDING }));

  assert.equal(addedLabels.length, 1);
});

test("doesn't call in Claude for a dropped request while a required check is still running (mpaulosky/dotfiles#360)", async () => {
  const pr = readyPr({
    ...unreviewed,
    comments: commentsOf(askedBy(ACTIONS, 3600)),
    headRef: checksOn(HEAD, requiredCheck("Build Solution"), requiredCheck("Test Suite", { status: "IN_PROGRESS", conclusion: null }))
  });
  const { addedLabels, logs } = await evaluate(pr);

  assert.deepEqual(addedLabels, []);
  assert.ok(logs.some((line) => line.startsWith("Not calling in Claude for PR #7 yet")), logs.join("\n"));
});

test("tells the owner about a head with no CI check even though Copilot was asked (mpaulosky/dotfiles#360)", async () => {
  const skipped = (name) => requiredCheck(name, { isRequired: false, conclusion: "SKIPPED" });
  const headRef = checksOn(HEAD, skipped("Review with Claude"), requiredCheck("Merge same-repo PRs when ready", { isRequired: false }));
  const { addedLabels, logs } = await evaluate(readyPr({ ...unreviewed, headRef }), [], { push: true, requiredChecks: [] });

  assert.deepEqual(addedLabels, []);
  assert.ok(logs.some((line) => line.startsWith("notice: PR #7") && line.includes("no CI check")), logs.join("\n"));
});

// A head with no check besides Claude Review's and the job's own: the unlabelled head's notice says to review and merge by hand (mpaulosky/dotfiles#331).
const noCiHead = () => {
  const skipped = (name) => requiredCheck(name, { isRequired: false, conclusion: "SKIPPED" });
  return checksOn(HEAD, skipped("Review with Claude"), requiredCheck("Merge same-repo PRs when ready", { isRequired: false }));
};
const noCiNotice = (logs) => logs.find((line) => line.startsWith("notice: PR #7") && line.includes("no CI check"));

test("tells the owner to review and merge by hand for an unlabelled no-CI head whether or not Copilot left a note (mpaulosky/dotfiles#331)", async () => {
  for (const copilotReviews of [copilotReviewsOf(), copilotReviewsOf("one"), copilotReviewsOf({ oid: HEAD, note: true })]) {
    const { merges, addedLabels, logs } = await evaluate(readyPr({ copilotReviews, headRef: noCiHead() }), [], { push: true, requiredChecks: [] });

    const notice = noCiNotice(logs);
    assert.ok(notice, logs.join("\n"));
    assert.ok(NO_CI_ADVICE.test(notice), notice);
    assert.deepEqual(addedLabels, []);
    assert.deepEqual(merges, []);
  }
});

// A bot-pushed clean merge H2 (the head) needs a Claude review of its own: a review of H1 with no Copilot note covers nothing (mpaulosky/dotfiles#331).
test("merges on Claude's review of the head when an earlier Claude review of the previous head has no Copilot note (mpaulosky/dotfiles#331)", async () => {
  const pr = readyPr({ ...claudeOnly(), claudeReviews: claudeReviewsOf("older", HEAD), comments: commentsOf(askedBy(ACTIONS, 31)) });
  const { merges } = await evaluate(pr);

  assert.equal(merges.length, 1);
});

test("doesn't merge a bot-pushed clean merge on Claude's review of the previous head alone when there is no Copilot note (mpaulosky/dotfiles#331)", async () => {
  const pr = readyPr({ ...claudeOnly(), claudeReviews: claudeReviewsOf("older"), comments: commentsOf(askedBy(ACTIONS, 31)) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of")), logs.join("\n"));
});

test("doesn't count Claude's review of the head when the quota note is on an earlier head and Copilot's request is pending", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf({ oid: "older", note: true }),
    reviewRequests: COPILOT_PENDING,
    claudeReviews: claudeReviewsOf(HEAD),
    labels: labelled(CLAUDE_LABEL),
    comments: commentsOf(askedBy(ACTIONS, 3600)),
    quotaNotes: false
  });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
});

test("still counts Copilot's own review of the head without a quota note", async () => {
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf(HEAD) }));

  assert.equal(merges.length, 1);
});

test("counts reviewed commits, not reviews, toward the cap", async () => {
  const { merges } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "one", "two") }));

  assert.deepEqual(merges, []);
});

test("still waits on unresolved Copilot threads at the review cap", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy(COPILOT, COPILOT, { login: OWNER, resolved: true })
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("2 unresolved review thread(s)")), logs.join("\n"));
});

test("still waits on a person's unresolved thread at the review cap", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy(OWNER)
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

test("merges at the review cap once every thread is resolved, without a review of the head", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two", "three"),
    reviewThreads: threadsBy({ login: COPILOT, resolved: true }, { login: ACTIONS, review: "claude-1", resolved: true })
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1);
  assert.ok(logs.some((line) => line.includes("Review cap (3) reached") && line.includes("without a review of " + HEAD)), logs.join("\n"));
});

test("waits at the review cap on an unresolved thread even without a review of the head", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three"), reviewThreads: threadsBy(COPILOT) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(!logs.some((line) => line.includes("Review cap")), logs.join("\n"));
});

const CLAUDE_LABEL = "review:claude";

test("takes review:claude off a PR at the review cap, even while a thread holds it", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf(),
    claudeReviews: claudeReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy({ login: ACTIONS, review: "claude-3" }),
    labels: labelled("enhancement", CLAUDE_LABEL)
  });
  const { merges, removedLabels, logs } = await evaluate(pr);

  assert.deepEqual(removedLabels, [{ owner: OWNER, repo: "demo", issue_number: 7, name: CLAUDE_LABEL }]);
  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("removed review:claude")), logs.join("\n"));
});

test("takes review:claude off once Copilot has really reviewed the head, so it has budget (mpaulosky/dotfiles#270)", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf(HEAD), labels: labelled(CLAUDE_LABEL) });
  const { removedLabels, logs } = await evaluate(pr);

  assert.deepEqual(removedLabels, [{ owner: OWNER, repo: "demo", issue_number: 7, name: CLAUDE_LABEL }]);
  assert.ok(logs.some((line) => line.includes("Copilot has reviewed the head")), logs.join("\n"));
});

test("leaves review:claude on when Copilot's quota note or an earlier head's review is all it has", async () => {
  for (const copilotReviews of [copilotReviewsOf({ oid: HEAD, note: true }), copilotReviewsOf("older")]) {
    const pr = readyPr({ copilotReviews, labels: labelled(CLAUDE_LABEL), quotaNotes: false });
    const { removedLabels } = await evaluate(pr);

    assert.deepEqual(removedLabels, []);
  }
});

test("leaves review:claude on below the review cap and MAX_CLAUDE_ROUNDS", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one"), claudeReviews: claudeReviewsOf(HEAD), labels: labelled(CLAUDE_LABEL) });
  const { removedLabels } = await evaluate(pr);

  assert.deepEqual(removedLabels, []);
});

test("keeps review:claude on after a second round with findings, so the fix is reviewed too (mpaulosky/dotfiles#193)", async () => {
  // Claude reviewed two commits; the second left a thread, and a fix was pushed.
  const pr = readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf("one", "two"), labels: labelled(CLAUDE_LABEL) });
  const { removedLabels, merges, logs } = await evaluate(pr, [claudeLabelled("2026-01-01T00:00:00Z")]);

  assert.deepEqual(removedLabels, []);
  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("no Copilot or Claude review of " + HEAD)), logs.join("\n"));
});

test("merges on a clean review of the head after rounds with findings: that's when reviewing is done (mpaulosky/dotfiles#193)", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf("one", HEAD), labels: labelled(CLAUDE_LABEL) });
  const { merges } = await evaluate(pr, [claudeLabelled("2026-01-01T00:00:00Z")]);

  assert.equal(merges.length, 1);
});

test("takes review:claude off once Claude has reviewed MAX_CLAUDE_ROUNDS commits, whoever added it (mpaulosky/dotfiles#190)", async () => {
  // A merge commit among them keeps the PR below the cap, which doesn't count it.
  const pr = readyPr({
    copilotReviews: copilotReviewsOf(),
    claudeReviews: claudeReviewsOf("one", { oid: "m1", merge: true }, HEAD),
    labels: labelled(CLAUDE_LABEL)
  });
  // Claude's reviews are from 2026-01-02, after the label went on.
  const { removedLabels, logs } = await evaluate(pr, [claudeLabelled("2026-01-01T00:00:00Z")]);

  assert.deepEqual(removedLabels, [{ owner: OWNER, repo: "demo", issue_number: 7, name: CLAUDE_LABEL }]);
  assert.ok(logs.some((line) => line.includes("(MAX_CLAUDE_ROUNDS) on PR #7: removed review:claude")), logs.join("\n"));
  // Added again since Claude's last review: that gets one more review first, as at the cap.
  const readded = await evaluate(pr, [claudeLabelled("2026-01-01T00:00:00Z"), claudeLabelled("2026-01-03T00:00:00Z")]);
  assert.deepEqual(readded.removedLabels, []);
});

test("leaves review:claude on at a cap reached on Copilot's reviews alone", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three"), labels: labelled(CLAUDE_LABEL) });
  const { removedLabels } = await evaluate(pr);

  assert.deepEqual(removedLabels, []);
});

// A label event: review:claude added at the given time.
function claudeLabelled(at) {
  return { event: "labeled", label: { name: CLAUDE_LABEL }, created_at: at, actor: { login: OWNER } };
}

test("leaves review:claude on past the cap until Claude has reviewed since it was last added", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf(),
    claudeReviews: claudeReviewsOf("one", "two", HEAD),
    labels: labelled(CLAUDE_LABEL)
  });
  const { removedLabels } = await evaluate(pr, [claudeLabelled("2026-01-03T00:00:00Z")]);

  assert.deepEqual(removedLabels, []);
});

test("measures from the last time review:claude was added, not the first", async () => {
  // Added at T1, reviewed at T2, added again at T3: the T2 review doesn't count.
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf({ oid: HEAD, at: "2026-01-02T00:00:00Z" }),
    labels: labelled(CLAUDE_LABEL)
  });
  const { removedLabels } = await evaluate(pr, [claudeLabelled("2026-01-01T00:00:00Z"), claudeLabelled("2026-01-03T00:00:00Z")]);

  assert.deepEqual(removedLabels, []);
});

test("ignores unlabeled events and other labels when measuring since review:claude was added", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf({ oid: HEAD, at: "2026-01-02T00:00:00Z" }),
    labels: labelled(CLAUDE_LABEL)
  });
  const events = [
    claudeLabelled("2026-01-01T00:00:00Z"),
    { event: "unlabeled", label: { name: CLAUDE_LABEL }, created_at: "2026-01-03T00:00:00Z", actor: { login: OWNER } },
    { event: "labeled", label: { name: "enhancement" }, created_at: "2026-01-04T00:00:00Z", actor: { login: OWNER } }
  ];
  const { removedLabels } = await evaluate(pr, events);

  assert.deepEqual(removedLabels.map((params) => params.name), [CLAUDE_LABEL]);
});

test("takes review:claude off past the cap once Claude has reviewed since it was last added", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf({ oid: HEAD, at: "2026-01-03T00:05:00Z" }),
    labels: labelled(CLAUDE_LABEL)
  });
  const { removedLabels } = await evaluate(pr, [claudeLabelled("2026-01-01T00:00:00Z"), claudeLabelled("2026-01-03T00:00:00Z")]);

  assert.deepEqual(removedLabels.map((params) => params.name), [CLAUDE_LABEL]);
});

test("falls back to any Claude review at the cap when the label events can't be read", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf(HEAD), labels: labelled(CLAUDE_LABEL) });
  const { removedLabels, logs } = await evaluate(pr, [], { eventsError: new Error("Server Error") });

  assert.deepEqual(removedLabels.map((params) => params.name), [CLAUDE_LABEL]);
  assert.ok(logs.some((line) => line.startsWith("warning: Couldn't read PR #7's label events")), logs.join("\n"));
});

test("keeps review:claude at the cap when the label events can't be read and Claude never reviewed", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two", "three"), labels: labelled(CLAUDE_LABEL) });
  const { removedLabels } = await evaluate(pr, [], { eventsError: new Error("Server Error") });

  assert.deepEqual(removedLabels, []);
});

test("asks for when each Claude review was submitted", async () => {
  const { queries } = await evaluate(readyPr());

  assert.ok(queries.some((query) => /claudeReviews:[\s\S]*\bsubmittedAt\b/.test(query)), queries.join("\n"));
});

for (const [scenario, overrides] of [
  ["a fork", { isCrossRepository: true }],
  ["a PR into another branch", { baseRefName: "release" }],
  ["a merged PR", { state: "MERGED" }],
  ["a closed PR", { state: "CLOSED" }]
]) {
  test(`leaves review:claude on ${scenario} at the review cap`, async () => {
    const pr = readyPr({ copilotReviews: copilotReviewsOf(), claudeReviews: claudeReviewsOf("one", "two", HEAD), labels: labelled(CLAUDE_LABEL), ...overrides });
    const { removedLabels } = await evaluate(pr);

    assert.deepEqual(removedLabels, []);
  });
}

test("removes nothing at the review cap when the PR doesn't carry review:claude", async () => {
  const { removedLabels } = await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one", "two", HEAD) }));

  assert.deepEqual(removedLabels, []);
});

test("still merges at the cap when taking review:claude off fails, warning about it", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf(HEAD), labels: labelled(CLAUDE_LABEL) });
  const { merges, logs } = await evaluate(pr, [], { removeLabelError: Object.assign(new Error("Resource not accessible"), { status: 403 }) });

  assert.equal(merges.length, 1);
  assert.ok(logs.some((line) => line.startsWith("warning: Couldn't remove review:claude")), logs.join("\n"));
});

for (const [scenario, overrides] of [
  ["a draft", { isDraft: true }],
  ["handed back with " + NEEDS_HUMAN, { labels: labelled(NEEDS_HUMAN, CLAUDE_LABEL) }],
  ["red on CI", { mergeStateStatus: "UNSTABLE" }]
]) {
  test(`takes review:claude off a PR at the review cap that's ${scenario}`, async () => {
    const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf("three"), labels: labelled(CLAUDE_LABEL), ...overrides });
    const { merges, removedLabels } = await evaluate(pr);

    assert.deepEqual(merges, []);
    assert.deepEqual(removedLabels.map((params) => params.name), [CLAUDE_LABEL]);
  });
}

test("says nothing at the cap when review:claude is already gone (404)", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf(HEAD), labels: labelled(CLAUDE_LABEL) });
  const { merges, logs } = await evaluate(pr, [], { removeLabelError: Object.assign(new Error("Label does not exist"), { status: 404 }) });

  assert.equal(merges.length, 1);
  assert.ok(!logs.some((line) => line.startsWith("warning:") || line.includes("removed review:claude")), logs.join("\n"));
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

test("still waits on unresolved Copilot and Claude threads at the cap", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf(HEAD),
    reviewThreads: threadsBy(COPILOT, { login: ACTIONS, review: "claude-1" }, { login: ACTIONS, review: "claude-1" })
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("3 unresolved review thread(s)")), logs.join("\n"));
});

test("still waits on an unresolved Claude thread at the cap", async () => {
  const pr = readyPr({
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf(HEAD),
    reviewThreads: threadsBy({ login: ACTIONS, review: "claude-1" })
  });
  const { merges } = await evaluate(pr);

  assert.deepEqual(merges, []);
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

test("still waits on off-diff findings at the review cap", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf({ oid: HEAD, offDiff: true }) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("findings outside the diff")), logs.join("\n"));
});

test("still waits at the cap on off-diff findings of the commit a merge from main covers", async () => {
  const pr = mergedPr("merge1", {
    copilotReviews: copilotReviewsOf("one", "two"),
    claudeReviews: claudeReviewsOf({ oid: "rev", offDiff: true })
  });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("Claude's review of rev has findings outside the diff")), logs.join("\n"));
});

test("ignores off-diff findings on an older head at the cap", async () => {
  const pr = readyPr({ copilotReviews: copilotReviewsOf("one", "two"), claudeReviews: claudeReviewsOf({ oid: "older", offDiff: true }) });
  const { merges } = await evaluate(pr);

  assert.equal(merges.length, 1);
});

// A re-Apply PR is capped like any other (mpaulosky/dotfiles#174).
test("merges a re-Apply PR past the cap without a review of the head, like any other", async () => {
  const pr = readyPr({ headRefName: "chore/reapply-baseline", copilotReviews: copilotReviewsOf("one", "two", "three") });
  const { merges } = await evaluate(pr);

  assert.equal(merges.length, 1);
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
  return readyPr({ headRefOid: head, copilotReviews: copilotReviewsOf("rev"), headRef: checksOn(head, requiredCheck("Build Solution")), ...overrides });
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

test("waits on a merge from main that only changes a file's mode (mpaulosky/dotfiles#155)", async () => {
  const commits = graph({ merge1: { parents: ["rev", "main1"], files: { app: { sha: "app1", mode: "100755" }, lib: "lib1" } } });
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { commits }), "merge1");
});

test("waits on a merge from main that swaps a file for a symlink with the same blob (mpaulosky/dotfiles#155)", async () => {
  const commits = graph({ merge1: { parents: ["rev", "main1"], files: { app: "app1", lib: { sha: "lib1", mode: "120000" } } } });
  assertWaitsForReview(await evaluate(mergedPr("merge1"), [], { commits }), "merge1");
});

test("counts a mode change main made as clean", async () => {
  const commits = graph({
    main1: { parents: ["base0"], files: { app: "app0", lib: { sha: "lib1", mode: "100755" } } },
    merge1: { parents: ["rev", "main1"], files: { app: "app1", lib: { sha: "lib1", mode: "100755" } } }
  });
  const { merges } = await evaluate(mergedPr("merge1"), [], { commits });

  assert.equal(merges.length, 1);
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

test("keeps Claude's off-diff hold on the commit a merge from main covers when Copilot reviewed the merge", async () => {
  // Copilot reviews every push, so it reviews merge1, which Claude Review skips.
  const pr = mergedPr("merge1", { copilotReviews: copilotReviewsOf({ oid: "merge1", merge: true }), claudeReviews: claudeReviewsOf({ oid: "rev", offDiff: true }) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("Claude's review of rev has findings outside the diff")), logs.join("\n"));
});

test("keeps Claude's off-diff hold down a chain of merges Copilot reviewed", async () => {
  const copilot = copilotReviewsOf({ oid: "merge1", merge: true }, { oid: "merge2", merge: true });
  const pr = mergedPr("merge2", { copilotReviews: copilot, claudeReviews: claudeReviewsOf({ oid: "rev", offDiff: true }) });
  const { merges, updates, logs } = await evaluate(pr);
  const behind = await evaluate({ ...pr, mergeStateStatus: "BEHIND" });

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("Claude's review of rev has findings outside the diff")), logs.join("\n"));
  assert.deepEqual(behind.updates, []);
  assert.deepEqual(updates, []);
});

test("merges a Copilot-reviewed merge from main onto a commit Claude cleared", async () => {
  const claude = claudeReviewsOf({ oid: "rev", offDiff: true }, "rev");
  const pr = mergedPr("merge1", { copilotReviews: copilotReviewsOf({ oid: "merge1", merge: true }), claudeReviews: claude });

  assert.equal((await evaluate(pr)).merges.length, 1);
});

test("lets a fix pushed after Claude's off-diff review clear the hold, even under a merge from main", async () => {
  // fix sits on rev; merge1 merges main into fix. Copilot reviewed fix and merge1.
  const commits = graph({
    fix: { parents: ["rev"], files: { app: "app3", lib: "lib0" } },
    merge1: { parents: ["fix", "main1"], files: { app: "app3", lib: "lib1" } }
  });
  const copilot = copilotReviewsOf("fix", { oid: "merge1", merge: true });
  const pr = mergedPr("merge1", { copilotReviews: copilot, claudeReviews: claudeReviewsOf({ oid: "rev", offDiff: true }) });

  assert.equal((await evaluate(pr, [], { commits })).merges.length, 1);
});

test("waits at the cap, with a warning, when the merge check can't read the head", async () => {
  const pr = mergedPr("missing", { copilotReviews: copilotReviewsOf("one", "two", "three") });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.startsWith("warning: ") && line.includes("clean merge from main")), logs.join("\n"));
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
  const running = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn(HEAD, requiredCheck("Build Solution", { status: "IN_PROGRESS", conclusion: null })) });
  const failed = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn(HEAD, requiredCheck("Build Solution", { conclusion: "FAILURE" })) });
  const failedStatus = readyPr({
    mergeStateStatus: "BEHIND",
    headRef: checksOn(HEAD, { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", createdAt: "x", isRequired: true })
  });
  const otherHead = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn("older", requiredCheck("Build Solution")) });
  const noChecks = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn(HEAD) });

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
    requiredCheck("Build Solution", { conclusion: "CANCELLED", databaseId: 1 }),
    requiredCheck("Build Solution", { conclusion: "SUCCESS", databaseId: 2 }),
    requiredCheck("Coverage", { conclusion: "SKIPPED", isRequired: false }),
    requiredCheck("Merge same-repo PRs when ready", { status: "IN_PROGRESS", conclusion: null, isRequired: false }),
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", createdAt: "x", isRequired: true }
  );
  const regressed = checksOn(
    HEAD,
    requiredCheck("Build Solution", { conclusion: "SUCCESS", databaseId: 1 }),
    requiredCheck("Build Solution", { conclusion: "FAILURE", databaseId: 2 })
  );

  const queuedRerun = checksOn(
    HEAD,
    requiredCheck("Build Solution", { conclusion: "SUCCESS", databaseId: 1 }),
    requiredCheck("Build Solution", { status: "QUEUED", conclusion: null, databaseId: 2 })
  );
  // Cancelled before it started (no startedAt), then a later run passed.
  const cancelledWhileQueued = checksOn(
    HEAD,
    requiredCheck("Build Solution", { conclusion: "CANCELLED", startedAt: null, databaseId: 1 }),
    requiredCheck("Build Solution", { conclusion: "SUCCESS", databaseId: 2 })
  );

  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef: rerun }))).updates.length, 1);
  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef: regressed }))).updates.length, 0);
  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef: queuedRerun }))).updates.length, 0);
  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef: cancelledWhileQueued }))).updates.length, 1);
});

test("says so where it shows when a BEHIND PR has no required check at all", async () => {
  const pr = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn(HEAD, requiredCheck("Lint", { isRequired: false })) });
  const { updates, logs } = await evaluate(pr, [], { push: true, requiredChecks: [] });

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.startsWith("notice: ") && line.includes("no required check")), logs.join("\n"));
});

test("doesn't flag a head whose CI is still creating its checks", async () => {
  const pr = readyPr({
    mergeStateStatus: "BEHIND",
    headRef: checksOn(HEAD, requiredCheck("Detect Changes", { isRequired: false, status: "IN_PROGRESS", conclusion: null }))
  });
  const { updates, logs } = await evaluate(pr, [], { push: true });

  assert.deepEqual(updates, []);
  assert.ok(!logs.some((line) => line.startsWith("notice: ")), logs.join("\n"));
});

test("doesn't flag a PR event that came before CI created its checks", async () => {
  const pr = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn(HEAD, requiredCheck("Merge same-repo PRs when ready", { isRequired: false })) });
  const { updates, logs } = await evaluate(pr, [], { requiredChecks: [] });

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("no required check")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("notice: ")), logs.join("\n"));
});

test("doesn't update a BEHIND PR while a required check hasn't reported yet", async () => {
  // Branch name has passed; Test Suite's job isn't queued yet, so it has no check run.
  const pr = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn(HEAD, requiredCheck("Branch name")) });
  const { updates, logs, rulesRequests } = await evaluate(pr, [], { requiredChecks: ["Branch name", "Test Suite"] });

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("required checks not reported yet: Test Suite")), logs.join("\n"));
  assert.deepEqual(rulesRequests, [{ owner: OWNER, repo: "demo", branch: "main", per_page: 100 }]);
});

test("counts a check main's rulesets require even when isRequired doesn't", async () => {
  const pr = readyPr({ mergeStateStatus: "BEHIND", headRef: checksOn(HEAD, requiredCheck("Test Suite", { isRequired: false, conclusion: "FAILURE" })) });
  const { updates, logs } = await evaluate(pr, [], { requiredChecks: ["Test Suite"] });

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("required checks not passed: Test Suite")), logs.join("\n"));
});

test("waits, with a warning, when main's required checks can't be read", async () => {
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { rulesError: new Error("boom") });

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.startsWith("warning: ") && line.includes("boom")), logs.join("\n"));
});

test("doesn't update a BEHIND PR with a failed check that isn't required", async () => {
  // Claude Review's post job fails on purpose to hold the PR at UNSTABLE.
  const failedPost = checksOn(HEAD, requiredCheck("Build Solution"), requiredCheck("Post the review", { isRequired: false, conclusion: "FAILURE" }));
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef: failedPost }));

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes(`checks failed on ${HEAD}: Post the review`)), logs.join("\n"));
  for (const conclusion of ["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
    const headRef = checksOn(HEAD, requiredCheck("Build Solution"), requiredCheck("Coverage", { isRequired: false, conclusion }));
    assert.deepEqual((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef }))).updates, [], conclusion);
  }
  const erroredStatus = checksOn(HEAD, requiredCheck("Build Solution"), { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", createdAt: "x", isRequired: false });
  assert.deepEqual((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef: erroredStatus }))).updates, []);
});

test("updates a BEHIND PR once a failed optional check's rerun passes", async () => {
  const headRef = checksOn(
    HEAD,
    requiredCheck("Build Solution"),
    requiredCheck("Coverage", { isRequired: false, conclusion: "FAILURE", databaseId: 1 }),
    requiredCheck("Coverage", { isRequired: false, conclusion: "SUCCESS", databaseId: 2 }),
    requiredCheck("Docs", { isRequired: false, conclusion: "NEUTRAL" })
  );
  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef }))).updates.length, 1);
});

test("still updates a PR with native auto-merge armed past a failed optional check", async () => {
  // GitHub merges it on its required checks alone, so the failure holds nothing.
  const headRef = checksOn(HEAD, requiredCheck("Build Solution"), requiredCheck("Coverage", { isRequired: false, conclusion: "FAILURE" }));
  const pr = readyPr({ mergeStateStatus: "BEHIND", autoMergeRequest: { enabledAt: "now" }, copilotReviews: copilotReviewsOf(), headRef });

  assert.equal((await evaluate(pr)).updates.length, 1);
});

test("reads the head's checks from headRef, not the last commit listed", async () => {
  const { queries } = await evaluate(readyPr());

  assert.ok(queries.some((query) => /headRef\s*\{\s*target\s*\{\s*\.\.\. on Commit\s*\{\s*oid\s+statusCheckRollup/.test(query)), queries.join("\n"));
  assert.ok(!queries.some((query) => query.includes("commits(last")), queries.join("\n"));
});

test("doesn't update a BEHIND PR whose head branch is gone", async () => {
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef: null }));

  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("the head's checks aren't reported yet")), logs.join("\n"));
});

test("doesn't let a failed run of its own job hold an update", async () => {
  // A transient failure of a pull_request_target run stays on the head until the next PR event.
  const headRef = checksOn(HEAD, requiredCheck("Build Solution"), requiredCheck("Merge same-repo PRs when ready", { isRequired: false, conclusion: "FAILURE" }));
  assert.equal((await evaluate(readyPr({ mergeStateStatus: "BEHIND", headRef }))).updates.length, 1);
});

test("names its own job as the check it leaves out", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /\n {4}name: Merge same-repo PRs when ready\n/);
  assert.match(workflow, /const SELF_CHECK = "Merge same-repo PRs when ready";/);
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
  const asked = [{ user: { login: POSTER }, body: `@dependabot rebase\n\n<!-- pr-automerge:dependabot-rebase ${HEAD} -->` }];
  const askedBefore = [
    { user: { login: POSTER }, body: "@dependabot rebase\n\n<!-- pr-automerge:dependabot-rebase older -->" },
    { user: { login: POSTER }, body: null }
  ];

  const again = await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS, comments: asked });
  assert.deepEqual(again.posted, []);
  assert.deepEqual(again.updates, []);
  assert.ok(again.logs.some((line) => line.includes("already asked to rebase " + HEAD)), again.logs.join("\n"));
  assert.equal((await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS, comments: askedBefore })).posted.length, 1);
});

test("doesn't count a rebase marker someone else posted", async () => {
  const forged = [
    { user: { login: "stranger" }, body: `<!-- pr-automerge:dependabot-rebase ${HEAD} -->` },
    { user: null, body: `<!-- pr-automerge:dependabot-rebase ${HEAD} -->` }
  ];
  const { posted } = await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS, comments: forged });

  assert.equal(posted.length, 1);
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
  const { updates, listRequests } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { push: true });

  assert.equal(updates.length, 1);
  assert.deepEqual(
    listRequests.map(({ sort, direction }) => ({ sort, direction })),
    [{ sort: "created", direction: "asc" }],
    "the sweep lists open PRs oldest first"
  );
});

test("a sweep brings only one ready BEHIND PR up to date, the first listed (mpaulosky/dotfiles#155)", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const { updates, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8, 9] });

  assert.deepEqual(updates.map((update) => update.pull_number), [7]);
  assert.ok(logs.some((line) => line.includes("Waiting on PR #8") && line.includes("already brought PR #7 up to date")), logs.join("\n"));
  assert.ok(logs.some((line) => line.includes("Waiting on PR #9")), logs.join("\n"));
});

test("a sweep that asks Dependabot to rebase the first BEHIND PR leaves the next one waiting", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const byNumber = { 7: [dependabotPr()], 8: [behind] };
  const { updates, posted, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8], prCommits: DEPENDABOT_COMMITS, byNumber });

  assert.equal(posted.length, 1);
  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("Waiting on PR #8") && line.includes("already brought PR #7 up to date")), logs.join("\n"));
});

test("a sweep moves on to the next BEHIND PR when Dependabot was already asked for the first's head", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const byNumber = { 7: [dependabotPr()], 8: [behind] };
  const asked = [{ user: { login: POSTER }, body: `@dependabot rebase\n\n<!-- pr-automerge:dependabot-rebase ${HEAD} -->` }];
  const { updates, posted } = await evaluate(behind, [], { push: true, openPrs: [7, 8], prCommits: DEPENDABOT_COMMITS, comments: asked, byNumber });

  assert.deepEqual(posted, []);
  assert.deepEqual(updates.map((update) => update.pull_number), [8]);
});

test("a sweep tries the next BEHIND PR when updating the first fails with a 422", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const { updates } = await evaluate(behind, [], { push: true, openPrs: [7, 8], updateError: Object.assign(new Error("head moved"), { status: 422 }) });

  assert.deepEqual(updates.map((update) => update.pull_number), [7, 8]);
});

test("a sweep that merges a later PR leaves the earlier BEHIND one for the merge's push", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const byNumber = { 7: [behind], 8: [readyPr()] };
  const { updates, merges, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8], byNumber });

  assert.deepEqual(merges.map((merge) => merge.pull_number), [8]);
  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("Waiting on PR #7") && line.includes("this sweep merged PR #8")), logs.join("\n"));
});

test("a sweep reads a candidate again before its update, and skips one no longer ready", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const handedBack = readyPr({ mergeStateStatus: "BEHIND", labels: labelled(NEEDS_HUMAN) });
  // PR 7 is read twice while the sweep evaluates it, then picks up the hand-back label.
  const byNumber = { 7: [behind, behind, handedBack], 8: [behind] };
  const { updates } = await evaluate(behind, [], { push: true, openPrs: [7, 8], byNumber });

  assert.deepEqual(updates.map((update) => update.pull_number), [8]);
});

test("a sweep merges a candidate that is CLEAN when read again, and updates no other", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  // PR 7 is read twice while the sweep evaluates it, then is CLEAN (someone brought it up to date).
  const byNumber = { 7: [behind, behind, readyPr()], 8: [behind] };
  const { merges, updates, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8], byNumber });

  assert.deepEqual(merges.map((merge) => merge.pull_number), [7]);
  assert.deepEqual(updates, []);
  assert.ok(logs.some((line) => line.includes("Waiting on PR #8") && line.includes("this sweep merged PR #7")), logs.join("\n"));
});

test("a sweep updates the next candidate when reading one again throws, then fails the run", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const byNumber = { 7: [behind, behind, new Error("Server error reading PR #7")], 8: [behind] };
  const { updates, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8], byNumber });

  assert.deepEqual(updates.map((update) => update.pull_number), [8]);
  assert.ok(logs.some((line) => line.startsWith("failed: ") && line.includes("#7")), logs.join("\n"));
});

test("a sweep still makes its update when evaluating another PR throws, then fails the run", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const { updates, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8], readErrors: [8] });

  assert.deepEqual(updates.map((update) => update.pull_number), [7]);
  assert.ok(logs.some((line) => line.startsWith("warning: ") && line.includes("PR #8") && line.includes("Server error")), logs.join("\n"));
  assert.ok(logs.some((line) => line.startsWith("failed: ") && line.includes("#8")), logs.join("\n"));
});

for (const [name, error] of [
  ["a 401", Object.assign(new Error("Bad credentials"), { status: 401 })],
  [
    "a 403 rate limit",
    Object.assign(new Error("You have exceeded a secondary rate limit"), { status: 403, response: { headers: { "retry-after": "60" } } })
  ],
  ["a 403 with no requests left", Object.assign(new Error("Forbidden"), { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } })],
  ["a 429", Object.assign(new Error("Too many requests"), { status: 429 })],
  ["a GraphQL RATE_LIMITED error", Object.assign(new Error("rate limited"), { errors: [{ type: "RATE_LIMITED" }] })]
]) {
  test(`a sweep stops at ${name}, which holds for the whole run`, async () => {
    const behind = readyPr({ mergeStateStatus: "BEHIND" });
    const byNumber = { 7: [behind], 8: [error], 9: [behind] };

    const thrown = await evaluate(behind, [], { push: true, openPrs: [7, 8, 9], byNumber }).then(() => null, (e) => e);

    assert.equal(thrown, error);
    assert.equal(thrown.observed.reads[9], undefined, "PR 9 is never read");
    assert.deepEqual(thrown.observed.updates, [], "no update is made");
  });
}

test("a sweep treats a 403 that isn't a rate limit as one PR's error, and still makes its update", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const forbidden = Object.assign(new Error("Resource not accessible by integration"), { status: 403, response: { headers: {} } });
  const byNumber = { 7: [behind], 8: [forbidden] };
  const { updates, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8], byNumber });

  assert.deepEqual(updates.map((update) => update.pull_number), [7]);
  assert.ok(logs.some((line) => line.startsWith("failed: ") && line.includes("#8")), logs.join("\n"));
});

test("a sweep stops when its update hits a rate limit, without trying the next candidate", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const updateError = Object.assign(new Error("You have exceeded a secondary rate limit"), { status: 403, response: { headers: { "retry-after": "60" } } });

  const thrown = await evaluate(behind, [], { push: true, openPrs: [7, 8], updateError }).then(() => null, (e) => e);

  assert.equal(thrown, updateError);
  assert.deepEqual(thrown.observed.updates.map((update) => update.pull_number), [7]);
});

test("a sweep whose update fails tries the next candidate, then fails the run", async () => {
  const behind = readyPr({ mergeStateStatus: "BEHIND" });
  const updateError = Object.assign(new Error("Server error"), { status: 502 });
  const { updates, logs } = await evaluate(behind, [], { push: true, openPrs: [7, 8], updateError });

  assert.deepEqual(updates.map((update) => update.pull_number), [7, 8]);
  assert.ok(logs.some((line) => line.startsWith("failed: ") && line.includes("#7") && line.includes("#8")), logs.join("\n"));
});

test("a PR event's update that hits a rate limit is only a warning", async () => {
  const updateError = Object.assign(new Error("Too many requests"), { status: 429 });
  const { updates, logs } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { updateError });

  assert.equal(updates.length, 1);
  assert.ok(logs.some((line) => line.startsWith("warning: Couldn't bring PR #7 up to date")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("failed: ")), logs.join("\n"));
});

test("a PR event still brings its own PR up to date", async () => {
  const { updates } = await evaluate(readyPr({ mergeStateStatus: "BEHIND" }));

  assert.equal(updates.length, 1);
});

test("evaluates a PR on a Claude Review run of an older commit", async () => {
  // Claude Review reviewed rev, which merge1, the PR's head now, covers.
  const workflowRun = { name: "Claude Review", head_sha: "rev" };
  const associated = [{ number: 7, state: "open", head: { sha: "merge1" } }, { number: 8, state: "closed", head: { sha: "x" } }];
  const { merges } = await evaluate(mergedPr("merge1"), [], { workflowRun, associated });

  assert.deepEqual(merges.map((merge) => merge.pull_number), [7]);
});

test("ignores another workflow's run of a commit that is no longer the head", async () => {
  const workflowRun = { name: "Build and Test Suite", head_sha: "rev" };
  const associated = [{ number: 7, state: "open", head: { sha: "merge1" } }];
  const { merges, logs } = await evaluate(mergedPr("merge1"), [], { workflowRun, associated });

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("No open pull request")), logs.join("\n"));
});

test("runs on a push to main", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /\n {2}push:\n {4}branches: \[main\]\n/);
});

// The comments that say what the PAT and GITHUB_TOKEN do (mpaulosky/dotfiles#214).
// A repo's owner sets up RELEASE_PR_PAT from them, so they must say the PAT
// adds review:claude and needs Pull requests (or Issues) write to do it, and
// that GITHUB_TOKEN takes the label off.

// The comment lines directly above the first line matching `anchor`, as one
// string with the comment markers and line breaks removed.
function commentAbove(anchor) {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const at = lines.findIndex((line) => anchor.test(line));
  assert.notEqual(at, -1, `pr-automerge.yml has no line matching ${anchor}`);
  const block = [];
  for (let i = at - 1; i >= 0 && /^\s*(#|\/\/)/.test(lines[i]); i--) {
    block.unshift(lines[i].replace(/^\s*(#|\/\/)\s?/, "").trim());
  }
  return block.join(" ").replace(/\s+/g, " ");
}

// Which client makes each API call (mpaulosky/dotfiles#231). A PAT is the
// owner's account, whose 5,000 REST requests an hour everything acting as the
// owner shares, so only the calls GitHub must treat as a person's use it:
// the ones that have to start another workflow, and `@dependabot rebase`, and
// the one Copilot review request (mpaulosky/dotfiles#360), which GitHub should
// treat as a person's. Every other call is made with GITHUB_TOKEN, which has an
// allowance of its own for this repo. references/tokens.md lists them and says why.
const PAT_CALLS = [
  "pulls.merge",
  "pulls.updateBranch",
  "issues.addLabels",
  "issues.createComment",
  "users.getAuthenticated",
  "graphql"
];
// Both clients make these: GITHUB_TOKEN's graphql reads the PR and the PAT's
// graphql requests Copilot's review; GITHUB_TOKEN posts the record that Copilot
// was asked and the PAT `@dependabot rebase`.
const BOTH_CALLS = ["graphql", "issues.createComment"];
const TOKEN_CALLS = [
  "graphql",
  "issues.createComment",
  "pulls.list",
  "pulls.listCommits",
  "repos.getBranchRules",
  "repos.listPullRequestsAssociatedWithCommit",
  "repos.compareCommitsWithBasehead",
  "git.getCommit",
  "git.getTree",
  "issues.listEvents",
  "issues.listComments",
  "issues.removeLabel",
  "actions.listWorkflowRuns",
  "actions.listWorkflowRunsForRepo"
];

// The script with its // comments taken out, so a client named in a comment isn't a call.
function scriptCode() {
  return inlineScript()
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

test("pins which client makes each call: the PAT's six calls, GITHUB_TOKEN's reads and its record comment (mpaulosky/dotfiles#231, mpaulosky/dotfiles#360)", () => {
  const code = scriptCode();
  const used = { patClient: new Set(), github: new Set() };
  for (const [, client, call] of code.matchAll(/\b(github|patClient)\.(graphql|paginate|rest\.\w+\.\w+)/g)) {
    used[client].add(call.replace(/^rest\./, ""));
  }

  // paginate is only ever GITHUB_TOKEN's; the PAT's graphql is the one Copilot request.
  assert.ok(!used.patClient.has("paginate"), "patClient.paginate");
  assert.ok(used.patClient.has("graphql"), "patClient.graphql requests Copilot's review");
  assert.deepEqual([...used.patClient].sort(), [...PAT_CALLS].sort(), "calls made through patClient");
  const tokenNames = [...used.github].filter((name) => name !== "paginate").sort();
  assert.deepEqual(tokenNames, [...TOKEN_CALLS].sort(), "calls made through github");
  assert.deepEqual(PAT_CALLS.filter((name) => TOKEN_CALLS.includes(name)).sort(), [...BOTH_CALLS].sort(), "calls on both lists");
});

test("has no client but github and patClient in front of .rest, so a read can't go through an alias (mpaulosky/dotfiles#231)", () => {
  const code = scriptCode();
  const clients = new Set([...code.matchAll(/([\w$]+)\.rest\./g)].map((match) => match[1]));

  assert.deepEqual([...clients].sort(), ["github", "patClient"]);
  assert.ok(!/eventsClient/.test(code), "eventsClient is gone: github is GITHUB_TOKEN's client now");
});

test("makes the one PAT client from PAT_TOKEN and nothing else (mpaulosky/dotfiles#231)", () => {
  const code = scriptCode();

  assert.equal(code.match(/getOctokit\(/g)?.length, 1);
  assert.match(code, /const patClient = getOctokit\(process\.env\.PAT_TOKEN\);/);
});

// Every call on the PAT must be one of PAT_CALLS, and every call on
// GITHUB_TOKEN one that isn't.
function assertClients({ calls }, scenario) {
  assert.ok(calls.length > 0, `${scenario}: no calls`);
  for (const { client, call } of calls) {
    if (client === "pat") {
      assert.ok(PAT_CALLS.includes(call), `${scenario}: ${call} went through the PAT`);
    } else {
      assert.ok(BOTH_CALLS.includes(call) || !PAT_CALLS.includes(call), `${scenario}: ${call} went through GITHUB_TOKEN`);
      assert.ok(TOKEN_CALLS.includes(call), `${scenario}: ${call} is missing from TOKEN_CALLS`);
    }
  }
}

const patCallsOf = ({ calls }) => calls.filter(({ client }) => client === "pat").map(({ call }) => call);
const tokenCallsOf = ({ calls }) => calls.filter(({ client }) => client === "token").map(({ call }) => call);

test("makes every read with GITHUB_TOKEN and only the PAT's six calls with the PAT (mpaulosky/dotfiles#231)", async () => {
  const atCap = readyPr({
    copilotReviews: copilotReviewsOf(),
    claudeReviews: claudeReviewsOf("one", "two", HEAD),
    reviewThreads: threadsBy({ login: ACTIONS, review: "claude-3" }),
    labels: labelled("enhancement", CLAUDE_LABEL)
  });
  const workflowRun = { name: "Claude Review", head_sha: "rev" };
  const associated = [{ number: 7, state: "open", head: { sha: "merge1" } }];
  const scenarios = {
    "a ready merge": { run: await evaluate(readyPr()), pat: ["pulls.merge"], token: ["graphql", "issues.listEvents"] },
    "an update of a BEHIND PR": {
      run: await evaluate(readyPr({ mergeStateStatus: "BEHIND" })),
      pat: ["pulls.updateBranch"],
      token: ["graphql"]
    },
    "a sweep that updates a BEHIND PR": {
      run: await evaluate(readyPr({ mergeStateStatus: "BEHIND" }), [], { push: true }),
      pat: ["pulls.updateBranch"],
      token: ["pulls.list", "graphql", "repos.getBranchRules"]
    },
    "a rebase request to Dependabot": {
      run: await evaluate(dependabotPr(), [], { prCommits: DEPENDABOT_COMMITS }),
      pat: ["users.getAuthenticated", "issues.createComment"],
      token: ["pulls.listCommits", "issues.listComments"]
    },
    "calling in Claude when Copilot's quota is used up": {
      run: await evaluate(readyPr({ copilotReviews: DECLINED })),
      pat: ["issues.addLabels"],
      token: ["graphql"]
    },
    "asking Copilot once, then calling in Claude when the request is dropped (mpaulosky/dotfiles#360)": {
      run: await evaluate(readyPr({ copilotReviews: copilotReviewsOf("one") })),
      pat: ["graphql", "issues.addLabels"],
      token: ["graphql", "issues.createComment"]
    },
    "taking review:claude off at the review cap": {
      run: await evaluate(atCap),
      pat: [],
      token: ["issues.removeLabel"]
    },
    "a workflow_run event on a clean merge from main": {
      run: await evaluate(mergedPr("merge1"), [], { workflowRun, associated }),
      pat: ["pulls.merge"],
      token: [
        "repos.listPullRequestsAssociatedWithCommit",
        "repos.compareCommitsWithBasehead",
        "git.getCommit",
        "git.getTree"
      ]
    }
  };

  for (const [name, { run: result, pat, token }] of Object.entries(scenarios)) {
    assertClients(result, name);
    assert.deepEqual([...new Set(patCallsOf(result))].sort(), [...pat].sort(), `${name}: the PAT's calls`);
    for (const call of token) {
      assert.ok(tokenCallsOf(result).includes(call), `${name}: ${call} should go through GITHUB_TOKEN`);
    }
  }
});

test("reads a head's workflow runs with GITHUB_TOKEN when no check is required, and adds review:claude with the PAT (mpaulosky/dotfiles#231)", async () => {
  const headRef = checksOn(HEAD, requiredCheck("Build Solution", { isRequired: false }));
  const result = await evaluate(readyPr({ copilotReviews: DECLINED, headRef }), [], { push: true, requiredChecks: [] });

  assertClients(result, "no required check");
  assert.ok(tokenCallsOf(result).includes("actions.listWorkflowRunsForRepo"), JSON.stringify(result.calls));
  assert.deepEqual(patCallsOf(result), ["issues.addLabels"]);
});

test("makes no PAT call at all when it writes nothing (mpaulosky/dotfiles#231)", async () => {
  const result = await evaluate(readyPr({ labels: labelled("enhancement", NEEDS_HUMAN) }));

  assertClients(result, "a run that writes nothing");
  assert.deepEqual(patCallsOf(result), []);
  assert.ok(tokenCallsOf(result).length > 0);
});

// The workflow's own text: the token each client is made from, and the
// permissions GITHUB_TOKEN's reads need (mpaulosky/dotfiles#231).
function workflowLines() {
  return readFileSync(WORKFLOW, "utf8").split("\n");
}

test("authenticates github with GITHUB_TOKEN and the PAT client with RELEASE_PR_PAT, falling back to GITHUB_TOKEN (mpaulosky/dotfiles#231)", () => {
  const lines = workflowLines();

  assert.ok(lines.some((line) => /^\s*github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}\s*$/.test(line)), "with: github-token");
  assert.ok(
    lines.some((line) => /^\s*PAT_TOKEN: \$\{\{ secrets\.RELEASE_PR_PAT \|\| secrets\.GITHUB_TOKEN \}\}\s*$/.test(line)),
    "env: PAT_TOKEN"
  );
  assert.ok(!lines.some((line) => /EVENTS_TOKEN/.test(line)), "EVENTS_TOKEN is gone");
  assert.ok(!lines.some((line) => /^\s*github-token: .*RELEASE_PR_PAT/.test(line)), "with: github-token is not the PAT");
});

test("grants the job the permissions GITHUB_TOKEN's reads need (mpaulosky/dotfiles#231)", () => {
  const lines = workflowLines();
  const at = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  assert.notEqual(at, -1, "pr-automerge.yml has no permissions: block");
  const granted = {};
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const match = line.match(/^ {2}([a-z-]+): (read|write|none)\s*$/);
    if (!match) {
      break;
    }
    granted[match[1]] = match[2];
  }

  // issues: label events and comments; actions: workflow runs; checks and
  // statuses: the head's check runs and commit statuses in the GraphQL read;
  // pull-requests: write takes review:claude off, and merges without a PAT.
  assert.equal(granted.issues, "read");
  assert.equal(granted.actions, "read");
  assert.equal(granted.checks, "read");
  assert.equal(granted.statuses, "read");
  assert.equal(granted["pull-requests"], "write");
  assert.equal(granted.contents, "write");
});

test("says in the comment above github-token that GITHUB_TOKEN makes the reads and takes review:claude off at MAX_CLAUDE_ROUNDS", () => {
  const comment = commentAbove(/^\s*github-token: /);

  assert.match(comment, /GITHUB_TOKEN/);
  assert.match(comment, /review:claude/);
  assert.match(comment, /MAX_CLAUDE_ROUNDS/);
});

test("says in the patClient comment that the PAT adds review:claude and needs Pull requests (or Issues) write", () => {
  const comment = commentAbove(/^\s*const patClient = /);

  assert.match(comment, /\badd(s|ed)?\b[^.]*review:claude|review:claude[^.]*\badd(s|ed)?\b/);
  assert.match(comment, /RELEASE_PR_PAT|\bthe PAT\b/);
  assert.match(comment, /pull[ -]requests/i);
  assert.match(comment, /\bwrite\b/i);
});

// ── Resolved bot threads nobody replied to: a notice, never a hold ──────────

const UNREPLIED = "resolved without a reply";
const CLAUDE_REVIEW_BODY = CLAUDE_MARKER + "\nNo findings.";

const unrepliedNotices = (logs) => logs.filter((line) => line.startsWith("notice: PR #7") && line.includes(UNREPLIED));

test("merges a PR with a resolved Copilot thread nobody replied to, and logs a notice naming path:line and the url", async () => {
  const pr = readyPr({
    reviewThreads: threadsBy({ login: COPILOT, resolved: true, path: "src/a.py", line: 12, url: "https://github.com/octo/repo/pull/7#discussion_r99" })
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1, logs.join("\n"));
  const notices = unrepliedNotices(logs);
  assert.equal(notices.length, 1, logs.join("\n"));
  assert.ok(notices[0].includes("src/a.py:12") && notices[0].includes("https://github.com/octo/repo/pull/7#discussion_r99"), notices[0]);
  assert.ok(notices[0].includes("PROCESS.md"), notices[0]);
});

test("logs the notice for a resolved Claude Review thread nobody replied to", async () => {
  const pr = readyPr({
    reviewThreads: threadsBy({ login: ACTIONS, review: "claude-1", reviewBody: CLAUDE_REVIEW_BODY, resolved: true, path: "b.py", line: 3 })
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1, logs.join("\n"));
  assert.ok(unrepliedNotices(logs).some((line) => line.includes("b.py:3")), logs.join("\n"));
});

test("logs no notice for a resolved bot thread that has a reply", async () => {
  const pr = readyPr({
    reviewThreads: threadsBy(
      { login: COPILOT, resolved: true, replies: [OWNER] },
      { login: ACTIONS, review: "claude-1", reviewBody: CLAUDE_REVIEW_BODY, resolved: true, replies: [OWNER] }
    )
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1, logs.join("\n"));
  assert.deepEqual(unrepliedNotices(logs), [], logs.join("\n"));
});

test("counts a reply by the opener itself as no reply", async () => {
  const pr = readyPr({ reviewThreads: threadsBy({ login: COPILOT, resolved: true, replies: [COPILOT] }) });
  const { logs } = await evaluate(pr);

  assert.equal(unrepliedNotices(logs).length, 1, logs.join("\n"));
});

test("logs no notice for a person's resolved thread, one with no author or another bot's", async () => {
  const pr = readyPr({
    reviewThreads: threadsBy(
      { login: OWNER, resolved: true },
      { login: null, resolved: true },
      { login: "dependabot", kind: "Bot", resolved: true },
      { login: COPILOT, kind: "User", resolved: true }
    )
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1, logs.join("\n"));
  assert.deepEqual(unrepliedNotices(logs), [], logs.join("\n"));
});

test("logs no notice for a github-actions thread whose review is not Claude Review's", async () => {
  const pr = readyPr({
    reviewThreads: threadsBy({ login: ACTIONS, review: "other-1", reviewBody: "Some other workflow's review.", resolved: true })
  });
  const { logs } = await evaluate(pr);

  assert.deepEqual(unrepliedNotices(logs), [], logs.join("\n"));
});

test("logs no notice for a resolved thread with more comments than were read", async () => {
  const pr = readyPr({ reviewThreads: threadsBy({ login: COPILOT, resolved: true, total: 11 }) });
  const { logs } = await evaluate(pr);

  assert.deepEqual(unrepliedNotices(logs), [], logs.join("\n"));
});

test("an unresolved bot thread still waits and logs no notice", async () => {
  const pr = readyPr({ reviewThreads: threadsBy(COPILOT, { login: COPILOT, resolved: true }) });
  const { merges, logs } = await evaluate(pr);

  assert.deepEqual(merges, []);
  assert.ok(logs.some((line) => line.includes("1 unresolved review thread(s)")), logs.join("\n"));
  assert.deepEqual(unrepliedNotices(logs), [], logs.join("\n"));
});

test("names at most three unreplied threads in the notice and counts the rest", async () => {
  const pr = readyPr({
    reviewThreads: threadsBy(...[1, 2, 3, 4, 5].map((line) => ({ login: COPILOT, resolved: true, path: `f${line}.py`, line })))
  });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1, logs.join("\n"));
  const notices = unrepliedNotices(logs);
  assert.equal(notices.length, 1, logs.join("\n"));
  for (const named of ["f1.py:1", "f2.py:2", "f3.py:3", "and 2 more"]) {
    assert.ok(notices[0].includes(named), notices[0]);
  }
  assert.ok(!notices[0].includes("f4.py") && !notices[0].includes("f5.py"), notices[0]);
});

test("escapes control, bidi and zero-width characters in a thread's path in the notice, as the Python status line does", async () => {
  const path = "a\nb\x1b[31m\u202Ec\u200Bd\x7F\x85.py";
  const { merges, logs } = await evaluate(readyPr({ reviewThreads: threadsBy({ login: COPILOT, resolved: true, path, line: 4 }) }));

  assert.equal(merges.length, 1, logs.join("\n"));
  const notices = unrepliedNotices(logs);
  assert.equal(notices.length, 1, logs.join("\n"));
  assert.ok(notices[0].includes("a\\nb\\x1b[31m\\u202ec\\u200bd\\x7f\\x85.py:4"), notices[0]);
  assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u202E]/u.test(notices[0].replace(/\n/g, "")), notices[0]);
});

test("names a thread by line ?? originalLine and strips [bot] from the opener's login", async () => {
  const thread = threadsBy({ login: COPILOT + "[bot]", resolved: true, path: "d.py", kind: "Bot" }).nodes[0];
  thread.line = null;
  thread.originalLine = 9;
  const { merges, logs } = await evaluate(readyPr({ reviewThreads: { totalCount: 1, nodes: [thread] } }));

  assert.equal(merges.length, 1, logs.join("\n"));
  assert.ok(unrepliedNotices(logs).some((line) => line.includes("d.py:9")), logs.join("\n"));
});

test("old thread nodes without comments or a path log no notice and don't throw", async () => {
  const pr = readyPr({ reviewThreads: { totalCount: 2, nodes: [{ isResolved: true }, { isResolved: true, comments: null }] } });
  const { merges, logs } = await evaluate(pr);

  assert.equal(merges.length, 1, logs.join("\n"));
  assert.deepEqual(unrepliedNotices(logs), [], logs.join("\n"));
});

test("asks GraphQL for each thread's path, comments, their authors and their review's body", async () => {
  const { queries } = await evaluate(readyPr());

  assert.ok(queries.length > 0);
  for (const query of queries) {
    const threads = query.slice(query.indexOf("reviewThreads(first: 100)"));
    for (const field of ["path", "originalLine", "comments(first:", "totalCount", "url", "__typename", "pullRequestReview", "body"]) {
      assert.ok(threads.includes(field), `reviewThreads lacks ${field}\n${query}`);
    }
  }
});

"""Tests for github/settings.py against an in-memory GitHub.

FakeGitHub keeps the state the script reads and writes (repo settings,
workflows, rulesets, labels, secrets, protection), so a test can run --fix and
then check that a second run finds nothing left to change. Every write is
logged in fake.writes.
"""

import base64
import io
import json
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import settings as gs  # noqa: E402

REPO = "owner/app"
STANDARD = json.loads((Path(gs.HERE) / "settings.json").read_text())
LABELS = json.loads((Path(gs.HERE) / "labels.json").read_text())

PINNED = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
# Only a workflow that runs on every PR can report a required check.
ON_PR = '"on":\n  pull_request:\n    types: [opened, synchronize]\n'

# Every standard required check, reported by workflows the way the Template's do.
CI = f"""name: Build and Test Suite
{ON_PR}jobs:
  branch-name:
    name: Branch name
    steps:
      - uses: {PINNED}
  build:
    name: Build Solution
    steps:
      - uses: {PINNED}
  test:
    name: "Tests: ${{{{ matrix.test_name }}}}"
  report:
    name: Test Suite
"""
LINTS = f"""{ON_PR}jobs:
  actionlint:
    name: actionlint
    steps:
      - uses: docker://rhysd/actionlint@sha256:{'b' * 64}
  zizmor:
    name: zizmor
  shellcheck:
    name: shellcheck
  markdownlint:
    name: markdownlint
  yamllint:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/local
"""
PR_TITLE = ON_PR + """jobs:
  title:
    name: PR title
"""
AUTOMERGE = """jobs:
  merge-when-ready:
    steps:
      - with:
          script: |
            const COPILOT_REVIEW_CAP = 3;
"""


def matching_ruleset(checks):
    ruleset = json.loads((Path(gs.HERE) / "main-rules.json").read_text())
    for rule in ruleset["rules"]:
        if rule["type"] == "required_status_checks":
            rule["parameters"]["required_status_checks"] = [{"context": c, "integration_id": 15368} for c in checks]
    return {"id": 7, **ruleset}


class FakeGitHub:
    def __init__(self, **state):
        self.repo = {"default_branch": "main", **STANDARD["repo"],
                     "security_and_analysis": {"secret_scanning": {"status": "enabled"},
                                               "secret_scanning_push_protection": {"status": "enabled"}}}
        self.alerts = True
        self.security_fixes = True
        self.default_setup = "not-configured"
        self.workflow_permissions = dict(STANDARD["actions_workflow"])
        self.actions = {"enabled": True, "allowed_actions": "all", "sha_pinning_required": True}
        self.workflows = {".github/workflows/ci.yml": CI, ".github/workflows/lint.yml": LINTS,
                          ".github/workflows/pr-title.yml": PR_TITLE,
                          ".github/workflows/pr-automerge.yml": AUTOMERGE}
        self.rulesets = {7: matching_ruleset(STANDARD["required_checks"])}
        self.labels = {label["name"]: dict(label) for label in LABELS}
        self.secrets = list(STANDARD["required_secrets"])
        self.protection = False
        self.rulesets_forbidden = False
        self.writes = []
        for key, value in state.items():
            setattr(self, key, value)

    def api(self, method, path, body=None):
        if method != "GET":
            self.writes.append((method, path, body))
        path = path.removeprefix(f"repos/{REPO}")
        route, _, _query = path.partition("?")
        if route == "" and method == "GET":
            return json.loads(json.dumps(self.repo))
        if route == "" and method == "PATCH":
            for key, value in body.items():
                if key == "security_and_analysis":
                    self.repo[key].update(value)
                else:
                    self.repo[key] = value
            return {}
        if route == "/vulnerability-alerts":
            if method == "PUT":
                self.alerts = True
                return None
            if not self.alerts:
                raise gs.ApiError(404, "Not Found")
            return None
        if route == "/automated-security-fixes":
            if method == "PUT":
                self.security_fixes = True
                return None
            return {"enabled": self.security_fixes, "paused": False}
        if route == "/code-scanning/default-setup":
            if method == "PATCH":
                self.default_setup = body["state"]
                return {}
            return {"state": self.default_setup}
        if route == "/actions/permissions/workflow":
            if method == "PUT":
                self.workflow_permissions = dict(body)
                return None
            return dict(self.workflow_permissions)
        if route == "/actions/permissions":
            if method == "PUT":
                self.actions = dict(body)
                return None
            return dict(self.actions)
        if route == "/contents/.github/workflows":
            if not self.workflows:
                raise gs.ApiError(404, "Not Found")
            return [{"name": Path(p).name, "path": p} for p in self.workflows]
        if route.startswith("/contents/"):
            text = self.workflows[route.removeprefix("/contents/")]
            return {"content": base64.b64encode(text.encode()).decode()}
        if route == "/rulesets":
            if self.rulesets_forbidden:
                raise gs.ApiError(403, "Upgrade to GitHub Pro")
            if method == "POST":
                self.rulesets[99] = {"id": 99, **body}
                return self.rulesets[99]
            return [{"id": i, "name": r["name"]} for i, r in self.rulesets.items()]
        if route.startswith("/rulesets/"):
            ruleset_id = int(route.rsplit("/", 1)[1])
            if method == "PUT":
                # Like GitHub's, an update must carry the whole ruleset.
                missing = {"name", "target", "enforcement", "conditions", "rules"} - set(body)
                if missing:
                    raise gs.ApiError(422, f"Invalid request: missing {sorted(missing)}")
                self.rulesets[ruleset_id].update(body)
                return self.rulesets[ruleset_id]
            if method == "DELETE":
                del self.rulesets[ruleset_id]
                return None
            return json.loads(json.dumps(self.rulesets[ruleset_id]))
        if route == "/branches/main/protection":
            if method == "DELETE":
                self.protection = False
                return None
            if not self.protection:
                raise gs.ApiError(404, "Branch not protected")
            return {}
        if route == "/labels":
            if method == "POST":
                self.labels[body["name"]] = dict(body)
                return body
            return [dict(label) for label in self.labels.values()]
        if route.startswith("/labels/"):
            name = unquote(route.removeprefix("/labels/"))
            if method == "DELETE":
                del self.labels[name]
                return None
            self.labels[name].update(body)
            return self.labels[name]
        if route == "/actions/secrets":
            return {"secrets": [{"name": n} for n in self.secrets]}
        raise AssertionError(f"unexpected call: {method} {path}")


def run(fake, *args, repo=REPO):
    out = io.StringIO()
    status = gs.main([*args, repo], gh=fake, out=out)
    return status, out.getvalue()


def statuses(fake, **kwargs):
    return {f.area: f.status for f in gs.check(fake, REPO, **kwargs)}


# ── The happy path and idempotence ──────────────────────────────────────────

def test_a_repo_at_the_standard_passes_and_fix_writes_nothing():
    fake = FakeGitHub()

    status, output = run(fake, "--fix")

    assert status == 0, output
    assert fake.writes == []


def test_fix_brings_a_drifted_repo_to_the_standard_and_a_second_fix_writes_nothing():
    fake = FakeGitHub(
        repo={"default_branch": "main", **STANDARD["repo"], "allow_merge_commit": True,
              "squash_merge_commit_message": "COMMIT_MESSAGES",
              "security_and_analysis": {"secret_scanning": {"status": "disabled"},
                                        "secret_scanning_push_protection": {"status": "disabled"}}},
        alerts=False, security_fixes=False,
        workflow_permissions={"default_workflow_permissions": "write", "can_approve_pull_request_reviews": False},
        actions={"enabled": True, "allowed_actions": "all", "sha_pinning_required": False},
        rulesets={}, labels={},
    )

    first, output = run(fake, "--fix")
    writes = len(fake.writes)
    second, _ = run(fake, "--fix")

    assert first == 0, output
    assert second == 0
    assert len(fake.writes) == writes, fake.writes[writes:]


def test_check_only_never_writes():
    fake = FakeGitHub(rulesets={}, labels={}, alerts=False)

    status, _ = run(fake)

    assert status == 1
    assert fake.writes == []


# ── Repo settings ───────────────────────────────────────────────────────────

def test_repo_settings_drift_patches_only_the_differing_keys():
    fake = FakeGitHub(repo={"default_branch": "main", **STANDARD["repo"], "allow_rebase_merge": True,
                            "squash_merge_commit_title": "COMMIT_OR_PR_TITLE",
                            "security_and_analysis": FakeGitHub().repo["security_and_analysis"]})

    run(fake, "--fix")

    assert ("PATCH", f"repos/{REPO}", {"allow_rebase_merge": False, "squash_merge_commit_title": "PR_TITLE"}) in fake.writes


# ── Ruleset ─────────────────────────────────────────────────────────────────

def test_a_missing_ruleset_is_created_requiring_only_checks_a_workflow_reports():
    fake = FakeGitHub(rulesets={}, workflows={".github/workflows/ci.yml": CI})

    status, output = run(fake, "--fix")

    created = next(body for method, path, body in fake.writes if method == "POST" and path.endswith("/rulesets"))
    [checks_rule] = [r for r in created["rules"] if r["type"] == "required_status_checks"]
    assert [c["context"] for c in checks_rule["parameters"]["required_status_checks"]] == \
        ["Build Solution", "Test Suite", "Branch name"]
    assert status == 1, "the checks no workflow reports leave a MANUAL finding"
    assert "no workflow on the default branch reports PR title, actionlint" in output


def test_a_repo_with_no_workflows_gets_a_ruleset_without_the_checks_rule():
    fake = FakeGitHub(rulesets={}, workflows={})

    run(fake, "--fix")

    created = next(body for method, path, body in fake.writes if method == "POST")
    assert "required_status_checks" not in {rule["type"] for rule in created["rules"]}


def test_ruleset_drift_is_replaced_with_the_standard():
    live = matching_ruleset(STANDARD["required_checks"])
    live["bypass_actors"] = [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request"}]
    live["rules"].append({"type": "code_quality", "parameters": {"severity": "errors"}})
    for rule in live["rules"]:
        if rule["type"] == "pull_request":
            rule["parameters"]["required_review_thread_resolution"] = True
            rule["parameters"]["allowed_merge_methods"] = ["rebase", "squash"]
    fake = FakeGitHub(rulesets={7: live})

    findings = {f.area: f for f in gs.check(fake, REPO)}
    run(fake, "--fix")

    detail = findings["ruleset main-rules"].detail
    for expected in ("bypass_actors", "rule code_quality: remove", "required_review_thread_resolution: true → false",
                     'allowed_merge_methods: ["rebase", "squash"] → ["squash"]'):
        assert expected in detail
    assert statuses(fake)["ruleset main-rules"] == gs.OK
    assert "code_quality" not in {rule["type"] for rule in fake.rulesets[7]["rules"]}


def test_a_required_check_outside_the_standard_stays_while_a_workflow_reports_it():
    # Before a Standardize, the repo's old test gate is its only one.
    old_ci = ON_PR + "jobs:\n  gate:\n    name: All Tests Passed\n"
    live = matching_ruleset(["All Tests Passed", "Gone Check"])
    fake = FakeGitHub(rulesets={7: live}, workflows={".github/workflows/old.yml": old_ci})

    run(fake, "--fix")

    [checks_rule] = [r for r in fake.rulesets[7]["rules"] if r["type"] == "required_status_checks"]
    assert [c["context"] for c in checks_rule["parameters"]["required_status_checks"]] == ["All Tests Passed"]


def test_a_required_check_from_another_app_is_drift():
    live = matching_ruleset(STANDARD["required_checks"])
    for rule in live["rules"]:
        if rule["type"] == "required_status_checks":
            rule["parameters"]["required_status_checks"][0].pop("integration_id")
    fake = FakeGitHub(rulesets={7: live})

    assert statuses(fake)["ruleset main-rules"] == gs.DRIFT
    run(fake, "--fix")
    assert statuses(fake)["ruleset main-rules"] == gs.OK


def test_a_suspended_ruleset_fails_the_check_and_fix_restores_it():
    fake = FakeGitHub()
    rules_before = json.loads(json.dumps(fake.rulesets[7]["rules"]))

    assert run(fake, "--suspend")[0] == 0
    assert fake.rulesets[7]["enforcement"] == "disabled"
    assert fake.rulesets[7]["rules"] == rules_before, "suspending keeps every rule"
    status, output = run(fake)
    assert status == 1 and "SUSPENDED" in output

    run(fake, "--fix")
    assert fake.rulesets[7]["enforcement"] == "active"


def test_rulesets_unavailable_is_reported_but_doesnt_fail():
    fake = FakeGitHub(rulesets_forbidden=True)

    status, output = run(fake)

    assert status == 0, output
    assert "UNAVAILABLE ruleset main-rules" in output


def test_other_rulesets_are_left_alone_and_legacy_ones_deleted_only_on_request():
    fake = FakeGitHub()
    fake.rulesets[8] = {"id": 8, "name": "dev-rules", "rules": []}
    fake.rulesets[9] = {"id": 9, "name": "release-rules", "rules": []}

    assert statuses(fake)["ruleset dev-rules"] == gs.LEGACY
    run(fake, "--fix")
    assert 8 in fake.rulesets

    run(fake, "--fix", "--remove-legacy")
    assert 8 not in fake.rulesets
    assert 9 in fake.rulesets


def test_classic_protection_is_removed_only_on_request_and_only_with_main_rules_active():
    fake = FakeGitHub(protection=True, rulesets={})

    run(fake, "--fix", "--remove-legacy")
    assert fake.protection, "main-rules was only created in this run"

    run(fake, "--fix", "--remove-legacy")
    assert not fake.protection


# ── Actions ─────────────────────────────────────────────────────────────────

def test_pinning_is_required_only_once_every_workflow_is_pinned():
    unpinned = CI + "  extra:\n    steps:\n      - uses: actions/setup-node@v4\n"
    fake = FakeGitHub(actions={"enabled": True, "allowed_actions": "all", "sha_pinning_required": False},
                      workflows={".github/workflows/ci.yml": unpinned})

    findings = {f.area: f for f in gs.check(fake, REPO)}
    run(fake, "--fix")

    assert findings["pinned actions"].status == gs.MANUAL
    assert "actions/setup-node@v4" in findings["pinned actions"].detail
    assert not fake.actions["sha_pinning_required"]


def test_unpinned_actions_are_reported_even_once_pinning_is_required():
    fake = FakeGitHub()
    fake.workflows[".github/workflows/extra.yml"] = ON_PR + "jobs:\n  node:\n    steps:\n      - uses: actions/setup-node@v4\n"

    finding = next(f for f in gs.check(fake, REPO) if f.area == "pinned actions")

    assert finding.status == gs.MANUAL
    assert finding.detail == ("required, so GitHub refuses to run these until they're pinned to a commit SHA: "
                              "actions/setup-node@v4")


def test_only_workflows_that_run_on_every_pr_can_report_a_required_check():
    # A scheduled workflow, or one a PR can skip by its paths, never reports on some PRs.
    fake = FakeGitHub(workflows={
        ".github/workflows/ci.yml": CI.replace(ON_PR, '"on":\n  schedule:\n    - cron: "0 0 * * *"\n'),
        ".github/workflows/lint.yml": LINTS.replace(ON_PR, '"on":\n  pull_request:\n    paths-ignore:\n      - "docs/**"\n'),
        ".github/workflows/pr-title.yml": PR_TITLE,
    }, rulesets={})

    run(fake, "--fix")

    [checks_rule] = [r for r in fake.rulesets[99]["rules"] if r["type"] == "required_status_checks"]
    assert [c["context"] for c in checks_rule["parameters"]["required_status_checks"]] == ["PR title"]


@pytest.mark.parametrize("text, runs", [
    ('"on":\n  pull_request:\n    types: [opened, synchronize]\n  push:\n    branches: [main]\n', True),
    ("on:\n  pull_request:\n    types:\n      - opened\n      - edited\n      - synchronize\n", True),
    ("on:\n  pull_request:\n    types: [opened]\n", False),  # a pushed head gets no check
    ("on:\n  pull_request:\n    types: [closed]\n", False),  # release.yml
    ("on:\n  pull_request:\n    branches: [main]\n", True),
    ("on:\n  pull_request:\n    branches:\n      - 'release/**'\n      - main\n", True),
    ("on:\n  pull_request:\n    branches: ['**']\n", True),
    ("on:\n  pull_request:\n    branches: [develop]\n", False),
    ("on:\n  pull_request:\n    branches: ['m*', '!main']\n", False),
    ("on:\n  pull_request:\n    branches-ignore: [main]\n", False),
    ("on:\n  pull_request:\n    branches-ignore: ['release/*']\n", True),
    ("on:\n  pull_request:\n    branches: ['[m]ain']\n", True),
    ("on: {pull_request: {paths-ignore: ['docs/**']}}\n", False),  # flow mappings aren't parsed
    ("on: {pull_request: {}}\n", False),
    ("on:\n  pull_request:\n  # a comment between triggers\n  push:\n", True),
    ("on: pull_request\n", True),
    ("on: [push, pull_request]\n", True),
    ("on:\n  pull_request:\n    paths-ignore:\n      - docs/**\n", False),
    ("on:\n  pull_request:\n    paths:\n      - src/**\n", False),
    ("on:\n  pull_request_target:\n    types: [opened]\n", False),
    ("on: [push, pull_request_target]\n", False),
    ('on:\n  schedule:\n    - cron: "0 0 * * *"\n', False),
    ("jobs:\n  a:\n    name: A\n", False),
])
def test_runs_on_every_pr(text, runs):
    assert gs.runs_on_every_pr(text) is runs


@pytest.mark.parametrize("pattern, branch, matches", [
    ("main", "main", True),
    ("mai", "main", False),
    ("m*", "main", True),
    ("*", "release/1", False),  # * stops at /
    ("**", "release/1", True),
    ("release/**", "release/1/hotfix", True),
    ("mains?", "main", True),  # ? is zero or one of the character before it
    ("mains?", "mains", True),
    ("ma?in", "main", True),
    ("mai?n", "man", True),
    ("mai?n", "maxn", False),  # ? isn't any one character
    ("ma+in", "maaain", True),  # + is one or more of the character before it
    ("ma+in", "min", False),
    ("[m]ain", "main", True),
    ("[a-z]ain", "main", True),
    ("[0-9]ain", "main", False),
    ("v1.0", "v1x0", False),  # . is literal
    ("feature\\*", "feature*", True),  # \ escapes
    ("feature\\*", "feature-x", False),
    ("?main", "main", False),  # nothing before ?: a literal ?
])
def test_branch_patterns_follow_github_filter_syntax(pattern, branch, matches):
    assert gs.branch_matches(pattern, branch) is matches


def test_a_branch_filter_is_read_against_the_default_branch():
    text = "on:\n  pull_request:\n    branches: [develop]\n"

    assert gs.runs_on_every_pr(text, "develop")
    assert not gs.runs_on_every_pr(text, "main")


def test_codeql_default_setup_is_turned_off_where_the_workflow_runs_codeql():
    fake = FakeGitHub(default_setup="configured")
    fake.workflows[".github/workflows/codeql-analysis.yml"] = "jobs:\n  analyze:\n    name: Analyze\n"

    run(fake, "--fix")

    assert fake.default_setup == "not-configured"


# ── Labels and secrets ──────────────────────────────────────────────────────

def test_labels_are_created_and_corrected_and_squad_labels_deleted():
    labels = {label["name"]: dict(label) for label in LABELS[1:]}
    labels["docs-only"]["color"] = "ededed"
    labels["squad"] = {"name": "squad", "color": "000000", "description": ""}
    labels["squad:mal"] = {"name": "squad:mal", "color": "000000", "description": ""}
    labels["bug"] = {"name": "bug", "color": "d73a4a", "description": ""}
    fake = FakeGitHub(labels=labels)

    assert statuses(fake)["label squad:mal"] == gs.DRIFT
    status, output = run(fake, "--fix")

    assert status == 0, output
    assert fake.labels[LABELS[0]["name"]]["color"] == LABELS[0]["color"]
    assert fake.labels["docs-only"]["color"] == "0075CA"
    assert ("PATCH", f"repos/{REPO}/labels/docs-only", {"color": "0075CA", "description": LABELS[2]["description"]}) \
        in fake.writes
    assert "squad" not in fake.labels and "squad:mal" not in fake.labels
    assert ("DELETE", f"repos/{REPO}/labels/squad%3Amal", None) in fake.writes
    assert "bug" in fake.labels, "labels outside the standard and not retired are left alone"


def test_the_review_cap_is_checked_in_pr_automerge():
    assert statuses(FakeGitHub())["review cap"] == gs.OK

    for text, expected in ((AUTOMERGE.replace("= 3;", "= 5;"), "cap 5"),
                           ("jobs:\n  merge:\n    name: Merge\n", "no review cap"),
                           (None, "no pr-automerge.yml")):
        fake = FakeGitHub()
        if text is None:
            del fake.workflows[".github/workflows/pr-automerge.yml"]
        else:
            fake.workflows[".github/workflows/pr-automerge.yml"] = text
        finding = next(f for f in gs.check(fake, REPO) if f.area == "review cap")
        assert finding.status == gs.MANUAL and expected in finding.detail, finding.detail


def test_a_missing_secret_needs_a_person():
    fake = FakeGitHub(secrets=[])

    status, output = run(fake, "--fix")

    assert status == 1
    assert "MANUAL      secret RELEASE_PR_PAT" in output


# ── Scope, per-repo additions and options ───────────────────────────────────

def test_a_repo_settings_only_repo_gets_just_its_merge_settings(monkeypatch, tmp_path):
    shutil.copytree(gs.HERE, tmp_path / "github", ignore=shutil.ignore_patterns("tests", "__pycache__"))
    (tmp_path / "github" / "repos.txt").write_text(f"{REPO} repo-settings-only\n")
    monkeypatch.setattr(gs, "HERE", tmp_path / "github")
    fake = FakeGitHub(rulesets_forbidden=True, secrets=[],
                      labels={"squad:frodo": {"name": "squad:frodo", "color": "000000", "description": ""}})

    status, output = run(fake, "--fix")

    assert status == 0, output
    assert fake.writes == [("DELETE", f"repos/{REPO}/labels/squad%3Afrodo", None)], \
        "only the retired label goes; nothing else outside the merge settings is touched"


def test_a_per_repo_file_can_add_a_required_check(monkeypatch, tmp_path):
    shutil.copytree(gs.HERE, tmp_path / "github", ignore=shutil.ignore_patterns("tests", "__pycache__"))
    (tmp_path / "github" / "repos" / "app.json").write_text('{"required_checks": ["Sandcastle"]}')
    monkeypatch.setattr(gs, "HERE", tmp_path / "github")
    fake = FakeGitHub()
    fake.workflows[".github/workflows/sandcastle.yml"] = ON_PR + "jobs:\n  sandcastle:\n    name: Sandcastle\n"

    run(fake, "--fix")

    [checks_rule] = [r for r in fake.rulesets[7]["rules"] if r["type"] == "required_status_checks"]
    assert "Sandcastle" in [c["context"] for c in checks_rule["parameters"]["required_status_checks"]]


def test_a_per_repo_file_cant_loosen_the_standard(monkeypatch, tmp_path):
    shutil.copytree(gs.HERE, tmp_path / "github", ignore=shutil.ignore_patterns("tests", "__pycache__"))
    (tmp_path / "github" / "repos" / "app.json").write_text('{"repo": {"allow_merge_commit": true}}')
    monkeypatch.setattr(gs, "HERE", tmp_path / "github")

    with pytest.raises(SystemExit, match="only required_checks and labels"):
        gs.check(FakeGitHub(), REPO)


def test_remove_legacy_needs_fix():
    with pytest.raises(SystemExit):
        gs.main(["--remove-legacy", REPO], gh=FakeGitHub(), out=io.StringIO())


def test_json_output_lists_each_finding():
    fake = FakeGitHub(secrets=[])

    status, output = run(fake, "--json")

    findings = json.loads(output)[REPO]
    assert status == 1
    assert {"area": "secret RELEASE_PR_PAT", "status": "MANUAL",
            "detail": "missing; add it in the repo's Actions secrets"} in findings


# ── Reading workflows ───────────────────────────────────────────────────────

def test_workflow_facts_reads_job_names_and_unpinned_actions():
    names, unpinned = gs.workflow_facts(CI + LINTS.replace(ON_PR + "jobs:\n", "") +
                                        "  node:\n    steps:\n      - uses: actions/setup-node@v4\n")

    assert names == ["Branch name", "Build Solution", "Test Suite", "actionlint", "zizmor", "shellcheck",
                     "markdownlint", "yamllint", "node"]
    assert unpinned == ["actions/setup-node@v4"]

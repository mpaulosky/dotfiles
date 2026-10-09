#!/usr/bin/env python3
"""Check, and with --fix apply, the Baseline's GitHub settings on a repo.

    github-settings.sh <owner/repo>...            report; exit 1 on any drift
    github-settings.sh --fix <owner/repo>...      report, apply, report again
    github-settings.sh --all [--fix]              every repo in github/repos.txt
    github-settings.sh --suspend <owner/repo>     emergency: main-rules off
    add --remove-legacy to --fix to delete the legacy items it lists
    add --json for machine-readable output

apply.sh copies the Baseline's files; this applies the settings files can't
carry: merge settings, security features, Actions permissions, the main-rules
ruleset and its required checks, labels, and a check that RELEASE_PR_PAT
exists. The standard is the JSON beside this file; github/repos/<repo>.json
may add required checks or labels for one repo, never remove or loosen
anything. See references/github-settings.md.

It changes only what it manages. Other rulesets, labels and classic branch
protection are reported; --remove-legacy deletes only those legacy.json names,
and classic protection only once main-rules is active. Squad is retired, so
its labels (settings.json's removed_label_prefixes) go on every --fix. A
required check is added only once a workflow on the default branch has the job
that reports it, so requiring a check can't block every PR before the repo
produces it.

PR Auto-Merge waits for a review of the head for at most three review rounds,
and holds on every unresolved thread past them (#146). A ruleset can't express
the cap, so main-rules leaves thread resolution off and the Template's
pr-automerge.yml enforces both; this checks every repo runs that cap.

Standard library only; GitHub is reached through `gh api`.
"""

import argparse
import base64
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
ACTIONS_APP_ID = 15368  # GitHub Actions, the app that reports every required check

OK, DRIFT, MANUAL, LEGACY, UNAVAILABLE, INFO = "OK", "DRIFT", "MANUAL", "LEGACY", "UNAVAILABLE", "INFO"
FAILING = {DRIFT, MANUAL, LEGACY}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


class Gh:
    """`gh api`, returning parsed JSON (None for an empty body) or raising ApiError."""

    def api(self, method, path, body=None):
        args = ["gh", "api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
        if body is not None:
            args += ["--input", "-"]
        run = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                             capture_output=True, text=True)
        if run.returncode != 0:
            match = re.search(r"HTTP (\d{3})", run.stderr)
            raise ApiError(int(match.group(1)) if match else 0, run.stderr.strip() or run.stdout.strip())
        return json.loads(run.stdout) if run.stdout.strip() else None


@dataclass
class Finding:
    area: str
    status: str
    detail: str
    fix: object = field(default=None, repr=False)  # callable applying the change, or None


def load_standard(repo):
    """The standard for repo: the shared files plus its additive github/repos/<name>.json."""
    standard = {
        "settings": json.loads((HERE / "settings.json").read_text()),
        "ruleset": json.loads((HERE / "main-rules.json").read_text()),
        "labels": json.loads((HERE / "labels.json").read_text()),
        "legacy": json.loads((HERE / "legacy.json").read_text()),
    }
    extra_path = HERE / "repos" / f"{repo.split('/')[-1]}.json"
    if extra_path.is_file():
        extra = json.loads(extra_path.read_text())
        unknown = set(extra) - {"required_checks", "labels"}
        if unknown:
            raise SystemExit(f"{extra_path}: only required_checks and labels may be added, not {sorted(unknown)}")
        checks = standard["settings"]["required_checks"]
        checks += [c for c in extra.get("required_checks", []) if c not in checks]
        names = {label["name"] for label in standard["labels"]}
        standard["labels"] += [label for label in extra.get("labels", []) if label["name"] not in names]
    return standard


# ── Workflows on the default branch ──────────────────────────────────────────

JOB = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$")
JOB_NAME = re.compile(r"^    name:\s*(.+?)\s*$")
USES = re.compile(r"^\s*-?\s*uses:\s*['\"]?([^'\"\s#]+)")
PINNED = re.compile(r"^(\./|docker://.+@sha256:[0-9a-f]{64}$|[^@]+@[0-9a-f]{40}$)")


def workflow_facts(text):
    """(check names the workflow's jobs report, unpinned `uses:` references) for one workflow file.

    A job reports its name:, or its id when it has none. A templated name
    (a matrix job's) can't be required, so it's left out.
    """
    names, unpinned, in_jobs, job, named = [], [], False, None, False
    for line in text.splitlines():
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
            continue
        if in_jobs and re.match(r"^\S", line):
            in_jobs = False
        if in_jobs and (match := JOB.match(line)):
            if job and not named:
                names.append(job)
            job, named = match.group(1), False
        elif in_jobs and job and not named and (match := JOB_NAME.match(line)):
            named = True
            name = match.group(1).strip("'\"")
            if "${{" not in name:
                names.append(name)
        if (match := USES.match(line)) and not PINNED.match(match.group(1)):
            unpinned.append(match.group(1))
    if job and not named:
        names.append(job)
    return names, unpinned


ON_KEY = re.compile(r"""^(?:"on"|'on'|on):(.*)$""")
# A pull_request trigger without these activity types misses a PR's first head
# (opened) or its later ones (synchronize). The default types include both.
PR_HEAD_TYPES = {"opened", "synchronize"}


def trigger_list(trigger, key):
    """The values of key (types, branches, ...) under a trigger's lines, or None when it isn't set.

    Reads the flow form (key: [a, b]), a single value (key: a) and the block form (key: then - a lines).
    """
    for position, line in enumerate(trigger):
        match = re.match(rf"^\s+{re.escape(key)}:(.*)$", line)
        if not match:
            continue
        inline = match.group(1).split("#")[0].strip()
        if inline:
            return [value.strip().strip("'\"") for value in inline.strip("[]").split(",") if value.strip()]
        values = []
        for nested in trigger[position + 1:]:
            if item := re.match(r"^\s+-\s*(.+?)\s*(?:#.*)?$", nested):
                values.append(item.group(1).strip("'\""))
            elif nested.strip() and not nested.lstrip().startswith("#"):
                break
        return values
    return None


def branch_regex(pattern):
    """A workflow branch filter pattern as a regex, with GitHub's filter syntax.

    * is any characters but /, ** any characters, ? zero or one of the
    character before it, + one or more of it, [a-z0-9] one listed
    alphanumeric, and \\ escapes the next character.
    """
    parts, index = [], 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\" and index + 1 < len(pattern):
            parts.append(re.escape(pattern[index + 1]))
            index += 2
            continue
        if pattern.startswith("**", index):
            parts.append(".*")
            index += 2
            continue
        if char == "*":
            parts.append("[^/]*")
        elif char in "?+" and parts and not parts[-1].endswith(("*", "?", "+")):
            parts.append(char)
        elif char == "[" and (match := re.match(r"\[([A-Za-z0-9-]+)\]", pattern[index:])):
            parts.append(match.group(0))
            index += len(match.group(0))
            continue
        else:
            parts.append(re.escape(char))
        index += 1
    return "".join(parts)


def branch_matches(pattern, branch):
    """Whether a workflow branch filter pattern matches branch."""
    try:
        return re.fullmatch(branch_regex(pattern), branch) is not None
    except re.error:  # A pattern GitHub wouldn't accept either matches nothing.
        return False


def filters_include(trigger, branch):
    """Whether the trigger's branches / branches-ignore filters let it run for PRs into branch."""
    if (ignored := trigger_list(trigger, "branches-ignore")) is not None:
        return not any(branch_matches(pattern, branch) for pattern in ignored)
    patterns = trigger_list(trigger, "branches")
    if patterns is None:
        return True
    included = False
    for pattern in patterns:  # Later patterns win, so a !pattern can exclude an earlier match.
        if pattern.startswith("!"):
            included = included and not branch_matches(pattern[1:], branch)
        elif branch_matches(pattern, branch):
            included = True
    return included


def runs_on_every_pr(text, branch="main"):
    """Whether the workflow reports on every head of every pull request into branch.

    Only such a workflow's checks can be required: a check that a PR's
    workflows never report would hold that PR forever. So it needs a
    pull_request trigger whose types (if set) include opened and
    synchronize, whose branch filters include branch, and with no paths
    filter. That leaves out a scheduled workflow, a types: [closed] one
    (release.yml), and one skipped by paths-ignore, like CodeQL's on docs PRs.
    """
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = ON_KEY.match(line)
        if not match:
            continue
        inline = match.group(1).split("#")[0].strip()
        if inline.startswith("{"):
            # A flow mapping (on: {pull_request: {paths: [...]}}) could hide any
            # filter, and its filters aren't parsed, so it doesn't count.
            return False
        if inline:  # on: pull_request / on: [push, pull_request]
            return re.search(r"\bpull_request\b(?!_)", inline) is not None
        block = []
        for following in lines[index + 1:]:
            if following.strip() and not following.startswith((" ", "#")):
                break
            block.append(following)
        for position, entry in enumerate(block):
            if re.match(r"^  (?:pull_request|- pull_request)\s*:?\s*(?:#.*)?$", entry):
                trigger = []
                for nested in block[position + 1:]:
                    if nested.strip() and not nested.startswith("    ") and not nested.lstrip().startswith("#"):
                        break
                    trigger.append(nested)
                if any(re.match(r"^\s+paths(-ignore)?:", nested) for nested in trigger):
                    return False
                types = trigger_list(trigger, "types")
                if types is not None and not PR_HEAD_TYPES <= set(types):
                    return False
                return filters_include(trigger, branch)
        return False
    return False


def read_workflows(gh, repo, branch):
    """{path: text} for the workflows on branch; {} when the repo has none."""
    try:
        listing = gh.api("GET", f"repos/{repo}/contents/.github/workflows?ref={branch}")
    except ApiError as error:
        if error.status == 404:
            return {}
        raise
    texts = {}
    for entry in listing:
        if entry["name"].endswith((".yml", ".yaml")):
            blob = gh.api("GET", f"repos/{repo}/contents/{entry['path']}?ref={branch}")
            texts[entry["path"]] = base64.b64decode(blob["content"]).decode("utf-8", "replace")
    return texts


# ── The checks ───────────────────────────────────────────────────────────────

def check_repo_flags(gh, repo, info, std):
    want = std["settings"]["repo"]
    diff = {key: value for key, value in want.items() if info.get(key) != value}
    if not diff:
        return [Finding("repo settings", OK, "merge, branch and forking settings")]
    detail = ", ".join(f"{key}: {info.get(key)!r} → {value!r}" for key, value in diff.items())
    return [Finding("repo settings", DRIFT, detail, lambda: gh.api("PATCH", f"repos/{repo}", diff))]


def check_security(gh, repo, info, std, workflows):
    want, findings = std["settings"]["security"], []
    analysis = info.get("security_and_analysis")
    if analysis is None:
        findings.append(Finding("secret scanning", UNAVAILABLE, "not offered for this repo (private without GHAS)"))
    else:
        for key in ("secret_scanning", "secret_scanning_push_protection"):
            if not want.get(key):
                continue
            current = (analysis.get(key) or {}).get("status")
            if current == "enabled":
                findings.append(Finding(key, OK, "enabled"))
            else:
                body = {"security_and_analysis": {key: {"status": "enabled"}}}
                findings.append(Finding(key, DRIFT, f"{current} → enabled",
                                        lambda body=body: gh.api("PATCH", f"repos/{repo}", body)))
    if want.get("vulnerability_alerts"):
        try:
            gh.api("GET", f"repos/{repo}/vulnerability-alerts")
            findings.append(Finding("Dependabot alerts", OK, "enabled"))
        except ApiError as error:
            if error.status != 404:
                raise
            findings.append(Finding("Dependabot alerts", DRIFT, "disabled → enabled",
                                    lambda: gh.api("PUT", f"repos/{repo}/vulnerability-alerts")))
    if want.get("automated_security_fixes"):
        try:
            fixes = gh.api("GET", f"repos/{repo}/automated-security-fixes") or {}
        except ApiError as error:
            if error.status != 404:
                raise
            fixes = {}
        if fixes.get("enabled"):
            findings.append(Finding("Dependabot security updates", OK, "enabled"))
        else:
            findings.append(Finding("Dependabot security updates", DRIFT, "disabled → enabled",
                                    lambda: gh.api("PUT", f"repos/{repo}/automated-security-fixes")))
    # GitHub rejects the advanced CodeQL workflow's results while default setup is on.
    try:
        setup = gh.api("GET", f"repos/{repo}/code-scanning/default-setup")
    except ApiError as error:
        if error.status not in (403, 404):
            raise
        findings.append(Finding("CodeQL default setup", UNAVAILABLE, "code scanning isn't offered for this repo"))
    else:
        advanced = any(Path(path).name.startswith("codeql") for path in workflows)
        if setup.get("state") == "configured" and advanced:
            findings.append(Finding("CodeQL default setup", DRIFT, "configured → not-configured (codeql-analysis.yml runs CodeQL)",
                                    lambda: gh.api("PATCH", f"repos/{repo}/code-scanning/default-setup",
                                                   {"state": "not-configured"})))
        else:
            findings.append(Finding("CodeQL default setup", OK, setup.get("state", "unknown")))
    return findings


def check_actions(gh, repo, std, workflows):
    findings = []
    want = std["settings"]["actions_workflow"]
    current = gh.api("GET", f"repos/{repo}/actions/permissions/workflow")
    diff = {key: value for key, value in want.items() if current.get(key) != value}
    if diff:
        detail = ", ".join(f"{key}: {current.get(key)!r} → {value!r}" for key, value in diff.items())
        findings.append(Finding("Actions token", DRIFT, detail,
                                lambda: gh.api("PUT", f"repos/{repo}/actions/permissions/workflow", want)))
    else:
        findings.append(Finding("Actions token", OK, "read by default; may create PRs"))
    if std["settings"].get("sha_pinning_required"):
        permissions = gh.api("GET", f"repos/{repo}/actions/permissions")
        unpinned = sorted({ref for text in workflows.values() for ref in workflow_facts(text)[1]})
        if unpinned:
            # Whether or not it's required yet: once it is, GitHub refuses these.
            if permissions.get("sha_pinning_required"):
                detail = "required, so GitHub refuses to run these until they're pinned to a commit SHA: "
            else:
                detail = "not required yet; pin these to a commit SHA first: "
            findings.append(Finding("pinned actions", MANUAL, detail + ", ".join(unpinned)))
        elif permissions.get("sha_pinning_required"):
            findings.append(Finding("pinned actions", OK, "required"))
        else:
            body = {"enabled": True, "allowed_actions": permissions.get("allowed_actions", "all"),
                    "sha_pinning_required": True}
            findings.append(Finding("pinned actions", DRIFT, "not required → required",
                                    lambda: gh.api("PUT", f"repos/{repo}/actions/permissions", body)))
    return findings


def wanted_ruleset(std, available_checks, live_required=()):
    """main-rules as it should be; (ruleset, standard checks the repo can't report yet, extra checks kept).

    A standard check is required only once a workflow reports it. A check the
    live ruleset requires outside the standard stays required while a workflow
    still reports it: before a Standardize, that's the repo's only test gate
    (IssueManager's All Tests Passed), and dropping it first would leave none.
    """
    ruleset = json.loads(json.dumps(std["ruleset"]))
    required = std["settings"]["required_checks"]
    present = [name for name in required if name in available_checks]
    missing = [name for name in required if name not in available_checks]
    kept = [name for name in live_required if name not in required and name in available_checks]
    present += kept
    for rule in ruleset["rules"]:
        if rule["type"] == "required_status_checks":
            rule["parameters"]["required_status_checks"] = [
                {"context": name, "integration_id": ACTIONS_APP_ID} for name in present]
    # GitHub refuses the rule with no checks, as for a repo with no workflows yet.
    if not present:
        ruleset["rules"] = [rule for rule in ruleset["rules"] if rule["type"] != "required_status_checks"]
    return ruleset, missing, kept


def ruleset_differences(live, want):
    """Human-readable differences between a live ruleset and the wanted one; [] when it matches."""
    diffs = []
    for key in ("target", "enforcement", "conditions", "bypass_actors"):
        live_value = live.get(key)
        if key == "conditions":
            live_value = {"ref_name": {k: sorted((live_value or {}).get("ref_name", {}).get(k, []))
                                       for k in ("include", "exclude")}}
        if live_value != want[key]:
            diffs.append(f"{key}: {json.dumps(live_value)} → {json.dumps(want[key])}")
    live_rules = {rule["type"]: rule.get("parameters") or {} for rule in live.get("rules", [])}
    want_rules = {rule["type"]: rule.get("parameters") or {} for rule in want["rules"]}
    for extra in sorted(set(live_rules) - set(want_rules)):
        diffs.append(f"rule {extra}: remove")
    for rule_type, params in want_rules.items():
        if rule_type not in live_rules:
            diffs.append(f"rule {rule_type}: add")
            continue
        for key, value in params.items():
            current = live_rules[rule_type].get(key)
            if key == "required_status_checks":
                # The app matters too: a check any app can report isn't a gate.
                current = sorted([check["context"], check.get("integration_id")] for check in current or [])
                value = sorted([check["context"], check.get("integration_id")] for check in value)
            elif key == "allowed_merge_methods":
                current, value = sorted(current or []), sorted(value)
            if current != value:
                diffs.append(f"{rule_type}.{key}: {json.dumps(current)} → {json.dumps(value)}")
    return diffs


def check_rulesets(gh, repo, std, workflows, default_branch, remove_legacy):
    try:
        summaries = gh.api("GET", f"repos/{repo}/rulesets?includes_parents=false")
    except ApiError as error:
        if error.status not in (403, 404):
            raise
        return [Finding("ruleset main-rules", UNAVAILABLE, "rulesets need GitHub Pro (or a public repo)")], None
    available = {name for text in workflows.values() if runs_on_every_pr(text, default_branch) for name in workflow_facts(text)[0]}
    findings, main = [], None
    for summary in summaries:
        if summary["name"] == std["ruleset"]["name"]:
            main = gh.api("GET", f"repos/{repo}/rulesets/{summary['id']}")
        elif summary["name"] in std["legacy"]["rulesets"]:
            findings.append(Finding(f"ruleset {summary['name']}", LEGACY, "legacy ruleset; --remove-legacy deletes it",
                                    (lambda sid=summary["id"]: gh.api("DELETE", f"repos/{repo}/rulesets/{sid}"))
                                    if remove_legacy else None))
        else:
            findings.append(Finding(f"ruleset {summary['name']}", INFO, "not managed; left as it is"))
    live_required = [check["context"] for rule in (main or {}).get("rules", [])
                     if rule["type"] == "required_status_checks"
                     for check in (rule.get("parameters") or {}).get("required_status_checks", [])]
    want, missing, kept = wanted_ruleset(std, available, live_required)
    if main is None:
        findings.insert(0, Finding("ruleset main-rules", DRIFT, "missing → created",
                                   lambda: gh.api("POST", f"repos/{repo}/rulesets", want)))
    else:
        diffs = ruleset_differences(main, want)
        if main.get("enforcement") != "active":
            diffs.insert(0, f"SUSPENDED (enforcement {main.get('enforcement')}); --fix restores it")
        if diffs:
            findings.insert(0, Finding("ruleset main-rules", DRIFT, "; ".join(diffs),
                                       lambda: gh.api("PUT", f"repos/{repo}/rulesets/{main['id']}", want)))
        else:
            findings.insert(0, Finding("ruleset main-rules", OK, "matches the standard"))
    if kept:
        findings.append(Finding("required checks", INFO,
                                "kept outside the standard while a workflow still reports them: " + ", ".join(kept)))
    if missing:
        findings.append(Finding("required checks", MANUAL,
                                "no workflow on the default branch reports " + ", ".join(missing)
                                + "; re-Apply the Template, then run --fix again to require them"))
    # Classic protection on the default branch: a leftover once main-rules is active.
    try:
        gh.api("GET", f"repos/{repo}/branches/{default_branch}/protection")
    except ApiError as error:
        if error.status not in (403, 404):
            raise
    else:
        active = main is not None and main.get("enforcement") == "active"
        fix = None
        if remove_legacy and active:
            fix = lambda: gh.api("DELETE", f"repos/{repo}/branches/{default_branch}/protection")
        detail = "classic protection alongside main-rules; --remove-legacy deletes it" if active else \
            "classic protection; --remove-legacy deletes it once main-rules is active (run --fix twice)"
        findings.append(Finding(f"branch protection on {default_branch}", LEGACY, detail, fix))
    return findings, main


def live_labels(gh, repo):
    return {label["name"]: label for label in gh.api("GET", f"repos/{repo}/labels?per_page=100")}


def check_retired_labels(gh, repo, std, live):
    """Squad is retired everywhere, so its labels go on every --fix, whatever the repo's scope."""
    return [Finding(f"label {name}", DRIFT, "retired label → deleted",
                    lambda name=name: gh.api("DELETE", f"repos/{repo}/labels/{_quote(name)}"))
            for name in sorted(live)
            if any(name.startswith(prefix) for prefix in std["settings"]["removed_label_prefixes"])]


def check_labels(gh, repo, std, live):
    findings = []
    for want in std["labels"]:
        current = live.get(want["name"])
        name = want["name"]
        if current is None:
            findings.append(Finding(f"label {name}", DRIFT, "missing → created",
                                    lambda want=want: gh.api("POST", f"repos/{repo}/labels", want)))
        elif current["color"].lower() != want["color"].lower() or (current.get("description") or "") != want["description"]:
            body = {"color": want["color"], "description": want["description"]}
            findings.append(Finding(f"label {name}", DRIFT, "color or description → the standard's",
                                    lambda name=name, body=body: gh.api(
                                        "PATCH", f"repos/{repo}/labels/{_quote(name)}", body)))
        else:
            findings.append(Finding(f"label {name}", OK, "present"))
    return findings


def _quote(name):
    return quote(name, safe="")


COPILOT_REVIEW_CAP = re.compile(r"const COPILOT_REVIEW_CAP = (\d+);")


def check_review_cap(std, workflows):
    """PR Auto-Merge waits for a review of the head for at most review_cap rounds (ADR 0002).

    Threads hold the merge past the cap too (#146). The ruleset leaves thread
    resolution to pr-automerge.yml, which enforces both. This checks the repo
    runs the Template's pr-automerge.yml with that cap.
    """
    want = std["settings"]["review_cap"]
    text = next((text for path, text in workflows.items() if Path(path).name == "pr-automerge.yml"), None)
    match = COPILOT_REVIEW_CAP.search(text or "")
    if match and int(match.group(1)) == want:
        return [Finding("review cap", OK, f"pr-automerge.yml stops waiting for a review of the head after {want} rounds")]
    found = f"cap {match.group(1)}" if match else "no review cap" if text else "no pr-automerge.yml"
    return [Finding("review cap", MANUAL, f"{found}; re-Apply the Template for the {want}-round cap")]


def check_secrets(gh, repo, std):
    names = {secret["name"] for secret in gh.api("GET", f"repos/{repo}/actions/secrets").get("secrets", [])}
    return [Finding(f"secret {name}", OK, "present") if name in names else
            Finding(f"secret {name}", MANUAL, "missing; add it in the repo's Actions secrets")
            for name in std["settings"]["required_secrets"]]


def read_repo_list():
    """{owner/repo: scope} from repos.txt; scope is "full" or "repo-settings-only"."""
    repos = {}
    for line in (HERE / "repos.txt").read_text().splitlines():
        words = line.split("#")[0].split()
        if words:
            repos[words[0]] = words[1] if len(words) > 1 else "full"
    return repos


def check(gh, repo, remove_legacy=False, scope="full"):
    """Every Finding for repo. A repo-settings-only repo gets just its merge settings."""
    std = load_standard(repo)
    info = gh.api("GET", f"repos/{repo}")
    findings = check_repo_flags(gh, repo, info, std)
    labels = live_labels(gh, repo)
    if scope == "repo-settings-only":
        return findings + check_retired_labels(gh, repo, std, labels) + [
            Finding("scope", INFO, "repo settings and retired labels only (repos.txt); the rest isn't managed here")]
    branch = info["default_branch"]
    workflows = read_workflows(gh, repo, branch)
    findings += check_security(gh, repo, info, std, workflows)
    findings += check_actions(gh, repo, std, workflows)
    ruleset_findings, _ = check_rulesets(gh, repo, std, workflows, branch, remove_legacy)
    findings += ruleset_findings
    findings += check_review_cap(std, workflows)
    findings += check_labels(gh, repo, std, labels)
    findings += check_retired_labels(gh, repo, std, labels)
    findings += check_secrets(gh, repo, std)
    return findings


def suspend(gh, repo):
    """Set main-rules to disabled, the emergency exit; --fix restores it.

    The update carries the whole ruleset as it is, changing only enforcement.
    """
    for summary in gh.api("GET", f"repos/{repo}/rulesets?includes_parents=false"):
        if summary["name"] == "main-rules":
            live = gh.api("GET", f"repos/{repo}/rulesets/{summary['id']}")
            body = {key: live[key] for key in ("name", "target", "conditions", "bypass_actors", "rules") if key in live}
            body["enforcement"] = "disabled"
            gh.api("PUT", f"repos/{repo}/rulesets/{summary['id']}", body)
            return True
    return False


# ── Output ───────────────────────────────────────────────────────────────────

def report(repo, findings, out):
    out.write(f"\n{repo}\n")
    for finding in findings:
        out.write(f"  {finding.status:<11} {finding.area}: {finding.detail}\n")


def failing(findings):
    return [finding for finding in findings if finding.status in FAILING]


def main(argv=None, gh=None, out=sys.stdout):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("repos", nargs="*", help="owner/repo")
    parser.add_argument("--all", action="store_true", help="every repo in github/repos.txt")
    parser.add_argument("--fix", action="store_true", help="apply the standard, then report again")
    parser.add_argument("--remove-legacy", action="store_true", help="with --fix, delete the legacy items listed")
    parser.add_argument("--suspend", action="store_true", help="disable main-rules (emergency); --fix restores it")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)
    gh = gh or Gh()

    listed = read_repo_list()
    repos = list(args.repos)
    if args.all:
        repos += [repo for repo in listed if repo not in repos]
    if not repos:
        parser.error("name a repo (owner/repo) or pass --all")
    if args.remove_legacy and not args.fix:
        parser.error("--remove-legacy only acts with --fix")

    if args.suspend:
        for repo in repos:
            done = suspend(gh, repo)
            out.write(f"{repo}: main-rules {'disabled; run --fix to restore it' if done else 'not found'}\n")
        return 0

    results, status = {}, 0
    for repo in repos:
        scope = listed.get(repo, "full")
        findings = check(gh, repo, remove_legacy=args.remove_legacy, scope=scope)
        if args.fix:
            fixes = [finding for finding in findings if finding.fix is not None and finding.status in (DRIFT, LEGACY)]
            if not args.json:
                report(repo, findings, out)
                out.write(f"  applying {len(fixes)} change(s)\n")
            for finding in fixes:
                finding.fix()
                if not args.json:
                    out.write(f"  applied     {finding.area}\n")
            findings = check(gh, repo, remove_legacy=False, scope=scope)
        results[repo] = findings
        if failing(findings):
            status = 1
        if not args.json:
            report(repo, findings, out)
    if args.json:
        json.dump({repo: [{"area": f.area, "status": f.status, "detail": f.detail} for f in findings]
                   for repo, findings in results.items()}, out, indent=2)
        out.write("\n")
    else:
        out.write("\n" + ("All repos match the standard.\n" if status == 0 else
                          "Not at the standard: see DRIFT, MANUAL and LEGACY above.\n"))
    return status


if __name__ == "__main__":
    sys.exit(main())

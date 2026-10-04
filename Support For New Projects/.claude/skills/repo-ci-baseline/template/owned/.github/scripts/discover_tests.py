#!/usr/bin/env python3
"""List the test projects under tests/ as the CI test matrix.

Called by the "Discover Test Projects" job in .github/workflows/ci.yml:

    python3 .github/scripts/discover_tests.py --output "$GITHUB_OUTPUT"

It appends the matrix ({"include": [...]}, one entry per test project) and
has_tests=true|false to the output file. scripts/gate.sh runs it with --list
instead, which prints each test project's path, so the pre-push gate tests the
same projects CI does.

A project is a test project when IsTestProject resolves to true, read the way
MSBuild imports it: the .csproj's own value wins, then the nearest
Directory.Build.props above it (atelier-store sets it once in
tests/Directory.Build.props). MSBuild imports only that nearest file, so a
parent one counts only when the nearest imports it (the usual
GetPathOfFileAbove('Directory.Build.props', ...) line). Helper libraries such
as IssueTracker's TestingSupport.Library set neither, so they're skipped.

A Condition on IsTestProject or its PropertyGroup is evaluated against the
project's name when it has one of the shapes the repos use, optionally negated
with !: $(MSBuildProjectName.Contains('x')), .StartsWith('x'), .EndsWith('x'),
or '$(MSBuildProjectName)' == 'x' (or !=). Blazor-Server sets it in its root
Directory.Build.props only where $(MSBuildProjectName.Contains('.Tests')), so
a helper library under tests/ stays out. Any other Condition is logged and
counts as holding.

A repo with no projects under tests/ gets has_tests=false, so the test matrix
is skipped while it's bootstrapped. Projects that are all skipped fail the
job instead: "Test Suite" passes a skipped matrix, so a discovery miss would
otherwise pass every PR with no tests run.

Standard library only.
"""

import argparse
import contextlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# An Import of the next Directory.Build.props up, such as
# $([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../')).
IMPORTS_PARENT_PROPS = re.compile(r"<Import\b[^>]*Directory\.Build\.props", re.IGNORECASE)
NAME_METHOD = re.compile(r"(!?)\$\(MSBuildProjectName\.(Contains|StartsWith|EndsWith)\('([^']*)'\)\)")
NAME_COMPARISON = re.compile(r"'\$\(MSBuildProjectName\)'\s*(==|!=)\s*'([^']*)'")


def condition_holds(condition, name):
    """Whether an MSBuild Condition holds for project name, or None for a shape this doesn't evaluate."""
    condition = condition.strip()
    if match := NAME_METHOD.fullmatch(condition):
        negate, method, text = match.groups()
        holds = {"Contains": text in name, "StartsWith": name.startswith(text), "EndsWith": name.endswith(text)}
        return holds[method] != bool(negate)
    if match := NAME_COMPARISON.fullmatch(condition):
        # MSBuild's == and != compare strings case-insensitively.
        operator, text = match.groups()
        return (name.lower() == text.lower()) == (operator == "==")
    return None


def local_name(element):
    """The element's tag without its namespace, lowercased: MSBuild property names ignore case."""
    return element.tag.rpartition("}")[2].lower()


def applies(element, name, path):
    """Whether element's Condition, if any, holds for project name; one this can't evaluate counts as holding."""
    condition = element.get("Condition")
    if condition is None:
        return True
    holds = condition_holds(condition, name)
    if holds is None:
        print(f"::notice::{name}: can't evaluate Condition \"{condition}\" on IsTestProject in {path}; counting it as holding")
        return True
    return holds


def declared_is_test_project(path, name):
    """The IsTestProject value a file sets for project name (its last one that applies), or None if it sets none."""
    project = ET.fromstring(path.read_text(encoding="utf-8-sig", errors="replace"))
    value = None
    for group in project:
        if local_name(group) != "propertygroup":
            continue
        for element in group:
            text = (element.text or "").strip().lower()
            if local_name(element) != "istestproject" or text not in ("true", "false"):
                continue
            if all(applies(owner, name, path) for owner in (group, element)):
                value = text == "true"
    return value


def nearest_props(folder, root):
    """The nearest Directory.Build.props in folder or above it, up to root, or None."""
    while True:
        props = folder / "Directory.Build.props"
        if props.is_file():
            return props
        if folder == root or folder.parent == folder:
            return None
        folder = folder.parent


def is_test_project(csproj, root):
    """Whether IsTestProject resolves to true for this project, as described above."""
    name = csproj.stem
    own = declared_is_test_project(csproj, name)
    if own is not None:
        return own
    props = nearest_props(csproj.parent, root)
    while props is not None:
        value = declared_is_test_project(props, name)
        if value is not None:
            return value
        text = props.read_text(encoding="utf-8", errors="replace")
        if props.parent == root or not IMPORTS_PARENT_PROPS.search(text):
            return False
        props = nearest_props(props.parent.parent, root)
    return False


def matrix_entry(csproj, root):
    """The matrix entry for one test project."""
    folder = csproj.parent.name
    lowered = folder.lower()
    is_e2e = "e2e" in lowered
    uses_playwright = "Microsoft.Playwright" in csproj.read_text(encoding="utf-8", errors="replace")
    # Playwright projects must be built before browsers can be installed.
    prebuild = is_e2e or uses_playwright
    return {
        "project_path": csproj.relative_to(root).as_posix(),
        "test_name": folder,
        "test_id": lowered.replace(".", "-").replace("_", "-"),
        "build_before_test": prebuild,
        "no_build": prebuild,
        "requires_playwright": uses_playwright,
        "verbosity": "normal" if is_e2e else "minimal",
    }


def discover(root):
    """(every .csproj under tests/, the matrix entries of the test projects among them)."""
    root = root.resolve()
    projects = sorted((root / "tests").glob("**/*.csproj"))
    return projects, [matrix_entry(csproj, root) for csproj in projects if is_test_project(csproj, root)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=".", help="the repo root")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", help="the file to append matrix and has_tests to")
    mode.add_argument("--list", action="store_true", help="print each test project's path, one per line")
    args = parser.parse_args(argv)

    if args.list:
        # Only the paths go to stdout, so the gate can read them; messages go to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            projects, entries = discover(Path(args.root))
            if projects and not entries:
                print(f"None of the {len(projects)} projects under tests/ resolves IsTestProject to true. "
                      "Set it in each test .csproj or in a Directory.Build.props above them.")
                return 1
        for entry in entries:
            print(entry["project_path"])
        return 0

    projects, entries = discover(Path(args.root))
    if projects and not entries:
        print(
            f"::error::None of the {len(projects)} projects under tests/ resolves IsTestProject to true. "
            "Set it in each test .csproj or in a Directory.Build.props above them."
        )
        return 1
    if entries:
        print(f"::notice::Discovered {len(entries)} test projects under tests/")
    else:
        # Expected while the repo is being bootstrapped.
        print("::warning::No test projects found under tests/ — skipping tests.")

    # json.dumps writes one line, so it can't end the heredoc early.
    with open(args.output, "a", encoding="utf-8") as output:
        output.write(f"matrix<<EOF\n{json.dumps({'include': entries})}\nEOF\n")
        output.write(f"has_tests={'true' if entries else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

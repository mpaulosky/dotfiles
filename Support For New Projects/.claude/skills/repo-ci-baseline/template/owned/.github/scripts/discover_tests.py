#!/usr/bin/env python3
"""List the test projects under tests/ as the CI test matrix.

Called by the "Discover Test Projects" job in .github/workflows/ci.yml:

    python3 .github/scripts/discover_tests.py --output "$GITHUB_OUTPUT"

It appends the matrix ({"include": [...]}, one entry per test project) and
has_tests=true|false to the output file.

A project is a test project when IsTestProject resolves to true: its .csproj's
own value wins, then the nearest Directory.Build.props between its folder and
the repo root that sets one (atelier-store and Blazor-Server set it once in
tests/Directory.Build.props). Helper libraries such as IssueTracker's
TestingSupport.Library set neither, so they're skipped.

A repo with no projects under tests/ gets has_tests=false, so the test matrix
is skipped while it's bootstrapped. Projects that are all skipped fail the
job instead: "Test Suite" passes a skipped matrix, so a discovery miss would
otherwise pass every PR with no tests run.

Standard library only.
"""

import argparse
import json
import re
import sys
from pathlib import Path

IS_TEST_PROJECT = re.compile(r"<IsTestProject>\s*(true|false)\s*</IsTestProject>", re.IGNORECASE)


def declared_is_test_project(path):
    """The IsTestProject value a file sets (its last one), or None if it sets none."""
    values = IS_TEST_PROJECT.findall(path.read_text(encoding="utf-8", errors="replace"))
    return values[-1].lower() == "true" if values else None


def is_test_project(csproj, root):
    """Whether IsTestProject resolves to true for this project, as described above."""
    own = declared_is_test_project(csproj)
    if own is not None:
        return own
    folder = csproj.parent
    while True:
        props = folder / "Directory.Build.props"
        if props.is_file():
            value = declared_is_test_project(props)
            if value is not None:
                return value
        if folder == root or folder.parent == folder:
            return False
        folder = folder.parent


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
    parser.add_argument("--output", required=True, help="the file to append matrix and has_tests to")
    args = parser.parse_args(argv)

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

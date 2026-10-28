"""Tests for check_gh_repo.py (mpaulosky/dotfiles#267, #321): every gh command in the
Template's Owned scripts, and in every repo's own scripts and skills, is told its repository, so a re-Apply can't fail a
Baseline repo's gate check for gh commands that reach gh's default repository
(a fork, in a fork's clone). No GitHub.
"""

import ast
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
TEMPLATE_OWNED = HERE.parents[1] / "template" / "owned"
sys.path.insert(0, str(TEMPLATE_OWNED / ".github" / "scripts"))
import check_gh_repo  # noqa: E402

OWNED_SCRIPTS = TEMPLATE_OWNED / "scripts"


def lines_of(found):
    """The line numbers of found, whose entries are path:line: text."""
    return [int(re.match(r".*?:([0-9]+): ", entry).group(1)) for entry in found]


def assert_refused_at(found, text, line):
    """found is exactly one refusal, of the given line of text, with that line's text as its message."""
    assert lines_of(found) == [line]
    assert found[0].split(f":{line}: ", 1)[1] == text.split("\n")[line - 1]


def untold(tmp_path, text, name="script.sh"):
    path = tmp_path / name
    path.write_text(text)
    return check_gh_repo.untold(path)


@pytest.mark.parametrize("text, line", [
    ("#!/usr/bin/env bash\ngh pr view 1\n", 2),
    ("gh issue list\n", 1),
    ("gh api repos/{owner}/{repo}/pulls\n", 1),
    ("echo \"$(gh pr view --json number)\"\n", 1),
    ("gh pr view 1 --repo o/r\n", 1),
    ("gh pr view 1\nexport GH_REPO=o/r\n", 1),
    ("export GH_REPO=\nexport GH_REPO=''\ngh pr view 1\n", 3),
    ("GH_REPO= gh pr view 1\n", 1),
    ("GH_REPO=o/r echo; gh pr view 1\n", 1),
    ("export GH_REPO=o/r && gh pr view 1\n", 1),
    ("gh \\\n  pr view 1\n", 1),
    ("if command -v gh\n", 1),
    # The subcommand arrives through a variable or a wrapper.
    ("gh \"$@\"\n", 1),
    ("gh $sub view 1\n", 1),
    ("gh \"${args[@]}\"\n", 1),
    ("gh_() { (cd \"$primary\" && gh \"$@\"); }\ngh_ pr view 1\n", 1),
    # A variable that's empty where the script runs leaves gh its default.
    ("export GH_REPO=\"$GITHUB_REPOSITORY\"\ngh pr view 1\n", 2),
    ("export GH_REPO=$repo\ngh pr view 1\n", 2),
    ("GH_REPO=\"$repo\" gh api repos/{owner}/{repo}/pulls\n", 1),
    # The hidden subcommand can be gh repo view, which ignores GH_REPO.
    ("export GH_REPO=o/r\ngh_() { gh \"$@\"; }\ngh_ repo view --json name\n", 2),
    ("export GH_REPO=o/r\ngh $sub view\n", 2),
    # A character bash doesn't end a line on hides no export behind it.
    ("echo x\u2028export GH_REPO=o/r\ngh pr view 1\n", 2),
    ("echo x\x0cexport GH_REPO=o/r\ngh pr view 1\n", 2),
    # A redirection or a brace expansion before the subcommand hides it.
    ("export GH_REPO=o/r\ngh 2>/dev/null repo view --json name\n", 2),
    ("export GH_REPO=o/r\ngh >\"$log\" repo edit o\n", 2),
    ("export GH_REPO=o/r\ngh {repo,} view\n", 2),
    # Emptied or removed after the export.
    ("export GH_REPO=o/r\nGH_REPO= gh pr view 1\n", 2),
    ("export GH_REPO=o/r\nunset GH_REPO\ngh pr view 1\n", 3),
    ("export GH_REPO=o/r\nGH_REPO=\"$repo\"\ngh pr view 1\n", 3),
    # A list of gh's words, where no export reaches it.
    ("export GH_REPO=o/r\nsubprocess.run([\"gh\", \"pr\", \"view\"])\n", 2),
    # An export that runs only sometimes.
    ("if [[ -n \"${CI:-}\" ]]; then\n  export GH_REPO=o/r\nfi\ngh pr view 1\n", 4),
])
def test_untold_refuses_a_gh_command_not_told_its_repository(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


@pytest.mark.parametrize("text", [
    "export GH_REPO=\"${GITHUB_REPOSITORY:?}\"\ngh pr view 1\n",
    "export GH_REPO=${GITHUB_REPOSITORY:?set it}\ngh pr view 1\n",
    "export GH_REPO=o/r  # the repository\ngh issue list\n",
    "GH_REPO=o/r gh pr view 1\n",
    "GH_REPO=\"${repo:?}\" gh api repos/{owner}/{repo}/pulls\n",
    "export GH_REPO=o/r\nif command -v gh\n",
    "echo \"needs gh.\"\n",
    # gh ending a quoted word, as a test's stub does.
    "export GH_REPO=o/r\ncat > \"$work/bin/gh\" <<EOF\n",
    "export GH_REPO=o/r\nchmod +x \"$work/bin/gh\"\n",
    "export GH_REPO=o/r\necho \"gate.sh: needs gh\"\n",
    "export GH_REPO=o/r\nfor t in \"gh\" jq; do\n",
    "export GH_REPO=o/r\ncommand -v gh >/dev/null || exit 1\n",
    "export GH_REPO=o/r\ncommand -v gh &>/dev/null\n",
    # A prefix that names a repository leaves the export standing.
    "export GH_REPO=o/r\nGH_REPO=o/s gh pr view 1\ngh pr view 2\n",
    "# gh pr view 1 is how you'd look\n",
    "echo hi\n",
    "neigh pr\nhigh api\n",
])
def test_untold_accepts_a_gh_command_told_its_repository(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text", [
    "gh repo view o/r\n",
    "gh repo view \"${repo:?}\"\n",
    "gh repo edit o/r --enable-auto-merge\n",
    "gh repo list mpaulosky\n",
    "gh repo gitignore list\n",
    "gh repo license view mit\n",
    # rename, deploy-key and autolink read GH_REPO, like gh pr.
    "export GH_REPO=o/r\ngh repo rename new-name\n",
    "GH_REPO=o/r gh repo deploy-key list\n",
    "gh repo create o/r --private\n",
    "gh repo clone o/r\n",
])
def test_untold_accepts_gh_repo_naming_its_repository(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text, line", [
    ("gh repo view\n", 1),
    ("gh repo view --json name\n", 1),
    ("gh repo\n", 1),
    # GH_REPO doesn't reach view, edit and most of gh repo's subcommands.
    ("export GH_REPO=o/r\ngh repo view\n", 2),
    ("GH_REPO=o/r gh repo view --json name\n", 1),
    # view and edit have no -R or --repo; gh refuses them as unknown flags.
    ("gh repo edit -R o/r --enable-auto-merge\n", 1),
    ("gh repo view --repo=o/r\n", 1),
    ("gh repo view \"$repo\"\n", 1),
    ("gh repo rename new-name\n", 1),
])
def test_untold_refuses_gh_repo_without_its_repository(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


def test_untold_names_the_file_and_line(tmp_path):
    # Arrange, Act
    found = untold(tmp_path, "echo\ngh pr view 1\n", name="gate.sh")

    # Assert
    assert found == [f"{tmp_path / 'gate.sh'}:2: gh pr view 1"]


@pytest.mark.parametrize("separator", ["\x0c", "\x0b", "\x1c", "\x85", "\u2028"])
def test_untold_counts_lines_as_bash_does(tmp_path, separator):
    # Arrange, Act
    found = untold(tmp_path, f"echo a{separator}b\ngh pr view 1\n", name="gate.sh")

    # Assert
    assert found == [f"{tmp_path / 'gate.sh'}:2: gh pr view 1"]


def test_untold_reads_crlf_line_endings(tmp_path):
    # Arrange, Act
    found = untold(tmp_path, "export GH_REPO=o/r\r\ngh pr view 1\r\ngh repo view\r\n", name="gate.sh")

    # Assert
    assert found == [f"{tmp_path / 'gate.sh'}:3: gh repo view"]


def test_untold_reads_a_script_that_isnt_utf8(tmp_path):
    # Arrange: a comment saved as cp1252.
    path = tmp_path / "gate.sh"
    path.write_bytes(b"# caf\xe9\ngh pr view 1\n")

    # Act
    found = check_gh_repo.untold(path)

    # Assert
    assert found == [f"{path}:2: gh pr view 1"]


def test_untold_skips_a_binary_file(tmp_path):
    # Arrange
    path = tmp_path / "blob"
    path.write_bytes(b"\x00\x01gh pr view\n")

    # Act
    found = check_gh_repo.untold(path)

    # Assert
    assert found == []


def test_main_fails_when_a_script_under_the_root_isnt_told(tmp_path, capsys):
    # Arrange
    (tmp_path / "tests").mkdir()
    (tmp_path / "ok.sh").write_text("export GH_REPO=o/r\ngh pr view 1\n")
    (tmp_path / "tests" / "bad.test.sh").write_text("gh pr view 1\n")

    # Act
    code = check_gh_repo.main([str(tmp_path)])

    # Assert
    assert code == 1
    assert "bad.test.sh:1: gh pr view 1" in capsys.readouterr().out


def test_main_fails_when_a_root_isnt_a_directory(tmp_path, capsys):
    # Arrange, Act
    code = check_gh_repo.main([str(tmp_path / "missing")])

    # Assert
    assert code == 2
    assert "missing" in capsys.readouterr().err


def test_main_passes_the_templates_owned_scripts():
    # Arrange
    assert any(path.is_file() for path in OWNED_SCRIPTS.rglob("*"))

    # Act
    code = check_gh_repo.main([str(OWNED_SCRIPTS)])

    # Assert
    assert code == 0


# --- mpaulosky/dotfiles#321: the gate checks a repo's own scripts and skills ---

DOTFILES_ROOT = HERE.parents[5]
CHECKER = TEMPLATE_OWNED / ".github" / "scripts" / "check_gh_repo.py"


def make_repo(root, files):
    """Writes files (repo-relative path -> text or bytes) under root."""
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)
    return root


def repo_check(tmp_path, files):
    return check_gh_repo.check_repo(make_repo(tmp_path, files))


def untold_md(tmp_path, text, name="SKILL.md"):
    path = tmp_path / name
    path.write_text(text)
    return check_gh_repo.untold_markdown(path)


UNTOLD = "gh pr view 1\n"
TOLD = "export GH_REPO=o/r\ngh pr view 1\n"


def covered(relative):
    """Whether OWNED lists the repo-relative path, as itself or under a folder entry."""
    return any(relative == entry or (entry.endswith("/") and relative.startswith(entry))
               for entry in check_gh_repo.OWNED)


# Shell files, checked in --repo mode.

def test_check_repo_reports_an_untold_gh_command_in_a_script_by_its_relative_path(tmp_path):
    # Arrange, Act
    found = repo_check(tmp_path, {"scripts/x.sh": "echo\n" + UNTOLD})

    # Assert
    assert found == ["scripts/x.sh:2: gh pr view 1"]


def test_check_repo_passes_a_script_that_exports_gh_repo(tmp_path):
    # Arrange, Act
    found = repo_check(tmp_path, {"scripts/x.sh": TOLD})

    # Assert
    assert found == []


@pytest.mark.parametrize("name", ["scripts/x.sh", "scripts/x.bash", ".github/ci/gate-checks.sh",
                                  "scripts/tests/y.test.sh", ".claude/skills/mine/run.sh"])
def test_check_repo_checks_shell_files_in_scope(tmp_path, name):
    # Arrange, Act
    found = repo_check(tmp_path, {name: UNTOLD})

    # Assert
    assert found == [f"{name}:1: gh pr view 1"]


@pytest.mark.parametrize("shebang", ["#!/usr/bin/env bash", "#!/bin/bash", "#!/bin/sh", "#!/usr/bin/env sh"])
def test_check_repo_checks_an_extensionless_script_with_a_shell_shebang(tmp_path, shebang):
    # Arrange, Act
    found = repo_check(tmp_path, {"scripts/tool": f"{shebang}\n{UNTOLD}"})

    # Assert
    assert found == ["scripts/tool:2: gh pr view 1"]


@pytest.mark.parametrize("content", [
    "#!/usr/bin/env python3\n" + UNTOLD,
    "#!/usr/bin/env node\n" + UNTOLD,
    UNTOLD,
])
def test_check_repo_skips_an_extensionless_file_that_isnt_a_shell_script(tmp_path, content):
    # Arrange, Act
    found = repo_check(tmp_path, {"scripts/tool": content})

    # Assert
    assert found == []


@pytest.mark.parametrize("name", ["scripts/x.py", "scripts/x.mts", ".github/ci/list.txt", "scripts/x.json"])
def test_check_repo_skips_files_that_arent_shell_or_markdown(tmp_path, name):
    # Arrange, Act
    found = repo_check(tmp_path, {name: UNTOLD})

    # Assert
    assert found == []


def test_check_repo_skips_a_binary_file(tmp_path):
    # Arrange, Act
    found = repo_check(tmp_path, {"scripts/blob.sh": b"\x00\x01gh pr view\n"})

    # Assert
    assert found == []


@pytest.mark.parametrize("name", ["src/x.sh", "docs/x.md", ".github/other/x.sh", ".github/workflows/x.sh", "x.sh",
                                  ".sandcastle/x.sh"])
def test_check_repo_only_walks_scripts_github_ci_and_skills(tmp_path, name):
    # Arrange, Act
    found = repo_check(tmp_path, {name: UNTOLD})

    # Assert
    assert found == []


@pytest.mark.parametrize("name", ["scripts/node_modules/p/x.sh", ".claude/skills/node_modules/p/SKILL.md",
                                  ".github/ci/node_modules/x.sh", "scripts/.git/x.sh"])
def test_check_repo_doesnt_walk_node_modules_or_git(tmp_path, name):
    # Arrange, Act
    found = repo_check(tmp_path, {name: "gh pr view 1\n"})

    # Assert
    assert found == []


def test_check_repo_doesnt_follow_a_symlink_out_of_the_repo(tmp_path):
    # Arrange
    outside = make_repo(tmp_path / "outside", {"x.sh": UNTOLD, "dir/y.sh": UNTOLD})
    repo = make_repo(tmp_path / "repo", {"scripts/ok.sh": TOLD})
    (repo / "scripts" / "link.sh").symlink_to(outside / "x.sh")
    (repo / "scripts" / "linked").symlink_to(outside / "dir", target_is_directory=True)

    # Act
    found = check_gh_repo.check_repo(repo)

    # Assert
    assert found == []


def test_check_repo_passes_a_repo_without_any_folder_in_scope(tmp_path):
    # Arrange, Act
    found = repo_check(tmp_path, {"README.md": "gh pr view 1\n"})

    # Assert
    assert found == []


def test_check_repo_reports_each_file_with_its_own_path(tmp_path):
    # Arrange, Act
    found = repo_check(tmp_path, {
        "scripts/a.sh": UNTOLD,
        "scripts/b.sh": TOLD,
        ".github/ci/gate-checks.sh": "echo\ngh issue list\n",
        ".claude/skills/mine/SKILL.md": "Run `gh pr list`.\n",
    })

    # Assert
    assert sorted(found) == [
        ".claude/skills/mine/SKILL.md:1: Run `gh pr list`.",
        ".github/ci/gate-checks.sh:2: gh issue list",
        "scripts/a.sh:1: gh pr view 1",
    ]


# The Owned Baseline files are skipped.

@pytest.mark.parametrize("name", [
    "scripts/gate.sh",
    "scripts/check-branch-name.sh",
    "scripts/check-pr-title.sh",
    "scripts/check-git-hooks.sh",
    "scripts/review.sh",
    "scripts/sync-copilot-review.sh",
    "scripts/tests/check-branch-name.test.sh",
    "scripts/tests/check-pr-title.test.sh",
    "scripts/tests/check-git-hooks.test.sh",
    "scripts/tests/sync-copilot-review.test.sh",
    ".claude/skills/pre-push-review/SKILL.md",
    ".claude/skills/pre-push-review/references/more.md",
    ".claude/skills/hardening-review/SKILL.md",
    ".claude/skills/hardening-review/scripts/mutate.py",
])
def test_check_repo_skips_the_owned_baseline_files(tmp_path, name):
    # Arrange, Act
    found = repo_check(tmp_path, {name: "gh pr view 1\n`gh pr list`\n"})

    # Assert
    assert found == []


@pytest.mark.parametrize("name", [
    "scripts/other.sh",
    "scripts/tests/other.test.sh",
    ".claude/skills/mine/SKILL.md",
    ".claude/skills/pre-push-review-2/SKILL.md",
    "scripts/gate.sh.bak.sh",
])
def test_check_repo_checks_what_isnt_an_owned_baseline_file(tmp_path, name):
    # Arrange, Act
    found = repo_check(tmp_path, {name: "`gh pr view 1`\n" if name.endswith(".md") else "gh pr view 1\n"})

    # Assert
    assert [line.split(":")[0] for line in found] == [name]


def test_owned_covers_every_owned_script_and_skill_file_of_the_template():
    # Arrange
    owned_files = [path.relative_to(TEMPLATE_OWNED).as_posix()
                   for folder in ("scripts", ".claude/skills")
                   for path in (TEMPLATE_OWNED / folder).rglob("*") if path.is_file()]
    assert owned_files

    # Act, Assert
    assert [name for name in owned_files if not covered(name)] == []


def test_every_owned_entry_exists_in_the_template():
    # Arrange
    assert check_gh_repo.OWNED

    # Act
    missing = [entry for entry in check_gh_repo.OWNED if not (TEMPLATE_OWNED / entry).exists()]

    # Assert
    assert missing == []


def test_owned_names_files_and_folders_under_scripts_and_the_review_skills_only():
    # Arrange, Act, Assert
    assert check_gh_repo.OWNED
    assert all(entry.startswith(("scripts/", ".claude/skills/pre-push-review/", ".claude/skills/hardening-review/")) for entry in check_gh_repo.OWNED)


def test_scope_is_scripts_github_ci_and_skills():
    # Arrange, Act, Assert
    assert sorted(check_gh_repo.SCOPE) == [".claude/skills", ".github/ci", "scripts"]


@pytest.mark.parametrize("name, expected", [
    ("a.md", "markdown"), ("a.sh", "shell"), ("a.bash", "shell"), ("a.py", None), ("a.txt", None), ("a.mts", None),
])
def test_kind_tells_markdown_from_shell_by_extension(tmp_path, name, expected):
    # Arrange
    path = tmp_path / name
    path.write_text("x\n")

    # Act, Assert
    assert check_gh_repo.kind(path) == expected


def test_kind_reads_the_shebang_of_an_extensionless_file(tmp_path):
    # Arrange
    shell, python, plain = tmp_path / "shell", tmp_path / "python", tmp_path / "plain"
    shell.write_text("#!/usr/bin/env bash\n")
    python.write_text("#!/usr/bin/env python3\n")
    plain.write_text("echo\n")

    # Act, Assert
    assert [check_gh_repo.kind(path) for path in (shell, python, plain)] == ["shell", None, None]


# Skills (Markdown): only gh in code counts.

@pytest.mark.parametrize("text, line", [
    ("```bash\ngh pr view 1\n```\n", 2),
    ("```\ngh pr view 1\n```\n", 2),
    ("~~~\ngh pr view 1\n~~~\n", 2),
    ("   ```bash\ngh pr view 1\n   ```\n", 2),
    ("Run `gh pr view 1` to see it.\n", 1),
    ("- Run `gh pr list`\n", 1),
    ("1. Then ``gh pr list`` shows them.\n", 1),
    ("Use `gh pr view 1` or `gh pr view 2 --repo o/r`.\n", 1),
    # The repository comes from a variable gh would find empty, or from another command.
    ("```bash\nGH_REPO=\"$repo\" gh pr view 1\n```\n", 2),
    ("```bash\ngh pr view 1 --repo \"$repo\"\n```\n", 2),
    ("```bash\nexport GH_REPO=o/r\ngh pr view 1\n```\n", 3),
    ("```bash\nGH_REPO=o/r echo; gh pr view 1\n```\n", 2),
    ("```bash\nGH_REPO= gh pr view 1\n```\n", 2),
    # gh api has no --repo flag.
    ("```bash\ngh api repos/o/r/pulls --repo o/r\n```\n", 2),
    ("```bash\ngh api repos/{owner}/{repo}/pulls\n```\n", 2),
    # gh repo's subcommands take the repository first.
    ("```bash\ngh repo view\n```\n", 2),
    ("```bash\ngh repo view --json name\n```\n", 2),
    ("```bash\ngh repo view --repo o/r\n```\n", 2),
    ("```bash\nGH_REPO=o/r gh repo view\n```\n", 2),
    ("Run `gh repo edit --enable-auto-merge`.\n", 1),
    # A command split across lines, or with its subcommand hidden.
    ("```bash\ngh \\\n  pr view 1 --repo o/r\n```\n", 2),
    ("```bash\ngh pr view 1 \\\n  --repo o/r\n```\n", 2),
    ("```bash\ngh \"$@\"\n```\n", 2),
    ("```bash\ngh $sub view 1\n```\n", 2),
    ("```bash\ngh\n```\n", 2),
    # An unclosed fence is code to the end of the file; a longer fence isn't closed by a shorter one.
    ("```bash\necho\ngh pr view 1\n", 3),
    ("````\n```\ngh pr view 1\n```\n````\n", 3),
    ("~~~\n```\ngh pr view 1\n```\n~~~\n", 3),
    ("```bash\necho\n```\n```bash\ngh pr view 1\n```\n", 5),
    ("Text\n\n```bash\necho\n```\n\nMore `gh issue list`\n", 7),
    # A fence in a blockquote or a list item is still a fence.
    ("> ```bash\n> gh pr view 1\n> ```\n", 2),
    ("> [!NOTE]\n> ```bash\n> gh pr view 1\n> ```\n", 3),
    (">> ```bash\n>> gh pr view 1\n>> ```\n", 2),
    ("- ```bash\n  gh pr view 1\n  ```\n", 2),
    ("1. ```bash\n   gh pr view 1\n   ```\n", 2),
    ("* Step:\n  > ```bash\n  > gh pr view 1\n  > ```\n", 3),
    ("> ~~~\n> gh pr view 1\n> ~~~\n", 2),
    ("- ```bash\n  gh pr view 1\n", 2),
])
def test_untold_markdown_refuses_a_gh_command_in_code_not_told_its_repository(tmp_path, text, line):
    # Arrange, Act
    found = untold_md(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


@pytest.mark.parametrize("text", [
    "```bash\nGH_REPO=o/r gh pr view 1\n```\n",
    "```bash\nGH_REPO=\"${repo:?}\" gh pr view 1\n```\n",
    "```bash\nGH_REPO=\"${GITHUB_REPOSITORY:?}\" gh issue list\n```\n",
    "```bash\nGH_REPO=o/r gh api repos/{owner}/{repo}/pulls\n```\n",
    "```bash\ngh pr view 1 --repo o/r\n```\n",
    "```bash\ngh pr view 1 --repo=o/r\n```\n",
    "```bash\ngh pr view 1 -R o/r\n```\n",
    "```bash\ngh pr list --state open --repo \"${repo:?}\"\n```\n",
    "```bash\ngh pr list --json number -R o/r --limit 5\n```\n",
    "```bash\ngh repo view o/r\n```\n",
    "```bash\ngh repo view \"${repo:?}\" --json name\n```\n",
    "```bash\ngh repo edit o/r --enable-auto-merge\n```\n",
    "```bash\ngh repo list mpaulosky\n```\n",
    "```bash\ngh repo list\n```\n",
    "```bash\nGH_REPO=o/r gh repo rename new-name\n```\n",
    "Run `GH_REPO=o/r gh pr view 1`.\n",
    "Run `gh pr view 1 --repo o/r`.\n",
    "Run `gh pr view 1 -R o/r` or `GH_REPO=o/r gh pr list`.\n",
    "~~~\nGH_REPO=o/r gh pr view 1\n~~~\n",
    "> ```bash\n> gh pr view 1 --repo o/r\n> ```\n",
    "- ```bash\n  GH_REPO=o/r gh pr view 1\n  ```\n",
    # A quoted fence that closed: what follows is prose again.
    "> ```bash\n> echo hi\n> ```\n> gh pr view 1\n",
    "- ```bash\n  echo hi\n  ```\n  gh pr view 1\n",
    "- Run `gh repo view o/r`\n",
    # gh named in prose, not run.
    "Needs the gh CLI.\n",
    "The gh command reaches the default repository.\n",
    "Install gh first; `gh` is a program.\n",
    "Call `gh` to talk to GitHub.\n",
    "```bash\nneigh pr view 1\ngh_ pr view 1\n```\n",
    "Plain gh pr view 1 outside code.\n",
    "# gh pr view 1\n\n- gh issue list\n",
    # Code that closed: what follows is prose again.
    "```bash\necho hi\n```\ngh pr view 1\n",
    "```bash\necho hi\n```\n\nRun gh pr view 1 yourself.\n",
    "~~~\necho hi\n~~~\ngh pr list\n",
    "````\n```\necho\n```\n````\ngh pr list\n",
    # An unclosed backtick opens no span.
    "Use `gh pr view 1 for it.\n",
    "```bash\necho hi\n```\n",
    "",
])
def test_untold_markdown_accepts_what_is_told_or_not_a_command(tmp_path, text):
    # Arrange, Act
    found = untold_md(tmp_path, text)

    # Assert
    assert found == []


def test_untold_markdown_names_the_file_and_line_of_the_whole_line(tmp_path):
    # Arrange
    text = "# Title\n\n```bash\ngh repo view o/r\ngh pr view 1\n```\n\nTry `gh pr list` now.\n"

    # Act
    found = untold_md(tmp_path, text, name="SKILL.md")

    # Assert
    assert found == [f"{tmp_path / 'SKILL.md'}:5: gh pr view 1", f"{tmp_path / 'SKILL.md'}:8: Try `gh pr list` now."]


def test_untold_markdown_judges_each_command_on_its_own(tmp_path):
    # Arrange: the first command is told, the second is not; there is no export state in a skill.
    text = "```bash\nexport GH_REPO=o/r\nGH_REPO=o/r gh pr view 1\ngh pr list\n```\n"

    # Act
    found = untold_md(tmp_path, text)

    # Assert
    assert found == [f"{tmp_path / 'SKILL.md'}:4: gh pr list"]


def test_untold_markdown_reads_crlf_line_endings(tmp_path):
    # Arrange, Act
    found = untold_md(tmp_path, "```bash\r\ngh pr view 1 --repo o/r\r\ngh pr list\r\n```\r\n")

    # Assert
    assert found == [f"{tmp_path / 'SKILL.md'}:3: gh pr list"]


def test_untold_markdown_reads_a_file_that_isnt_utf8(tmp_path):
    # Arrange
    path = tmp_path / "SKILL.md"
    path.write_bytes(b"caf\xe9\n```bash\ngh pr view 1\n```\n")

    # Act
    found = check_gh_repo.untold_markdown(path)

    # Assert
    assert found == [f"{path}:3: gh pr view 1"]


def test_untold_markdown_skips_a_binary_file(tmp_path):
    # Arrange
    path = tmp_path / "SKILL.md"
    path.write_bytes(b"\x00```\ngh pr view 1\n```\n")

    # Act
    found = check_gh_repo.untold_markdown(path)

    # Assert
    assert found == []


def test_check_repo_checks_skills_line_by_line_but_scripts_with_their_export(tmp_path):
    # Arrange: the same text is told as a script and untold as a skill.
    text = "export GH_REPO=o/r\ngh pr view 1\n"

    # Act
    found = repo_check(tmp_path, {"scripts/x.sh": text, "scripts/x.md": f"```bash\n{text}```\n"})

    # Assert
    assert found == ["scripts/x.md:3: gh pr view 1"]


# The command line.

def test_main_repo_mode_prints_the_untold_commands_and_a_hint_and_fails(tmp_path, capsys):
    # Arrange
    make_repo(tmp_path, {"scripts/x.sh": UNTOLD})

    # Act
    code = check_gh_repo.main(["--repo", str(tmp_path)])

    # Assert
    captured = capsys.readouterr()
    assert code == 1
    assert captured.out.splitlines() == ["scripts/x.sh:1: gh pr view 1"]
    assert captured.err.startswith("check_gh_repo.py: export GH_REPO")
    assert "--repo" in captured.err
    assert "gh repo" in captured.err


def test_main_repo_mode_prints_nothing_when_every_command_is_told(tmp_path, capsys):
    # Arrange
    make_repo(tmp_path, {"scripts/x.sh": TOLD, ".claude/skills/mine/SKILL.md": "`gh pr list -R o/r`\n"})

    # Act
    code = check_gh_repo.main(["--repo", str(tmp_path)])

    # Assert
    captured = capsys.readouterr()
    assert code == 0
    assert captured.out == ""
    assert captured.err == ""


def test_main_repo_mode_passes_a_repo_without_any_folder_in_scope(tmp_path):
    # Arrange, Act
    code = check_gh_repo.main(["--repo", str(tmp_path)])

    # Assert
    assert code == 0


def test_main_repo_mode_fails_when_the_root_isnt_a_directory(tmp_path, capsys):
    # Arrange
    (tmp_path / "file").write_text("x\n")

    # Act
    codes = [check_gh_repo.main(["--repo", str(tmp_path / "missing")]), check_gh_repo.main(["--repo", str(tmp_path / "file")])]

    # Assert
    assert codes == [2, 2]
    assert capsys.readouterr().err.count("isn't a directory") == 2


@pytest.mark.parametrize("argv", [["--repo"], ["--repo", "a", "b"], ["--repo", "a", "--repo", "b"]])
def test_main_repo_mode_is_a_usage_error_without_exactly_one_root(tmp_path, capsys, argv):
    # Arrange
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    argv = [str(tmp_path / arg) if arg in ("a", "b") else arg for arg in argv]

    # Act
    code = check_gh_repo.main(argv)

    # Assert
    assert code == 2
    assert "usage: check_gh_repo.py --repo <root> | <dir>..." in capsys.readouterr().err


def test_main_repo_mode_runs_as_a_script(tmp_path):
    # Arrange
    make_repo(tmp_path, {"scripts/x.sh": UNTOLD})

    # Act
    result = subprocess.run([sys.executable, "-I", str(CHECKER), "--repo", str(tmp_path)],
                            capture_output=True, text=True, check=False)

    # Assert
    assert result.returncode == 1
    assert result.stdout.splitlines() == ["scripts/x.sh:1: gh pr view 1"]
    assert "GH_REPO" in result.stderr


def test_main_directory_mode_still_checks_every_file_and_skips_nothing(tmp_path, capsys):
    # Arrange: the Owned names, a Markdown file and a .py file are all read as shell in this mode.
    make_repo(tmp_path, {"gate.sh": UNTOLD, "a.md": UNTOLD, "b.py": UNTOLD, "ok.sh": TOLD})

    # Act
    code = check_gh_repo.main([str(tmp_path)])

    # Assert
    assert code == 1
    assert sorted(line.split(":")[0].rsplit("/", 1)[1] for line in capsys.readouterr().out.splitlines()) == [
        "a.md", "b.py", "gate.sh"]


def test_main_directory_mode_prints_no_hint(tmp_path, capsys):
    # Arrange
    make_repo(tmp_path, {"x.sh": UNTOLD})

    # Act
    check_gh_repo.main([str(tmp_path)])

    # Assert
    assert capsys.readouterr().err == ""


def test_main_repo_mode_passes_dotfiles_own_scripts_and_skills():
    # Arrange: test.sh runs this on dotfiles' root, since its gate calls test.sh.
    assert (DOTFILES_ROOT / "scripts").is_dir()

    # Act
    found = check_gh_repo.check_repo(DOTFILES_ROOT)

    # Assert
    assert found == []


# Cheap: it runs on every gate.

def test_the_check_imports_nothing_that_starts_a_process_or_reaches_the_network():
    # Arrange
    tree = ast.parse(CHECKER.read_text())
    imported = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    imported |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}

    # Act, Assert
    assert imported
    assert imported.isdisjoint({"subprocess", "socket", "urllib", "http", "requests", "shutil", "asyncio"})


def test_check_repo_starts_no_process(tmp_path, monkeypatch):
    # Arrange
    make_repo(tmp_path, {"scripts/x.sh": UNTOLD, ".claude/skills/mine/SKILL.md": "`gh pr list`\n"})

    def refuse(*args, **kwargs):
        raise AssertionError("check_repo started a process")

    for name in ("run", "Popen", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, refuse)
    monkeypatch.setattr(os, "system", refuse)

    # Act
    found = check_gh_repo.check_repo(tmp_path)

    # Assert
    assert len(found) == 2


def test_check_repo_passes_a_repo_of_200_small_files(tmp_path):
    # Arrange
    make_repo(tmp_path, {f"scripts/s{i}.sh": TOLD for i in range(100)}
              | {f".claude/skills/s{i}/SKILL.md": f"# Skill {i}\n\nUse the gh CLI.\n" for i in range(100)})

    # Act
    found = check_gh_repo.check_repo(tmp_path)

    # Assert
    assert found == []


@pytest.mark.parametrize("text", [
    "command -v gh >/dev/null || exit 1 # gh-repo: ok\n",
    "echo \"needs gh\" #gh-repo: ok\n",
    "cat ~/.config/gh/hosts.yml\n",
    "ls /root/.config/gh/\n",
])
def test_untold_skips_a_line_marked_gh_repo_ok_and_a_folder_named_gh(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text, line", [
    ("command -v gh >/dev/null\n", 1),
    ("echo gh-repo: ok; gh pr view 1\n", 1),
    ("gh pr view 1 # gh-repo: okay\n", 1),
    ("# gh-repo: ok\ngh pr view 1\n", 2),
])
def test_untold_refuses_a_gh_command_without_the_marker_on_its_own_line(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


@pytest.mark.parametrize("text", [
    "Needs `gh` <!-- gh-repo: ok -->, as in `gh auth status`.\n",
    "```bash\ncommand -v gh # gh-repo: ok\n```\n",
    "Keep the token in `~/.config/gh/hosts.yml`.\n",
])
def test_untold_markdown_skips_a_line_marked_gh_repo_ok_and_a_folder_named_gh(tmp_path, text):
    # Arrange, Act
    found = untold_md(tmp_path, text)

    # Assert
    assert found == []


def test_untold_markdown_still_refuses_the_next_line_after_a_marked_one(tmp_path):
    # Arrange, Act
    found = untold_md(tmp_path, "`gh auth status` <!-- gh-repo: ok -->\n`gh pr view 1`\n")

    # Assert
    assert [line.split(":")[1] for line in found] == ["2"]


# --- mpaulosky/dotfiles#339: follow-ups from the review of #336 ---

# R50: an extensionless file with no shebang is skipped even when it holds a gh line (the empty file it replaces had none to find).
@pytest.mark.parametrize("content", ["\n" + UNTOLD, "# notes\n" + UNTOLD, " #!/bin/bash\n" + UNTOLD])
def test_check_repo_skips_an_extensionless_file_without_a_shell_shebang_that_holds_a_gh_line(tmp_path, content):
    # Arrange, Act
    found = repo_check(tmp_path, {"scripts/tool": content})

    # Assert
    assert found == []


def test_check_repo_checks_an_extensionless_file_whose_shebang_is_shell_and_whose_gh_line_follows_blank_lines(tmp_path):
    # Arrange, Act
    found = repo_check(tmp_path, {"scripts/tool": "#!/bin/bash\n\n" + UNTOLD})

    # Assert
    assert found == ["scripts/tool:3: gh pr view 1"]


# R55: a lookup line that ends in || or && goes on to its next command, not to a hidden subcommand.
@pytest.mark.parametrize("text", [
    "command -v gh >/dev/null 2>&1 ||\n  exit 1\nexport GH_REPO=o/r\ngh pr view 1\n",
    "command -v gh >/dev/null 2>&1 &&\n  echo found\nexport GH_REPO=o/r\ngh pr view 1\n",
    "command -v gh ||\n  exit 1\nexport GH_REPO=o/r\ngh pr view 1\n",
    "command -v gh &>/dev/null &&\n  echo found\nexport GH_REPO=o/r\ngh pr view 1\n",
    "command -v gh >/dev/null 2>&1 ||   \n  exit 1\nexport GH_REPO=o/r\ngh pr view 1\n",
])
def test_untold_accepts_a_lookup_line_ending_in_or_or_and_before_the_export(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text, line", [
    # A pipe or a backslash carries the line on to the next one, which may hold gh's subcommand.
    ("command -v gh |\n  cat\nexport GH_REPO=o/r\ngh pr view 1\n", 1),
    ("command -v gh >/dev/null 2>&1 |\n  cat\nexport GH_REPO=o/r\ngh pr view 1\n", 1),
    ("command -v gh \\\n  >/dev/null\nexport GH_REPO=o/r\ngh pr view 1\n", 1),
    ("command -v gh >/dev/null 2>&1 \\\n  || exit 1\nexport GH_REPO=o/r\ngh pr view 1\n", 1),
    # A gh with a subcommand is no lookup, whatever follows it.
    ("gh pr view 1 ||\n  exit 1\nexport GH_REPO=o/r\n", 1),
    ("gh pr view 1 &&\n  echo\nexport GH_REPO=o/r\n", 1),
    # The || does not tell the later gh anything: it is judged by the export before it.
    ("command -v gh ||\n  exit 1\ngh pr view 1\n", 3),
])
def test_untold_refuses_a_gh_line_that_goes_on_by_pipe_or_backslash_or_has_a_subcommand(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


# R56: the NAME=value words before gh are walked back over, and the last GH_REPO= among them is judged.
@pytest.mark.parametrize("text", [
    "GH_REPO=o/r GH_TOKEN=x gh pr view 1\n",
    "GH_TOKEN=x GH_REPO=o/r gh pr view 1\n",
    "GH_REPO=o/r GH_TOKEN=x GH_HOST=github.com gh pr list\n",
    "GH_TOKEN=x GH_REPO=o/r GH_HOST=github.com gh api repos/{owner}/{repo}/pulls\n",
    "GH_REPO=\"${repo:?}\" GH_TOKEN=\"$token\" gh pr view 1\n",
    "GH_REPO= GH_REPO=o/r gh pr view 1\n",
    "GH_REPO=o/r GH_TOKEN=x gh repo view o/r\n",
    "GH_REPO=o/r GH_TOKEN=x GH_REPO=o/s gh pr view 1\n",
    # A prefix that names a repository leaves the export standing, however many assignments it has.
    "export GH_REPO=o/r\nGH_REPO=o/s GH_TOKEN=x gh pr view 1\ngh pr view 2\n",
    # The export tells the gh behind a prefix with no GH_REPO= of its own.
    "export GH_REPO=o/r\nGH_TOKEN=x gh pr view 1\n",
])
def test_untold_accepts_a_gh_prefixed_by_assignments_and_a_told_gh_repo(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text, line", [
    ("GH_REPO=o/r GH_REPO= gh pr view 1\n", 1),
    ("GH_REPO=o/r GH_REPO=\"$repo\" gh pr view 1\n", 1),
    ("GH_REPO=\"$repo\" GH_TOKEN=x gh pr view 1\n", 1),
    ("GH_REPO= GH_TOKEN=x gh pr view 1\n", 1),
    ("GH_TOKEN=x GH_REPO= gh pr view 1\n", 1),
    ("export GH_REPO=o/r\nGH_REPO= GH_TOKEN=x gh pr view 1\n", 2),
    # GH_REPO does not reach gh repo view.
    ("GH_REPO=o/r GH_TOKEN=x gh repo view\n", 1),
    # A wrapper between the assignments and gh is not walked over.
    ("GH_REPO=o/r GH_TOKEN=x env gh pr view 1\n", 1),
    ("GH_REPO=o/r env gh pr view 1\n", 1),
    ("GH_REPO=o/r GH_TOKEN=x sudo gh pr view 1\n", 1),
    # The assignments are no prefix of a gh that comes after another command.
    ("GH_REPO=o/r GH_TOKEN=x echo; gh pr view 1\n", 1),
    ("GH_REPO=o/r GH_TOKEN=x echo && gh pr view 1\n", 1),
])
def test_untold_refuses_a_gh_whose_assignments_dont_name_a_repository_or_end_at_a_wrapper(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


def test_untold_ends_the_export_when_an_assignment_before_a_wrapper_empties_it(tmp_path):
    # Arrange
    text = "export GH_REPO=o/r\nGH_REPO= GH_TOKEN=x env true\ngh pr view 1\n"

    # Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, 3)


# R57: a heredoc that feeds data to a program is no code, as an echo message is not; one fed to a shell is code.
@pytest.mark.parametrize("text", [
    "cat <<EOF\nusage: needs gh pr view <n>\nEOF\nexport GH_REPO=o/r\ngh pr list\n",
    "cat <<'EOF'\nusage: gh pr view <n>\nEOF\nexport GH_REPO=o/r\ngh pr list\n",
    "cat <<\"EOF\"\nusage: gh pr view <n>\nEOF\nexport GH_REPO=o/r\ngh pr list\n",
    "cat <<-EOF\n\tusage: gh pr view <n>\n\tEOF\nexport GH_REPO=o/r\ngh pr list\n",
    "cat > usage.txt <<END\nRun gh pr view 1 to see it.\nEND\nexport GH_REPO=o/r\ngh pr list\n",
    "cat <<EOF >&2\nneeds gh\nEOF\nexport GH_REPO=o/r\ngh pr list\n",
    "usage() {\n  cat <<EOF\nneeds gh\nEOF\n}\nexport GH_REPO=o/r\ngh pr list\n",
    # Several lines of prose, a blank line among them.
    "cat <<EOF\nline one\n\ngh pr view 1\ngh repo view\nEOF\nexport GH_REPO=o/r\ngh pr list\n",
    # Prose naming gh at the very top, before anything else.
    "#!/usr/bin/env bash\ncat <<'EOF'\ngh pr view 1\nEOF\n",
])
def test_untold_skips_the_body_of_a_data_only_heredoc(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text, line", [
    ("bash <<EOF\ngh pr view 1\nEOF\n", 2),
    ("sh <<EOF\ngh pr view 1\nEOF\n", 2),
    ("bash <<'EOF'\ngh pr view 1\nEOF\n", 2),
    ("bash -e <<EOF\ngh pr view 1\nEOF\n", 2),
    ("bash -s -- arg <<-EOF\n\tgh pr view 1\n\tEOF\n", 2),
    ("/bin/bash <<EOF\ngh pr view 1\nEOF\n", 2),
    ("export GH_REPO=o/r\nbash <<EOF\ngh repo view\nEOF\n", 3),
    ("export GH_REPO=o/r\nsh <<EOF\ngh \"$@\"\nEOF\n", 3),
])
def test_untold_still_reads_the_body_of_a_heredoc_fed_to_a_shell(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


# An unquoted delimiter lets bash run the $(...) and backticks in the body; eval, source and . run the body itself.
@pytest.mark.parametrize("text, line", [
    ("body=$(cat <<EOF\nOpen PRs: $(gh pr list --state open)\nEOF\n)\n", 2),
    ("cat <<EOF\nOpen PRs: `gh pr list`\nEOF\n", 2),
    ("cat <<-EOF\n\tOpen: $(gh pr list)\n\tEOF\n", 2),
    ("cat <<EOF\nNow: $(echo $(gh pr list))\nEOF\n", 2),
    ("eval \"$(cat <<EOF\ngh pr view 1\nEOF\n)\"\n", 2),
    ("source /dev/stdin <<EOF\ngh pr view 1\nEOF\n", 2),
    (". /dev/stdin <<EOF\ngh pr view 1\nEOF\n", 2),
])
def test_untold_reads_what_an_unquoted_heredoc_runs(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


@pytest.mark.parametrize("text", [
    "cat <<'EOF'\nOpen PRs: $(gh pr list)\nEOF\n",
    "cat <<\"EOF\"\nOpen PRs: `gh pr list`\nEOF\n",
    "cat <<\\EOF\nOpen PRs: $(gh pr list)\nEOF\n",
    "cat <<EOF\nOpen PRs: \\$(gh pr list)\nEOF\n",
    "export GH_REPO=o/r\ncat <<EOF\nOpen PRs: $(gh pr list)\nEOF\n",
    "cat <<EOF\nOpen PRs: $(GH_REPO=o/r gh pr list)\nEOF\n",
    "cat <<EOF\nOpen PRs: $(gh pr list) # gh-repo: ok\nEOF\n",
])
def test_untold_accepts_a_heredoc_whose_substitutions_are_told_or_never_run(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


def test_untold_judges_the_line_after_a_heredoc_with_a_substitution(tmp_path):
    # Arrange
    text = "cat <<EOF\n$(date)\nEOF\ngh pr view 1\n"

    # Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, 4)


def test_untold_judges_the_line_after_a_data_heredocs_terminator(tmp_path):
    # Arrange
    text = "export GH_REPO=o/r\ncat <<EOF\ngh pr view 1\nEOF\ngh repo view\n"

    # Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, 5)


def test_untold_takes_no_export_from_the_body_of_a_data_heredoc(tmp_path):
    # Arrange
    text = "cat <<EOF\nexport GH_REPO=o/r\nEOF\ngh pr view 1\n"

    # Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, 4)


def test_untold_takes_no_unset_from_the_body_of_a_data_heredoc(tmp_path):
    # Arrange
    text = "export GH_REPO=o/r\ncat <<EOF\nunset GH_REPO\nEOF\ngh pr view 1\n"

    # Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


def test_untold_reads_the_heredoc_of_a_shell_after_a_data_one(tmp_path):
    # Arrange
    text = "cat <<EOF\ngh pr view 1\nEOF\nbash <<EOF\ngh pr view 2\nEOF\n"

    # Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, 5)


# R42: gh.exe is gh.
@pytest.mark.parametrize("text, line", [
    ("gh.exe pr view 1\n", 1),
    ("gh.exe issue list\n", 1),
    ("gh.exe repo view\n", 1),
    ("export GH_REPO=o/r\ngh.exe repo view\n", 2),
    ("gh.exe \"$@\"\n", 1),
    ("gh.exe $sub view 1\n", 1),
    ("export GH_REPO=o/r\nGH_REPO= gh.exe pr view 1\n", 2),
    ("gh.exe pr view 1\nexport GH_REPO=o/r\n", 1),
    ("echo \"$(gh.exe pr view 1)\"\n", 1),
    ("command -v gh.exe >/dev/null\n", 1),
    ("if command -v gh.exe\n", 1),
])
def test_untold_refuses_a_gh_exe_command_not_told_its_repository(tmp_path, text, line):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


@pytest.mark.parametrize("text", [
    "export GH_REPO=o/r\ngh.exe pr view 1\n",
    "GH_REPO=o/r gh.exe pr view 1\n",
    "GH_REPO=o/r GH_TOKEN=x gh.exe pr view 1\n",
    "gh.exe repo view o/r\n",
    "export GH_REPO=o/r\ncommand -v gh.exe >/dev/null || exit 1\n",
    "command -v gh.exe >/dev/null # gh-repo: ok\n",
])
def test_untold_accepts_a_gh_exe_command_told_its_repository(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text", [
    "agh.exe pr view 1\n",
    "neigh.exe pr view 1\n",
    "gh.executable pr view 1\n",
    "gh.exe2 pr view 1\n",
    "gh_.exe pr view 1\n",
    "mygh.exe pr view 1\n",
    "cat ~/.config/gh.exe/hosts.yml\n",
])
def test_untold_doesnt_read_a_longer_word_that_contains_gh_exe_as_gh(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found == []


@pytest.mark.parametrize("text, line", [
    ("```bash\ngh.exe pr view 1\n```\n", 2),
    ("Run `gh.exe pr list`.\n", 1),
    ("```bash\ngh.exe repo view\n```\n", 2),
    ("```bash\ngh.exe pr view 1 --repo o/r\ngh.exe pr list\n```\n", 3),
])
def test_untold_markdown_refuses_a_gh_exe_command_in_code_not_told_its_repository(tmp_path, text, line):
    # Arrange, Act
    found = untold_md(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


@pytest.mark.parametrize("text", [
    "```bash\ngh.exe pr view 1 --repo o/r\n```\n",
    "```bash\nGH_REPO=o/r gh.exe pr view 1\n```\n",
    "Run `gh.exe pr view 1 -R o/r`.\n",
    "Needs the gh.exe CLI.\n",
    "Install `gh.exe` first.\n",
])
def test_untold_markdown_accepts_a_gh_exe_command_told_its_repository_or_named_in_prose(tmp_path, text):
    # Arrange, Act
    found = untold_md(tmp_path, text)

    # Assert
    assert found == []


# R52: a skill's gh line is copy-pasteable, so a <owner>/<repo> placeholder doesn't tell it its repository.
@pytest.mark.parametrize("text, line", [
    ("```bash\ngh pr view 1 --repo <owner>/<repo>\n```\n", 2),
    ("```bash\ngh pr view 1 --repo=<owner>/<repo>\n```\n", 2),
    ("```bash\ngh pr view 1 -R <owner>/<repo>\n```\n", 2),
    ("```bash\nGH_REPO=<owner>/<repo> gh pr view 1\n```\n", 2),
    ("```bash\ngh repo view <owner>/<repo>\n```\n", 2),
    ("Run `gh pr list --repo <owner>/<repo>`.\n", 1),
    ("Run `gh pr list -R OWNER/REPO` or `gh pr list --repo <owner>/<repo>`.\n", 1),
])
def test_untold_markdown_refuses_a_placeholder_repository_after_repo(tmp_path, text, line):
    # Arrange, Act
    found = untold_md(tmp_path, text)

    # Assert
    assert_refused_at(found, text, line)


def test_check_repo_refuses_a_placeholder_repository_in_a_skill_by_its_relative_path(tmp_path):
    # Arrange, Act
    found = repo_check(tmp_path, {".claude/skills/mine/SKILL.md": "# Mine\n\n```bash\ngh issue list --repo <owner>/<repo>\n```\n"})

    # Assert
    assert found == [".claude/skills/mine/SKILL.md:4: gh issue list --repo <owner>/<repo>"]


# R47: the skills dotfiles keeps beside the Template pass the check, though --repo doesn't walk them (their folder isn't dotfiles' own).
SKILLS = HERE.parents[2]


@pytest.mark.parametrize("skill_name", ["review-changes", "remove-squad"])
def test_the_untold_gh_commands_of_the_skills_beside_the_template_are_fixed(skill_name):
    # Arrange
    checked = [path for path in sorted((SKILLS / skill_name).rglob("*"))
               if path.is_file() and check_gh_repo.kind(path) is not None]
    assert checked

    # Act
    found = [entry
             for path in checked
             for entry in (check_gh_repo.untold_markdown(path) if check_gh_repo.kind(path) == "markdown"
                           else check_gh_repo.untold(path))]

    # Assert
    assert found == []


# R45 and R52: gotchas.md holds the rules; the docstring points at it.
BASELINE_SKILL = HERE.parents[1]
GOTCHAS = BASELINE_SKILL / "references" / "gotchas.md"
SEED_SKILLS_README = BASELINE_SKILL / "template" / "seed" / ".claude" / "skills" / "README.md"


def test_the_checkers_docstring_is_one_line_that_points_at_gotchas_md():
    # Arrange
    docstring = check_gh_repo.__doc__.strip()

    # Act, Assert
    assert len(docstring.splitlines()) == 1
    assert "gotchas.md" in docstring


def test_gotchas_md_says_a_placeholder_repository_in_a_skill_is_refused():
    # Arrange
    text = GOTCHAS.read_text()

    # Act, Assert
    assert "<owner>/<repo>" in text
    assert re.search(r"<owner>/<repo>[^.]*\brefused\b|\brefused\b[^.]*<owner>/<repo>", text)


def test_the_seed_skills_readme_says_a_placeholder_repository_in_a_skill_is_refused():
    # Arrange
    text = SEED_SKILLS_README.read_text()

    # Act, Assert
    assert "<owner>/<repo>" in text
    assert re.search(r"<owner>/<repo>[^.]*\brefused\b|\brefused\b[^.]*<owner>/<repo>", text)


@pytest.mark.parametrize("rule", [r"gh\.exe", r"heredoc", r"binary"])
def test_gotchas_md_holds_the_rules_the_docstring_used_to(rule):
    # Arrange
    text = GOTCHAS.read_text()

    # Act, Assert
    assert re.search(rule, text)

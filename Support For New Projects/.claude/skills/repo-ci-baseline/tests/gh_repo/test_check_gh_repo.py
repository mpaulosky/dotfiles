"""Tests for check_gh_repo.py (mpaulosky/dotfiles#267, #321): every gh command in the
Template's Owned scripts, and in every repo's own scripts and skills, is told its repository, so a re-Apply can't fail a
Baseline repo's gate check for gh commands that reach gh's default repository
(a fork, in a fork's clone). No GitHub.
"""

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
TEMPLATE_OWNED = HERE.parents[1] / "template" / "owned"
sys.path.insert(0, str(TEMPLATE_OWNED / ".github" / "scripts"))
import check_gh_repo  # noqa: E402

OWNED_SCRIPTS = TEMPLATE_OWNED / "scripts"


def untold(tmp_path, text, name="script.sh"):
    path = tmp_path / name
    path.write_text(text)
    return check_gh_repo.untold(path)


@pytest.mark.parametrize("text", [
    "#!/usr/bin/env bash\ngh pr view 1\n",
    "gh issue list\n",
    "gh api repos/{owner}/{repo}/pulls\n",
    "echo \"$(gh pr view --json number)\"\n",
    "gh pr view 1 --repo o/r\n",
    "gh pr view 1\nexport GH_REPO=o/r\n",
    "export GH_REPO=\nexport GH_REPO=''\ngh pr view 1\n",
    "GH_REPO= gh pr view 1\n",
    "GH_REPO=o/r echo; gh pr view 1\n",
    "export GH_REPO=o/r && gh pr view 1\n",
    "gh \\\n  pr view 1\n",
    "if command -v gh\n",
    # The subcommand arrives through a variable or a wrapper.
    "gh \"$@\"\n",
    "gh $sub view 1\n",
    "gh \"${args[@]}\"\n",
    "gh_() { (cd \"$primary\" && gh \"$@\"); }\ngh_ pr view 1\n",
    # A variable that's empty where the script runs leaves gh its default.
    "export GH_REPO=\"$GITHUB_REPOSITORY\"\ngh pr view 1\n",
    "export GH_REPO=$repo\ngh pr view 1\n",
    "GH_REPO=\"$repo\" gh api repos/{owner}/{repo}/pulls\n",
    # The hidden subcommand can be gh repo view, which ignores GH_REPO.
    "export GH_REPO=o/r\ngh_() { gh \"$@\"; }\ngh_ repo view --json name\n",
    "export GH_REPO=o/r\ngh $sub view\n",
    # A character bash doesn't end a line on hides no export behind it.
    "echo x\u2028export GH_REPO=o/r\ngh pr view 1\n",
    "echo x\x0cexport GH_REPO=o/r\ngh pr view 1\n",
    # A redirection or a brace expansion before the subcommand hides it.
    "export GH_REPO=o/r\ngh 2>/dev/null repo view --json name\n",
    "export GH_REPO=o/r\ngh >\"$log\" repo edit o\n",
    "export GH_REPO=o/r\ngh {repo,} view\n",
    # Emptied or removed after the export.
    "export GH_REPO=o/r\nGH_REPO= gh pr view 1\n",
    "export GH_REPO=o/r\nunset GH_REPO\ngh pr view 1\n",
    "export GH_REPO=o/r\nGH_REPO=\"$repo\"\ngh pr view 1\n",
    # A list of gh's words, where no export reaches it.
    "export GH_REPO=o/r\nsubprocess.run([\"gh\", \"pr\", \"view\"])\n",
    # An export that runs only sometimes.
    "if [[ -n \"${CI:-}\" ]]; then\n  export GH_REPO=o/r\nfi\ngh pr view 1\n",
])
def test_untold_refuses_a_gh_command_not_told_its_repository(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found


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


@pytest.mark.parametrize("text", [
    "gh repo view\n",
    "gh repo view --json name\n",
    "gh repo\n",
    # GH_REPO doesn't reach view, edit and most of gh repo's subcommands.
    "export GH_REPO=o/r\ngh repo view\n",
    "GH_REPO=o/r gh repo view --json name\n",
    # view and edit have no -R or --repo; gh refuses them as unknown flags.
    "gh repo edit -R o/r --enable-auto-merge\n",
    "gh repo view --repo=o/r\n",
    "gh repo view \"$repo\"\n",
    "gh repo rename new-name\n",
])
def test_untold_refuses_gh_repo_without_its_repository(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found


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
    "",
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


def test_owned_names_files_and_folders_under_scripts_and_the_pre_push_review_skill_only():
    # Arrange, Act, Assert
    assert check_gh_repo.OWNED
    assert all(entry.startswith(("scripts/", ".claude/skills/pre-push-review/")) for entry in check_gh_repo.OWNED)


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

@pytest.mark.parametrize("text", [
    "```bash\ngh pr view 1\n```\n",
    "```\ngh pr view 1\n```\n",
    "~~~\ngh pr view 1\n~~~\n",
    "   ```bash\ngh pr view 1\n   ```\n",
    "Run `gh pr view 1` to see it.\n",
    "- Run `gh pr list`\n",
    "1. Then ``gh pr list`` shows them.\n",
    "Use `gh pr view 1` or `gh pr view 2 --repo o/r`.\n",
    # The repository comes from a variable gh would find empty, or from another command.
    "```bash\nGH_REPO=\"$repo\" gh pr view 1\n```\n",
    "```bash\ngh pr view 1 --repo \"$repo\"\n```\n",
    "```bash\nexport GH_REPO=o/r\ngh pr view 1\n```\n",
    "```bash\nGH_REPO=o/r echo; gh pr view 1\n```\n",
    "```bash\nGH_REPO= gh pr view 1\n```\n",
    # gh api has no --repo flag.
    "```bash\ngh api repos/o/r/pulls --repo o/r\n```\n",
    "```bash\ngh api repos/{owner}/{repo}/pulls\n```\n",
    # gh repo's subcommands take the repository first.
    "```bash\ngh repo view\n```\n",
    "```bash\ngh repo view --json name\n```\n",
    "```bash\ngh repo view --repo o/r\n```\n",
    "```bash\nGH_REPO=o/r gh repo view\n```\n",
    "Run `gh repo edit --enable-auto-merge`.\n",
    # A command split across lines, or with its subcommand hidden.
    "```bash\ngh \\\n  pr view 1 --repo o/r\n```\n",
    "```bash\ngh pr view 1 \\\n  --repo o/r\n```\n",
    "```bash\ngh \"$@\"\n```\n",
    "```bash\ngh $sub view 1\n```\n",
    "```bash\ngh\n```\n",
    # An unclosed fence is code to the end of the file; a longer fence isn't closed by a shorter one.
    "```bash\necho\ngh pr view 1\n",
    "````\n```\ngh pr view 1\n```\n````\n",
    "~~~\n```\ngh pr view 1\n```\n~~~\n",
    "```bash\necho\n```\n```bash\ngh pr view 1\n```\n",
    "Text\n\n```bash\necho\n```\n\nMore `gh issue list`\n",
    # A fence in a blockquote or a list item is still a fence.
    "> ```bash\n> gh pr view 1\n> ```\n",
    "> [!NOTE]\n> ```bash\n> gh pr view 1\n> ```\n",
    ">> ```bash\n>> gh pr view 1\n>> ```\n",
    "- ```bash\n  gh pr view 1\n  ```\n",
    "1. ```bash\n   gh pr view 1\n   ```\n",
    "* Step:\n  > ```bash\n  > gh pr view 1\n  > ```\n",
    "> ~~~\n> gh pr view 1\n> ~~~\n",
    "- ```bash\n  gh pr view 1\n",
])
def test_untold_markdown_refuses_a_gh_command_in_code_not_told_its_repository(tmp_path, text):
    # Arrange, Act
    found = untold_md(tmp_path, text)

    # Assert
    assert found


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
    "```bash\nneigh pr view 1\ngh_ pr view 1\ngh.exe pr view 1\n```\n",
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


@pytest.mark.parametrize("text", [
    "command -v gh >/dev/null\n",
    "echo gh-repo: ok; gh pr view 1\n",
    "gh pr view 1 # gh-repo: okay\n",
    "# gh-repo: ok\ngh pr view 1\n",
])
def test_untold_refuses_a_gh_command_without_the_marker_on_its_own_line(tmp_path, text):
    # Arrange, Act
    found = untold(tmp_path, text)

    # Assert
    assert found


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

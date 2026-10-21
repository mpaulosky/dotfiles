"""Tests for check_gh_repo.py (mpaulosky/dotfiles#267): every gh command in the
Template's Owned scripts is told its repository, so a re-Apply can't fail a
Baseline repo's gate check for gh commands that reach gh's default repository
(a fork, in a fork's clone). No GitHub.
"""

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check_gh_repo  # noqa: E402

OWNED_SCRIPTS = HERE.parents[1] / "template" / "owned" / "scripts"


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


def test_untold_skips_a_file_that_isnt_text(tmp_path):
    # Arrange
    path = tmp_path / "blob"
    path.write_bytes(b"\xff\xfegh pr view\n")

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


def test_main_passes_the_templates_owned_scripts():
    # Arrange, Act
    code = check_gh_repo.main([str(OWNED_SCRIPTS)])

    # Assert
    assert code == 0

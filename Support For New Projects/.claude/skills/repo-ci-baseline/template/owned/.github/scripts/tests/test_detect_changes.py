import subprocess

import pytest

import detect_changes as dc


def git(repo, *args):
    subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path):
    """A repo whose first commit holds some code and some docs; returns (path, base sha)."""
    git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.cs").write_text("class App {}\n")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "guide.md").write_text("# Guide\n")
    (tmp_path / "README.md").write_text("# Readme\n")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "base")
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, check=True, capture_output=True, text=True
    ).stdout.strip()
    return tmp_path, base


def commit(repo, message="change"):
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "-m", message)


def classify(repo, base):
    return dc.is_code_change(dc.changed_paths(base, cwd=repo))


@pytest.mark.parametrize(
    "path, doc",
    [
        ("docs/blogs/2026-09-30-pr-1-x.md", True),
        ("docs/index.html", True),
        ("README.md", True),
        ("src/App/README.md", True),
        ("src/App.cs", False),
        (".github/workflows/ci.yml", False),
        ("scripts/gate.sh", False),
        ("docsite/page.md", True),
        ("docsite/page.html", False),
        ("README.MD", False),
        ("src/docs/notes.txt", False),
    ],
)
def test_is_doc(path, doc):
    assert dc.is_doc(path) is doc


def test_a_docs_only_change_skips_the_build(repo):
    path, base = repo
    (path / "docs" / "guide.md").write_text("# Guide\n\nMore.\n")
    (path / "docs" / "index.html").write_text("<p>new</p>\n")
    (path / "README.md").write_text("# Readme\n\nMore.\n")
    commit(path)

    assert classify(path, base) is False


def test_a_code_change_runs_the_build(repo):
    path, base = repo
    (path / "src" / "App.cs").write_text("class App { }\n")
    commit(path)

    assert classify(path, base) is True


def test_a_mixed_change_runs_the_build(repo):
    path, base = repo
    (path / "docs" / "guide.md").write_text("# Guide\n\nMore.\n")
    (path / ".github").mkdir()
    (path / ".github" / "ci.yml").write_text("on: push\n")
    commit(path)

    assert classify(path, base) is True


def test_an_empty_diff_runs_the_build(repo):
    path, base = repo
    commit(path, "empty")

    assert dc.changed_paths(base, cwd=path) == []
    assert classify(path, base) is True


def test_moving_code_into_docs_runs_the_build(repo):
    path, base = repo
    git(path, "mv", "src/App.cs", "docs/App.cs")
    commit(path)

    assert dc.changed_paths(base, cwd=path) == ["docs/App.cs", "src/App.cs"]
    assert classify(path, base) is True


def test_renaming_code_to_a_md_name_runs_the_build(repo):
    path, base = repo
    git(path, "mv", "src/App.cs", "src/App.md")
    commit(path)

    assert classify(path, base) is True


def test_deleting_code_runs_the_build(repo):
    path, base = repo
    git(path, "rm", "-q", "src/App.cs")
    commit(path)

    assert classify(path, base) is True


def test_paths_with_spaces_and_newlines_are_kept_whole(repo):
    path, base = repo
    (path / "docs" / "a file.md").write_text("x\n")
    (path / "docs" / "odd\nname.md").write_text("x\n")
    commit(path)

    assert sorted(dc.changed_paths(base, cwd=path)) == ["docs/a file.md", "docs/odd\nname.md"]
    assert classify(path, base) is False


def test_main_writes_the_output_and_a_notice(repo, tmp_path_factory, monkeypatch, capsys):
    path, base = repo
    (path / "docs" / "guide.md").write_text("# Guide\n\nMore.\n")
    commit(path)
    output = tmp_path_factory.mktemp("out") / "github_output"
    output.write_text("earlier=1\n")
    monkeypatch.chdir(path)

    assert dc.main(["--base", base, "--output", str(output)]) == 0

    assert output.read_text() == "earlier=1\ncode=false\n"
    assert "::notice::Docs-only change (1 files)" in capsys.readouterr().out


def test_main_names_the_first_code_path(repo, tmp_path_factory, monkeypatch, capsys):
    path, base = repo
    (path / "src" / "App.cs").write_text("class App { }\n")
    commit(path)
    output = tmp_path_factory.mktemp("out") / "github_output"
    monkeypatch.chdir(path)

    dc.main(["--base", base, "--output", str(output)])

    assert output.read_text() == "code=true\n"
    assert "Code change: src/App.cs" in capsys.readouterr().out


def test_a_code_path_with_line_breaks_cant_start_a_workflow_command(repo, tmp_path_factory, monkeypatch, capsys):
    path, base = repo
    (path / "src" / "x\n::error::forged\r::warning::also").write_text("x\n")
    commit(path)
    output = tmp_path_factory.mktemp("out") / "github_output"
    monkeypatch.chdir(path)

    dc.main(["--base", base, "--output", str(output)])

    lines = capsys.readouterr().out.splitlines()
    assert lines == ["Code change: src/x\\n::error::forged\\r::warning::also"]
    assert output.read_text() == "code=true\n"


def test_an_unknown_base_fails(repo, tmp_path_factory, monkeypatch):
    path, _ = repo
    monkeypatch.chdir(path)

    with pytest.raises(subprocess.CalledProcessError):
        dc.main(["--base", "0" * 40, "--output", str(tmp_path_factory.mktemp("out") / "o")])


ACTIONS_BRANCH = "dependabot/github_actions/all-actions-1a2b3c"


@pytest.mark.parametrize(
    "paths, author, head_ref, bump",
    [
        ([".github/workflows/ci.yml", ".github/actions/setup/action.yml"], "dependabot[bot]", ACTIONS_BRANCH, True),
        # Every condition must hold.
        ([".github/workflows/ci.yml"], "mpaulosky", ACTIONS_BRANCH, False),
        ([".github/workflows/ci.yml"], "dependabot[bot]", "dependabot/nuget/all-nuget-1a2b3c", False),
        ([".github/workflows/ci.yml", "src/App.cs"], "dependabot[bot]", ACTIONS_BRANCH, False),
        ([".github/workflows/ci.yml", "global.json"], "dependabot[bot]", ACTIONS_BRANCH, False),
        ([], "dependabot[bot]", ACTIONS_BRANCH, False),
    ],
)
def test_is_actions_bump(paths, author, head_ref, bump):
    assert dc.is_actions_bump(paths, author, head_ref) is bump


def test_a_dependabot_actions_bump_skips_the_build(repo, tmp_path_factory, monkeypatch, capsys):
    path, base = repo
    (path / ".github" / "workflows").mkdir(parents=True)
    (path / ".github" / "workflows" / "ci.yml").write_text("uses: actions/checkout@" + "b" * 40 + "\n")
    commit(path)
    output = tmp_path_factory.mktemp("out") / "github_output"
    monkeypatch.chdir(path)

    dc.main(["--base", base, "--output", str(output), "--author", "dependabot[bot]", "--head-ref", ACTIONS_BRANCH])

    assert output.read_text() == "code=false\n"
    assert "::notice::Dependabot GitHub Actions bump (1 files)" in capsys.readouterr().out


def test_the_same_change_by_anyone_else_runs_the_build(repo, tmp_path_factory, monkeypatch):
    path, base = repo
    (path / ".github" / "workflows").mkdir(parents=True)
    (path / ".github" / "workflows" / "ci.yml").write_text("uses: actions/checkout@" + "b" * 40 + "\n")
    commit(path)
    output = tmp_path_factory.mktemp("out") / "github_output"
    monkeypatch.chdir(path)

    dc.main(["--base", base, "--output", str(output), "--author", "mpaulosky", "--head-ref", ACTIONS_BRANCH])

    assert output.read_text() == "code=true\n"

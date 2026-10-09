"""Tests for claude-review.yml's "Write the PR's diff" step, run against real git repos.

The step is inline in the workflow, so its run script (git diff, then the Python
heredoc that splits the diff into pieces) is read out of the file and run with
bash, as the other inline steps' tests do.
"""

import os
import re
import subprocess
import textwrap
from pathlib import Path

import pytest

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "claude-review.yml"

# No user or system config: a global hook, diff or quoting setting mustn't reach these repos.
GIT_ENV = {
    "PATH": os.environ["PATH"],
    "HOME": "/nonexistent",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def step_script():
    """The run script of the step with id: diff."""
    lines = WORKFLOW.read_text().splitlines()
    step = next(i for i, line in enumerate(lines) if line.strip() == "id: diff")
    start = next(i for i in range(step, len(lines)) if lines[i].strip() == "run: |") + 1
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "PY") + 1
    return textwrap.dedent("\n".join(lines[start:end])) + "\n"


def constant(name):
    return int(re.search(rf"^\s*{name} = ([\d_]+)", step_script(), re.M)[1].replace("_", ""))


MAX_PIECE_BYTES = constant("MAX_PIECE_BYTES")
MAX_PIECE_LINES = constant("MAX_PIECE_LINES")
MAX_READ_PIECES = constant("MAX_READ_PIECES")
MAX_READ_BYTES = constant("MAX_READ_BYTES")


class Repo:
    def __init__(self, path):
        self.path = path
        path.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "core.hooksPath", os.devnull)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.path, env=GIT_ENV, capture_output=True, check=True).stdout

    def commit(self, files):
        for name, content in files.items():
            path = self.path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if content is None:
                path.unlink()
            elif isinstance(content, bytes):
                path.write_bytes(content)
            else:
                path.write_text(content, encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", "change")
        return self.git("rev-parse", "HEAD").decode().strip()

    def split(self, base, head, tmp_path):
        """Run the step; return (its output's pieces text, the diff folder, the pr.diff bytes)."""
        runner_temp = tmp_path / "runner"
        runner_temp.mkdir()
        output = runner_temp / "output"
        output.write_text("")
        env = {**GIT_ENV, "RUNNER_TEMP": str(runner_temp), "GITHUB_OUTPUT": str(output),
               "BASE_SHA": base, "HEAD_SHA": head}
        done = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", step_script()], cwd=self.path, env=env, check=True,
                              capture_output=True)
        found = re.fullmatch(r"pieces<<(EOF_[0-9a-f]{16})\n(.*)\n\1\nskipped=(.*)\nlisted=(.*)\nheld=(\d+)\n",
                             output.read_text(), re.S)
        assert found, output.read_text()
        self.skipped, self.listed, self.held = found[3], found[4], int(found[5])
        self.log = done.stdout.decode("utf-8", "replace")
        folder = runner_temp / "claude-review" / "diff"
        return found[2], folder, (runner_temp / "claude-review" / "pr.diff").read_bytes()


@pytest.fixture
def repo(tmp_path):
    repo = Repo(tmp_path / "repo")
    repo.base = repo.commit({"README.md": "readme\n"})
    return repo


def index(folder):
    """INDEX's pieces: {name: (lines, read, [(kind, path), ...])}, in order."""
    pieces = {}
    for row in (folder / "INDEX").read_text(encoding="utf-8").split("\n")[1:-1]:
        if row in (EXCLUDED_HEADING, HELD_HEADING):
            break
        if row.startswith("\t"):
            _, kind, path = row.split("\t", 2)
            pieces[name][2].append((kind, path))
        else:
            name, lines, read = row.split("\t")
            pieces[name] = (lines, read, [])
    return pieces


EXCLUDED_HEADING = "excluded (Copilot doesn't review these)"
HELD_HEADING = "held\t(nobody reads these here, so they hold the merge for a person)"


def section(folder, heading):
    """The rows of INDEX's section under heading, as (kind, path)."""
    rows = (folder / "INDEX").read_text(encoding="utf-8").split("\n")[:-1]
    if heading not in rows:
        return []
    rest = rows[rows.index(heading) + 1:]
    end = next((i for i, row in enumerate(rest) if not row.startswith("\t")), len(rest))
    return [tuple(row.split("\t", 2)[1:]) for row in rest[:end]]


def excluded_of(folder):
    """The paths INDEX lists as excluded, in no piece."""
    return [path for _, path in section(folder, EXCLUDED_HEADING)]


def held_of(folder):
    """{path: reason} for the files INDEX lists as holding the merge."""
    return {path: reason for reason, path in section(folder, HELD_HEADING)}


def files_of(folder):
    """{path: (kind, read)} for every file's diff in INDEX, a split file's parts under one path."""
    return {path.split(" (part ")[0]: (kind, read)
            for _, read, files in index(folder).values() for kind, path in files}


def segments(content):
    """Each file's diff in content: (its diff --git line, its body without "(continued)" hunk headers)."""
    found = []
    for line in content.splitlines(keepends=True):
        if line.startswith(b"diff --git "):
            found.append((line, [], [True]))
        elif line.startswith(b"@@"):
            found[-1][2][0] = False
            if not line.endswith(b"@@ (continued)\n"):
                found[-1][1].append(line)
        elif not found[-1][2][0]:
            found[-1][1].append(line)
    return [(key, body) for key, body, _ in found]


def check_pieces(folder, diff):
    """Every piece is within the limits, and together they hold every line of every reviewed file's diff, in order.

    A file INDEX lists as excluded is in no piece.
    """
    names = sorted(p.name for p in folder.iterdir() if p.name != "INDEX")
    assert names == list(index(folder))
    assert all(re.fullmatch(r"\d{3}\.diff", name) for name in names)
    found = {}
    for name in names:
        content = (folder / name).read_bytes()
        assert len(content) <= MAX_PIECE_BYTES and content.count(b"\n") <= MAX_PIECE_LINES, name
        assert content.startswith(b"diff --git ")
        for key, body in segments(content):
            found.setdefault(key, []).extend(body)
    excluded = {f"diff --git a/{path} b/{path}\n".encode() for path in excluded_of(folder)}
    assert {key: joined(body) for key, body in found.items()} == {
        key: body for key, body in segments(diff) if key not in excluded}


def joined(body):
    """body with each long line's later chunks, which may be in the next piece, joined back onto it."""
    lines = []
    for line in body:
        if line.startswith(b"\\~ "):
            lines[-1] = lines[-1][:-1] + line[3:]
        else:
            lines.append(line)
    return lines


def check_line_numbers(folder, repo, head):
    """Every context and added line sits where its hunk headers say, in the head's file."""
    for name in index(folder):
        for key, _ in segments((folder / name).read_bytes()):
            content = (folder / name).read_bytes()
            lines = content[content.index(key):].split(b"\n")
            path = next(line[6:].decode() for line in lines if line.startswith(b"+++ b/"))
            file = repo.git("show", f"{head}:{path}").split(b"\n")
            new = None
            for at, line in enumerate(lines[1:], 1):
                if line.startswith(b"diff --git "):
                    break
                if line.startswith(b"@@"):
                    new = int(re.match(rb"@@ -\d+(?:,\d+)? \+(\d+)", line)[1])
                elif new is not None and line[:1] in (b" ", b"+"):
                    # A long line's first chunk is only the start of it; its later chunks take no number.
                    cut = at + 1 < len(lines) and lines[at + 1].startswith(b"\\~ ")
                    assert file[new - 1].startswith(line[1:]) if cut else file[new - 1] == line[1:], (name, path, new)
                    new += 1


def test_files_are_packed_into_numbered_pieces_in_read_order(repo, tmp_path):
    head = repo.commit({"src/app.py": "print(1)\n", ".github/workflows/ci.yml": "on: push\n",
                        "tests/test_app.py": "def test(): pass\n", "README.md": "readme 2\n",
                        "scripts/build.sh": "make\n"})
    text, folder, diff = repo.split(repo.base, head, tmp_path)
    lines = diff.count(b"\n")
    assert index(folder) == {"001.diff": (f"{lines} lines", "read", [
        ("workflow", ".github/workflows/ci.yml"), ("script", "scripts/build.sh"), ("source", "src/app.py"),
        ("test", "tests/test_app.py"), ("docs", "README.md")])}
    assert text == f"- {folder}/001.diff ({lines} lines: workflow, script, source, test, docs)"
    assert repo.skipped == ""
    check_pieces(folder, diff)


def test_a_big_multi_file_diff_is_covered_whole(repo, tmp_path):
    files = {f"src/module{i}.py": "".join(f"value_{i}_{n} = {n}\n" for n in range(700)) for i in range(4)}
    files["zz/late.yml"] = "".join(f"# step {n}\n" for n in range(1500))
    files[".github/workflows/late.yml"] = "".join(f"# step {n}\n" for n in range(1500))
    head = repo.commit(files)
    text, folder, diff = repo.split(repo.base, head, tmp_path)
    assert len(diff.splitlines()) > 5000
    check_pieces(folder, diff)
    check_line_numbers(folder, repo, head)
    # Every file is in a piece the prompt lists, the workflow, last in the diff, first.
    assert set(files_of(folder)) == set(files)
    assert {read for _, read in files_of(folder).values()} == {"read"}
    assert len(text.splitlines()) == len(index(folder))
    assert next(iter(index(folder).values()))[2][0] == ("workflow", ".github/workflows/late.yml (part 1 of 2)")


def test_a_huge_file_is_split_into_parts_with_their_line_numbers(repo, tmp_path):
    old = "".join(f"line {n}\n" for n in range(6000))
    repo.base = repo.commit({"big.txt": old})
    # One hunk too big for any piece, and several small ones after it.
    new = old.replace("line 10\n", "".join(f"new {n}\n" for n in range(4000)))
    for n in (4000, 4500, 5000, 5500):
        new = new.replace(f"line {n}\n", f"changed {n}\n")
    head = repo.commit({"big.txt": new})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    parts = [path for _, _, files in index(folder).values() for _, path in files]
    assert len(parts) >= 3
    assert parts == [f"big.txt (part {n} of {len(parts)})" for n in range(1, len(parts) + 1)]
    check_pieces(folder, diff)
    check_line_numbers(folder, repo, head)
    assert any(b"@@ (continued)\n" in (folder / name).read_bytes() for name in index(folder))


def test_a_long_line_is_cut_into_chunks_within_a_piece(repo, tmp_path):
    head = repo.commit({"app.min.css": "a{}" * 30_000, "wide.txt": "\u00e9" * 60_000 + "\n"})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    for name in index(folder):
        content = (folder / name).read_bytes()
        assert len(content) <= MAX_PIECE_BYTES
        content.decode("utf-8")  # never cut inside a character
    # Every chunk after a line's first is marked, so none reads as a line of its own.
    wide = next((folder / name).read_bytes() for name, (_, _, files) in index(folder).items()
                if any(path.startswith("wide.txt") for _, path in files))
    rows = wide.split(b"\n")
    first = next(i for i, row in enumerate(rows) if row.startswith(b"+\xc3\xa9"))
    assert all(row.startswith(b"\\~ \xc3\xa9") for row in rows[first + 1:-1])
    check_pieces(folder, diff)
    check_line_numbers(folder, repo, head)
    assert repo.skipped == ""
    assert files_of(folder) == {"wide.txt": ("docs", "read"), "app.min.css": ("source", "read")}
    assert repo.listed.split() == list(index(folder))


def test_lines_after_a_long_line_split_across_parts_keep_their_numbers(repo, tmp_path):
    # The long line's chunks run past a piece, so a part opens inside it with a "(continued)" header.
    head = repo.commit({"data.txt": "".join(f"before {n}\n" for n in range(5)) + "x" * 90_000 + "\n"
                        + "".join(f"after {n}\n" for n in range(20))})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    assert len(index(folder)) > 1
    assert any(b"@@ (continued)\n\\~ " in (folder / name).read_bytes() for name in index(folder))
    check_pieces(folder, diff)
    check_line_numbers(folder, repo, head)


def test_a_rename_a_binary_and_a_deletion(repo, tmp_path):
    repo.base = repo.commit({"old/name.py": "".join(f"x = {n}\n" for n in range(50)), "logo.png": b"\x89PNG\0\1\2",
                             "gone.py": "y = 1\n"})
    head = repo.commit({"old/name.py": None, "new/name.py": "".join(f"x = {n}\n" for n in range(50)),
                        "logo.png": b"\x89PNG\0\3\4", "gone.py": None})
    text, folder, diff = repo.split(repo.base, head, tmp_path)
    # Deleted files come after the rest; a rename is the old path's deletion and the new path's addition.
    assert index(folder)["001.diff"][2] == [("source", "logo.png"), ("source", "new/name.py"),
                                            ("deleted", "gone.py"), ("deleted", "old/name.py")]
    content = (folder / "001.diff").read_bytes()
    assert b"Binary files" in content and b"rename to" not in content
    check_pieces(folder, diff)


def test_a_rename_into_data_shows_the_old_files_deletion(repo, tmp_path):
    workflow = "on: push\njobs: {}\n"
    repo.base = repo.commit({".github/workflows/ci.yml": workflow, "src/Result.cs": "class Result {}\n"})
    head = repo.commit({".github/workflows/ci.yml": None, "notes/ci.log": workflow,
                        "src/Result.cs": None, "old/Result.cs.map": "class Result {}\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert files_of(folder) == {".github/workflows/ci.yml": ("deleted", "read"), "src/Result.cs": ("deleted", "read")}
    assert sorted(excluded_of(folder)) == ["notes/ci.log", "old/Result.cs.map"]


def test_a_rename_out_of_an_excluded_path_is_read_and_holds(repo, tmp_path):
    payload = "".join(f"steal({n})\n" for n in range(40))
    repo.base = repo.commit({"dist/payload.js": payload})
    head = repo.commit({"dist/payload.js": None, "src/payload.js": payload})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert files_of(folder) == {"src/payload.js": ("source", "read")}
    assert b"+steal(39)" in (folder / "001.diff").read_bytes()
    # Deleting excluded code holds the merge.
    assert held_of(folder) == {"dist/payload.js": "excluded"}


def test_an_odd_path_never_names_a_file_nor_reaches_the_prompt(repo, tmp_path):
    odd = "we ird/\u00e9t\u00e9 $(touch pwned) `x` \"q\"\tTAB\nNEWLINE ../..; -rf.py"
    head = repo.commit({odd: "print('hi')\n", "--help": "x\n", "b/ b/x.png": b"\0bin"})
    text, folder, diff = repo.split(repo.base, head, tmp_path)
    assert sorted(p.name for p in folder.iterdir()) == ["001.diff", "INDEX"]
    assert not (repo.path / "pwned").exists() and not (tmp_path / "pwned").exists()
    # INDEX holds each path on one line, as git quotes it.
    assert (folder / "INDEX").read_text(encoding="utf-8").count("\n") == 5
    assert [path for _, path in index(folder)["001.diff"][2]] == [
        "--help", "b/ b/x.png",
        '"we ird/\\303\\251t\\303\\251 $(touch pwned) `x` \\"q\\"\\tTAB\\nNEWLINE ../..; -rf.py"']
    # The prompt's list holds piece names, counts and kinds only.
    assert re.fullmatch(rf"- {re.escape(str(folder))}/001\.diff \(\d+ lines: source\)", text)
    check_pieces(folder, diff)


def test_an_empty_diff(repo, tmp_path):
    head = repo.commit({})
    text, folder, diff = repo.split(repo.base, head, tmp_path)
    assert diff == b""
    assert text == "(none: the diff is empty)"
    assert sorted(p.name for p in folder.iterdir()) == ["INDEX"]
    assert (folder / "INDEX").read_text() == "The diff is empty.\n"


def test_past_the_read_budget_the_rest_are_named_and_workflows_come_first(repo, tmp_path):
    # Each file's diff is about 30 KB, so one fits a piece, and only MAX_READ_PIECES of them are asked for.
    files = {f"docs/f{i:02d}.md": "".join(f"name_{i}_{n} = {n:020d}\n" for n in range(900))
             for i in range(MAX_READ_PIECES + 2)}
    files[".github/workflows/z.yml"] = "".join(f"# {n:028d}\n" for n in range(900))
    files["package-lock.json"] = "{}\n"
    head = repo.commit(files)
    text, folder, _ = repo.split(repo.base, head, tmp_path)
    assert excluded_of(folder) == ["package-lock.json"]
    pieces = index(folder)
    read = [name for name, (_, flag, _) in pieces.items() if flag == "read"]
    assert len(read) == MAX_READ_PIECES
    assert sum((folder / name).stat().st_size for name in read) <= MAX_READ_BYTES
    assert pieces["001.diff"][2] == [("workflow", ".github/workflows/z.yml")]
    unread = {path for _, flag, files in pieces.values() if flag == "not read" for _, path in files}
    assert unread == {f"docs/f{i:02d}.md" for i in range(MAX_READ_PIECES - 1, MAX_READ_PIECES + 2)}
    listed, _, rest = text.partition("\nNot asked for")
    assert len(listed.splitlines()) == MAX_READ_PIECES
    assert all(name in rest for name, (_, flag, _) in pieces.items() if flag == "not read")
    # Every unread piece is named for the hold; the read ones are listed.
    assert repo.skipped.split() == [name for name, (_, flag, _) in pieces.items() if flag == "not read"]
    assert repo.listed.split() == read


# Copilot code review's exclusions, as https://docs.github.com/en/copilot/reference/review-excluded-files lists them

COPILOT_EXCLUDED_NAMES = [
    ".gitignore", "package-lock.json", "yarn.lock", "jest.config.js", "next.config.js", "tailwind.config.js",
    "tsconfig.json", "requirements.txt", "Pipfile.lock", "Gemfile.lock", "composer.lock", "Cargo.lock", "go.sum",
    "paket.lock", "pubspec.lock", "stack.yaml", "elm.json", "Project.toml", "Manifest.toml", "renv.lock", "build.sbt",
    "Package.resolved", "deps.edn", "build.gradle", "mix.lock", "build.gradle.kts", "cpanfile", "Podfile.lock",
    "conanfile.txt", "info.rkt", "rockspec", "opam", "rebar.config", "nimble", "shard.yml", "dub.json", "dub.sdl",
    "GPR", "Mason.toml", "fpm.toml", "pack.pl", "baseline.st", "PacletInfo.m", "info.ss", "Jpkg", "box.json",
    "GNAVI.xml",
]
# A file each glob excludes, at the root and deeper where the glob allows.
COPILOT_EXCLUDED_GLOB_FILES = {
    "**/*.svg": ["logo.svg", "web/img/icon.svg"],
    "**/*.log": ["build.log", "logs/app.log"],
    "**/*.lock": ["pnpm.lock", "sub/poetry.lock"],
    "**/go.sum": ["svc/go.sum"],
    "**/*.ipynb.raw.html": ["nb/report.ipynb.raw.html"],
    "**/dist/**/*": ["dist/app.js", "web/dist/x/y.js"],
    "**/node_modules/**/*": ["node_modules/a/index.js"],
    "**/*.min.js": ["web/site.min.js"],
    "**/*.d.ts": ["types/index.d.ts"],
    "**/coverage/**/*": ["coverage/lcov.info"],
    "**/*.bundle.js": ["web/app.bundle.js"],
    "**/*.map": ["web/site.min.js.map"],
    "**/out/**/*": ["out/Main.class.txt", "a/out/b.txt"],
    "**/vendor/**/*": ["vendor/lib/x.go"],
    "**/generated/**/*": ["src/generated/Api.cs"],
    "**/generated-sources/**/*": ["target/generated-sources/A.java"],
    "**/bin/**/*": ["bin/Debug/app.dll.config", "src/App/bin/Release/x.json"],
}


def test_the_workflow_copies_copilots_documented_list():
    script = step_script()
    names = re.search(r"COPILOT_EXCLUDED_NAMES = frozenset\(\((.*?)\)\)", script, re.S)[1]
    globs = re.search(r"COPILOT_EXCLUDED_GLOBS = \((.*?)\)\n", script, re.S)[1]
    assert re.findall(r'"([^"]+)"', names) == COPILOT_EXCLUDED_NAMES
    assert re.findall(r'"([^"]+)"', globs) == list(COPILOT_EXCLUDED_GLOB_FILES)
    assert "review-excluded-files" in script and "2026-10-09" in script


def test_every_file_copilot_excludes_is_in_no_piece(repo, tmp_path):
    # "x" for content: a .gitignore naming itself would keep itself out of the commit.
    files = {f"deps/{name}": "x\n" for name in COPILOT_EXCLUDED_NAMES}
    files.update({path: "x\n" for paths in COPILOT_EXCLUDED_GLOB_FILES.values() for path in paths})
    files["src/app.py"] = "print(1)\n"
    head = repo.commit(files)
    text, folder, diff = repo.split(repo.base, head, tmp_path)
    assert set(excluded_of(folder)) == set(files) - {"src/app.py"}
    assert files_of(folder) == {"src/app.py": ("source", "read")}
    assert len(index(folder)) == 1 and repo.skipped == ""
    # Inert data holds nothing; the rest of what nobody reads, lockfiles included, holds the merge.
    data = {f"deps/{name}" for name in DATA_NAMES} | {
        path for glob in ("**/*.log", "**/*.map", "**/coverage/**/*")
        for path in COPILOT_EXCLUDED_GLOB_FILES[glob]}
    assert held_of(folder) == {path: "excluded" for path in set(files) - {"src/app.py"} - data}
    assert repo.held == len(held_of(folder)) and "holds the merge for a person" in repo.log
    check_pieces(folder, diff)


DATA_NAMES = [".gitignore"]


def test_the_data_names_are_copilots_and_in_the_workflow():
    script = step_script()
    names = re.findall(r'"([^"]+)"', re.search(r"DATA_NAMES = frozenset\(\((.*?)\)\)", script, re.S)[1])
    assert names == DATA_NAMES and set(names) <= set(COPILOT_EXCLUDED_NAMES)


def test_a_name_matches_only_a_whole_basename(repo, tmp_path):
    head = repo.commit({"pkg/opam": "x\n", "pkg/opam.txt": "x\n", "my.gitignore": "x\n", "nimble/x.nim": "x\n",
                        "GPR.txt": "x\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert excluded_of(folder) == ["pkg/opam"]
    assert set(files_of(folder)) == {"pkg/opam.txt", "my.gitignore", "nimble/x.nim", "GPR.txt"}


def test_copilots_bin_exceptions_and_dotnet_files_are_reviewed(repo, tmp_path):
    reviewed = {"tools/bin/main.rs": "fn main() {}\n", "src/bin/cli/args.rs": "fn a() {}\n",
                "core/hybris/bin/custom/ext/Ext.java": "class Ext {}\n",
                "src/App/Model.g.cs": "class M {}\n", "src/App/packages.lock.json": "{}\n",
                "Directory.Packages.props": "<Project />\n", "tests/Api.verified.txt": "{}\n"}
    head = repo.commit({**reviewed, "tools/bin/main.py": "x\n", "hybris/bin/platform/x.java": "x\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert set(files_of(folder)) == set(reviewed)
    assert sorted(excluded_of(folder)) == ["hybris/bin/platform/x.java", "tools/bin/main.py"]


def test_only_excluded_data_leaves_nothing_to_read_and_holds_nothing(repo, tmp_path):
    head = repo.commit({"build.log": "x\n", "web/site.min.js.map": "{}\n", "coverage/lcov.info": "x\n"})
    text, folder, _ = repo.split(repo.base, head, tmp_path)
    assert text == "(none: every changed file is one Copilot code review excludes)"
    assert index(folder) == {} and repo.listed == "" and repo.skipped == ""
    assert repo.held == 0 and held_of(folder) == {} and "::warning::" not in repo.log


def test_only_excluded_code_leaves_nothing_to_read_and_holds_the_merge(repo, tmp_path):
    head = repo.commit({"web/vendor/analytics.min.js": "steal()\n"})
    text, folder, _ = repo.split(repo.base, head, tmp_path)
    assert text == "(none: every changed file is one Copilot code review excludes)"
    assert index(folder) == {} and repo.listed == ""
    assert repo.held == 1 and held_of(folder) == {"web/vendor/analytics.min.js": "excluded"}


def test_excluded_data_under_github_holds_the_merge(repo, tmp_path):
    head = repo.commit({".github/actions/foo/dist/index.js": "run()\n", ".github/actions/foo/build.log": "x\n",
                        "build.log": "x\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {".github/actions/foo/dist/index.js": "excluded", ".github/actions/foo/build.log": "excluded"}


def test_a_lockfile_holds_the_merge(repo, tmp_path):
    # It decides which dependency code the build installs and runs.
    head = repo.commit({"package-lock.json": "{}\n", "web/yarn.lock": "x\n", "svc/go.sum": "x\n", "Cargo.lock": "x\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {path: "excluded" for path in ("package-lock.json", "web/yarn.lock", "svc/go.sum",
                                                             "Cargo.lock")}


def test_only_a_named_coverage_report_is_data(repo, tmp_path):
    reports = {"coverage/lcov.info": "x\n", "web/coverage/coverage-final.json": "{}\n",
               "coverage/cobertura-coverage.xml": "<c/>\n", "coverage/clover.xml": "<c/>\n"}
    code = {"src/app/coverage/policy.rb": "class Policy; end\n", "coverage/pom.xml": "<project/>\n",
            "packages/coverage/package.json": "{}\n", "coverage/index.html": "<script/>\n",
            "tools/coverage/requirements.txt": "x\n"}
    head = repo.commit({**reports, **code})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {path: "excluded" for path in code}


@pytest.mark.parametrize("svg", ["<svg/>", '<svg><path d="M0 0"/></svg>',
                                 '<svg><s:script xmlns:s="http://www.w3.org/2000/svg">x()</s:script></svg>',
                                 '<svg><a href="javascript&#58;x()"/></svg>'],
                         ids=["empty", "path", "prefixed-script", "char-ref"])
def test_a_changed_svg_holds_the_merge(repo, tmp_path, svg):
    # An SVG can script in more ways than a pattern can list, so any change to one holds.
    head = repo.commit({"public/logo.svg": svg + "\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {"public/logo.svg": "excluded"}


def test_a_notebooks_raw_html_holds_the_merge(repo, tmp_path):
    # HTML, so it can script like an SVG.
    head = repo.commit({"notebooks/x.ipynb.raw.html": "<script>x()</script>\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {"notebooks/x.ipynb.raw.html": "excluded"}


def test_uncommenting_an_svgs_script_holds_the_merge(repo, tmp_path):
    repo.base = repo.commit({"public/logo.svg": "<svg>\n<!--\n<script>x()</script>\n-->\n</svg>\n"})
    head = repo.commit({"public/logo.svg": "<svg>\n<script>x()</script>\n</svg>\n"})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {"public/logo.svg": "excluded"}


def test_a_deleted_svg_holds_nothing(repo, tmp_path):
    repo.base = repo.commit({"public/logo.svg": "<svg><script>x()</script></svg>\n"})
    head = repo.commit({"public/logo.svg": None})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {}


def test_deleting_excluded_code_holds_the_merge_but_deleting_data_doesnt(repo, tmp_path):
    repo.base = repo.commit({"next.config.js": "module.exports = {headers}\n", "dist/app.js": "x\n",
                             "build.log": "x\n", ".github/actions/foo/build.log": "x\n", "src/app.py": "x\n"})
    head = repo.commit({"next.config.js": None, "dist/app.js": None, "build.log": None,
                        ".github/actions/foo/build.log": None, "src/app.py": None})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert held_of(folder) == {"next.config.js": "excluded", "dist/app.js": "excluded",
                               ".github/actions/foo/build.log": "excluded"}
    assert files_of(folder) == {"src/app.py": ("deleted", "read")}


def test_an_excluded_file_past_the_budget_is_never_read(repo, tmp_path):
    lock = "".join(f'"node_modules/p{n}": {{"resolved": "https://registry.example/p{n}-{n:020d}.tgz"}}\n'
                   for n in range(MAX_READ_BYTES // 40))
    head = repo.commit({"src/app.py": "print(2)\n", "package-lock.json": lock, "dist/bundle.js": lock})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    assert list(index(folder)) == ["001.diff"] and repo.listed == "001.diff" and repo.skipped == ""
    assert sorted(excluded_of(folder)) == ["dist/bundle.js", "package-lock.json"]
    assert held_of(folder) == {"dist/bundle.js": "excluded", "package-lock.json": "excluded"}


def test_a_binary_is_reviewed_as_git_shows_it_and_holds_the_merge_unless_its_media(repo, tmp_path):
    repo.base = repo.commit({"old/Tool.dll": b"MZ\0\1", "old/logo.png": b"\x89PNG\0\1"})
    head = repo.commit({"scripts/deploy.sh": b"#!/bin/bash\n# \0\n", "lib/Tool.dll": b"MZ\0\0",
                        "web/img/Logo.PNG": b"\x89PNG\0\0", "fonts/a.woff2": b"wOF2\0", "docs/a.pdf": b"%PDF\0",
                        "old/Tool.dll": None, "old/logo.png": None})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    assert diff.count(b"Binary files") == 7
    assert set(files_of(folder)) == {"scripts/deploy.sh", "lib/Tool.dll", "web/img/Logo.PNG", "fonts/a.woff2",
                                     "docs/a.pdf", "old/Tool.dll", "old/logo.png"}
    # Deleting a binary runs nothing.
    assert held_of(folder) == {"scripts/deploy.sh": "binary", "lib/Tool.dll": "binary"} and repo.held == 2
    assert repo.skipped == "" and "holds the merge for a person" in repo.log


def test_the_prs_own_gitattributes_cant_hide_its_text(repo, tmp_path):
    repo.base = repo.commit({"src/App.cs": "class A {}\n"})
    head = repo.commit({".gitattributes": "*.cs -diff\n", "src/App.cs": "class A { void Steal() {} }\n"})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    assert b"Binary files" not in diff and b"+class A { void Steal() {} }" in diff
    assert repo.held == 0

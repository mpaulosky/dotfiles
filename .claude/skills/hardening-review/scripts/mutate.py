#!/usr/bin/env python3
"""Apply hand-written mutations one at a time and check the tests catch each.

    mutate.py SPEC.json [--root DIR]

SPEC.json is data, not code:

    {"test": ["pnpm", "run", "test"], "timeout": 600,
     "mutations": [{"path": "src/a.sh", "old": "exit 1", "new": "exit 0", "why": "the failure path",
                    "equivalent": "optional: why a survivor is harmless"}]}

Each target must be tracked and committed, so a restore can't lose work. The tests run as an argv
list with no shell, in their own process group that is killed when they end, time out or are
interrupted. Exit 0: every mutation was CAUGHT (or EQUIVALENT with a reason). Exit 1: one SURVIVED,
was NOT FOUND, AMBIGUOUS or INVALID. Exit 2: the spec or the tree was refused. Exit 130: interrupted
(SIGINT, SIGTERM or SIGHUP); the files are restored. When the tests fail before any mutation, the
last lines of their output (stdout and stderr) are printed with the refusal.

A runner killed with SIGKILL can't restore anything. It claims a journal first (a text file under
review/ in the common git directory, which Sandcastle hides from its sandboxes; one journal per
worktree, shared by every --root in it), writes the originals into it, named relative to the
worktree's top level, before the first mutation, and the next run, or a second run at the same
time, refuses to start until the files are restored (git checkout, from the top level) and the
journal is deleted. The journal is never written in place: the claim is staged in a file of its own and
hard-linked into position (a hard link fails if the journal exists), and the originals replace it with
os.replace, so it is never empty and any journal blocks the run; nothing is deleted to take over.
POSIX only: the tests run in a process group.
"""
import argparse
import base64
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_TIMEOUT = 86400
TAIL_LINES = 20
TAIL_BYTES = 8192
POSIX = hasattr(os, "killpg") and hasattr(signal, "SIGHUP")


class Refused(Exception):
    pass


def clean_env(pycache=None):
    """The environment for git and the tests: a hook's GIT_* variables would point them at another repository."""
    env = {key: value for key, value in os.environ.items() if key not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX")}
    if pycache:
        # Same-size mutations inside one second can load a stale .pyc (CPython checks the source's whole-second mtime and size).
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONPYCACHEPREFIX"] = pycache
    return env


def plain(value, what):
    """A string that can be written to a file and passed in an argv."""
    if "\x00" in value:
        raise Refused(f"{what} has a NUL byte")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise Refused(f"{what} is not valid text (a lone surrogate)")
    return value


def load_spec(path):
    try:
        spec = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read the spec: {error}")
    if not isinstance(spec, dict):
        raise Refused("the spec must be a JSON object")
    test = spec.get("test")
    if not isinstance(test, list) or not test or not all(isinstance(part, str) and part for part in test):
        raise Refused('"test" must be a non-empty list of strings (an argv, run without a shell)')
    for part in test:
        plain(part, '"test"')
    timeout = spec.get("timeout", 600)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= MAX_TIMEOUT:
        raise Refused(f'"timeout" must be a number of seconds above 0 and at most {MAX_TIMEOUT}')
    mutations = spec.get("mutations")
    if not isinstance(mutations, list) or not mutations:
        raise Refused('"mutations" must be a non-empty list')
    for index, item in enumerate(mutations, 1):
        if not isinstance(item, dict):
            raise Refused(f"mutation {index} must be an object")
        for key in ("path", "old", "new"):
            if not isinstance(item.get(key), str):
                raise Refused(f'mutation {index}: "{key}" must be a string')
            plain(item[key], f'mutation {index}: "{key}"')
        if not item["path"] or not item["old"]:
            raise Refused(f'mutation {index}: "path" and "old" must not be empty')
        equivalent = item.get("equivalent")
        if equivalent is not None and (not isinstance(equivalent, str) or not equivalent.strip()):
            raise Refused(f'mutation {index}: "equivalent" must be a reason')
    return test, float(timeout), mutations


def git(root, *args):
    # Literal pathspecs: a file named a*.py must not match a tracked ab.py.
    return subprocess.run(["git", "--literal-pathspecs", "-C", str(root), *args], capture_output=True, text=True, errors="surrogateescape", env=clean_env())


def target_files(root, mutations):
    """Each target's original bytes, after checking it is inside root, tracked and unchanged."""
    originals = {}
    for item in mutations:
        resolved = (root / item["path"]).resolve()
        try:
            relative = resolved.relative_to(root)
        except ValueError:
            raise Refused(f'{item["path"]} is outside {root}')
        if resolved in originals:
            continue
        if not resolved.is_file():
            raise Refused(f"{relative} is not a file")
        if git(root, "ls-files", "--error-unmatch", "--", str(relative)).returncode != 0:
            raise Refused(f"{relative} is not tracked: commit it first")
        status = git(root, "status", "--porcelain", "--", str(relative))
        if status.returncode != 0 or status.stdout.strip():
            raise Refused(f"{relative} has uncommitted changes: commit the fix first, so a restore can't lose work")
        originals[resolved] = resolved.read_bytes()
    return originals


def git_line(root, option):
    """The one path `git rev-parse OPTION` prints. Only the final newline is cut: a path can hold any other line separator."""
    result = git(root, "rev-parse", "--path-format=absolute", option)
    output = result.stdout.removesuffix("\n")
    if result.returncode != 0 or not output or "\n" in output:
        raise Refused(f"{root} is not in a git repository")
    return output


def locate(root):
    """(the journal's path, the worktree's top level).

    The journal is under review/ in the common git dir: Sandcastle hides it from its sandboxes (which can write the rest of .git), and
    the ledger reads only *.json there. One per worktree (keyed on its top level, not on --root, so a run from a subfolder shares it),
    so two worktrees don't block each other. Its names are relative to that top level."""
    common = git_line(root, "--git-common-dir")
    top = Path(git_line(root, "--show-toplevel")).resolve()
    digest = hashlib.sha256(os.fsencode(str(top))).hexdigest()[:16]
    return Path(common) / "review" / f"mutate-journal-{digest}.txt", top


def journal_path(root):
    return locate(root)[0]


def inside(root, name):
    try:
        (root / name).resolve().relative_to(root)
        return True
    except (OSError, ValueError):
        return False


def describe_journal(journal, top):
    """Why a journal blocks the run. It is a plain file, so only names inside the checkout are repeated."""
    try:
        recorded = json.loads(journal.read_text(encoding="utf-8"))["files"]
        if not isinstance(recorded, dict):
            raise TypeError
    except (OSError, ValueError, KeyError, TypeError):
        recorded = None
    if recorded == {}:
        return f"another run is in progress, or one was killed before it changed a file: delete {journal} if none is running"
    files = ", ".join(sorted(name for name in recorded or () if inside(top, name))) or "unknown files"
    return (f"a previous run was killed and may have left a mutation in {files}: check `git diff`, restore them with "
            f"`git checkout -- <file>` in {top}, then delete {journal}")


def stage(journal, text):
    """Write text to a file of its own beside the journal and return its path. The file is removed again if the write fails."""
    handle, name = tempfile.mkstemp(prefix=".mutate-journal-", suffix=".tmp", dir=journal.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as staged:
            staged.write(text)
            staged.flush()
            os.fsync(staged.fileno())
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise
    return Path(name)


def claim_journal(journal, top):
    """Claim the journal before anything slow, so a second run sees it; exclusive, so two can't both pass.

    The claim is staged in a file of its own and hard-linked into position, which fails if the journal exists: the journal is never
    empty, so any journal that exists blocks the run and nothing is deleted to take over."""
    journal.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    staged = stage(journal, json.dumps({"files": {}}))
    try:
        os.link(staged, journal)
    except FileExistsError:
        raise Refused(describe_journal(journal, top))
    finally:
        staged.unlink(missing_ok=True)


def write_journal(journal, top, originals):
    """Replace the claim with the originals in one step, so a reader never sees the journal empty or half written."""
    data = {str(path.relative_to(top)): base64.b64encode(content).decode("ascii") for path, content in originals.items()}
    staged = stage(journal, json.dumps({"files": data}))
    try:
        os.replace(staged, journal)
    except BaseException:
        staged.unlink(missing_ok=True)
        raise


def output_tail(stream, name):
    """The last TAIL_LINES lines of one stream the tests wrote, from at most its last TAIL_BYTES bytes, under its name."""
    try:
        size = stream.seek(0, os.SEEK_END)
        stream.seek(max(0, size - TAIL_BYTES))
        lines = stream.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return f"{name}:\n" + "\n".join(lines[-TAIL_LINES:]) if lines else ""


def run_tests(argv, root, timeout, pycache):
    """(passed, timed_out, the tail of the output). The whole process group dies with the run, whatever ended it."""
    # Two files, not one: a test's buffered stdout would otherwise land after its stderr and push the reason out of the tail.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            process = subprocess.Popen(argv, cwd=root, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       env=clean_env(pycache), start_new_session=True)
        except (OSError, ValueError) as error:
            raise Refused(f"cannot run the test command: {error}")
        try:
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                return False, True, ""
            tail = "\n".join(part for part in (output_tail(out, "stdout"), output_tail(err, "stderr")) if part)
            return process.returncode == 0, False, tail
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            process.wait()


def restore(originals):
    for path, data in originals.items():
        try:
            if path.read_bytes() != data:
                path.write_bytes(data)
        except OSError:
            path.write_bytes(data)


def label(item):
    return f'{item["path"]}: {item["old"][:70]!r}'


def interrupted(signum, frame):
    raise KeyboardInterrupt


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("spec")
    parser.add_argument("--root", default=".")
    args = parser.parse_args(argv)
    if not POSIX:
        print("refused: mutate.py needs a POSIX system (the tests run in a process group)", file=sys.stderr)
        return 2
    root = Path(args.root).resolve()
    originals = {}
    journal = None
    claimed = False
    pycache = None
    # SIGINT too: Python leaves it ignored when the runner was started from a background job.
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        signal.signal(getattr(signal, name), interrupted)
    try:
        test, timeout, mutations = load_spec(args.spec)
        journal, top = locate(root)
        claim_journal(journal, top)
        claimed = True
        pycache = tempfile.mkdtemp(prefix="mutate-pycache-")
        originals = target_files(root, mutations)
        passed, timed_out, tail = run_tests(test, root, timeout, pycache)
        if timed_out:
            raise Refused(f"the tests did not finish within {timeout:g} seconds before any mutation: raise \"timeout\", or fix them")
        if not passed:
            raise Refused("the tests fail before any mutation: fix them first, or every mutation would look caught"
                          + (f"\nthe last lines of their output:\n{tail}" if tail else ""))
        write_journal(journal, top, originals)
        failed = False
        for item in mutations:
            path = (root / item["path"]).resolve()
            try:
                text = originals[path].decode("utf-8")
            except UnicodeDecodeError:
                raise Refused(f'{item["path"]} is not UTF-8')
            if item["old"] == item["new"]:
                print(f"INVALID {label(item)} (old and new are the same)")
                failed = True
                continue
            count = text.count(item["old"])
            if count == 0:
                print(f"NOT FOUND {label(item)}")
                failed = True
                continue
            if count > 1:
                print(f"AMBIGUOUS {label(item)} ({count} occurrences: add context to old)")
                failed = True
                continue
            try:
                path.write_bytes(text.replace(item["old"], item["new"], 1).encode("utf-8"))
                passed, timed_out, _ = run_tests(test, root, timeout, pycache)
            finally:
                restore(originals)
            if not passed:
                print(f"CAUGHT {label(item)}" + (" (timed out)" if timed_out else ""))
            elif item.get("equivalent"):
                print(f"EQUIVALENT {label(item)}: {item['equivalent']}")
            else:
                print(f"SURVIVED {label(item)}")
                failed = True
        print("FAILED: a mutation was not caught" if failed else "OK: every mutation was caught")
        return 1 if failed else 0
    except Refused as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        restore(originals)
        print("interrupted: files restored", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"refused: unexpected {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    finally:
        restore(originals)
        if pycache:
            shutil.rmtree(pycache, ignore_errors=True)
        if claimed and all(path.read_bytes() == data for path, data in originals.items()):
            journal.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

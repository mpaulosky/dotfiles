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
(SIGINT, SIGTERM or SIGHUP); the files are restored.

A runner killed with SIGKILL can't restore anything. It writes a journal of the originals into the
git directory first, and the next run refuses to start until the files are restored (git checkout)
and the journal is deleted.
"""
import argparse
import base64
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_TIMEOUT = 86400


class Refused(Exception):
    pass


def clean_env():
    """The environment for git and the tests: a hook's GIT_* variables would point them at another repository."""
    env = {key: value for key, value in os.environ.items() if key not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX")}
    # Same-size mutations inside one second can load a stale .pyc (CPython checks the source's whole-second mtime and size).
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONPYCACHEPREFIX"] = tempfile.mkdtemp(prefix="mutate-pycache-")
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
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= MAX_TIMEOUT:
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
    return subprocess.run(["git", "--literal-pathspecs", "-C", str(root), *args], capture_output=True, text=True, env=clean_env())


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


def journal_path(root):
    result = git(root, "rev-parse", "--absolute-git-dir")
    if result.returncode != 0:
        raise Refused(f"{root} is not in a git repository")
    return Path(result.stdout.strip()) / "mutate-journal.json"


def check_journal(journal, root):
    if journal.exists():
        try:
            files = ", ".join(sorted(json.loads(journal.read_text(encoding="utf-8")).get("files", {})))
        except (OSError, ValueError, AttributeError):
            files = "unknown files"
        raise Refused(f"a previous run was killed and may have left a mutation in {files}: restore them with `git checkout -- <file>` "
                      f"in {root}, then delete {journal}")


def write_journal(journal, root, originals):
    data = {str(path.relative_to(root)): base64.b64encode(content).decode("ascii") for path, content in originals.items()}
    journal.write_text(json.dumps({"files": data}), encoding="utf-8")


def run_tests(argv, root, timeout):
    """(passed, timed_out). The whole process group dies with the run, whatever ended it."""
    try:
        process = subprocess.Popen(argv, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=clean_env(), start_new_session=True)
    except (OSError, ValueError) as error:
        raise Refused(f"cannot run the test command: {error}")
    try:
        try:
            process.wait(timeout=timeout)
            return process.returncode == 0, False
        except subprocess.TimeoutExpired:
            return False, True
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
    root = Path(args.root).resolve()
    originals = {}
    journal = None
    for name in ("SIGTERM", "SIGHUP"):
        signal.signal(getattr(signal, name), interrupted)
    try:
        test, timeout, mutations = load_spec(args.spec)
        journal = journal_path(root)
        check_journal(journal, root)
        originals = target_files(root, mutations)
        passed, timed_out = run_tests(test, root, timeout)
        if timed_out:
            raise Refused(f"the tests did not finish within {timeout:g} seconds before any mutation: raise \"timeout\", or fix them")
        if not passed:
            raise Refused("the tests fail before any mutation: fix them first, or every mutation would look caught")
        write_journal(journal, root, originals)
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
                passed, timed_out = run_tests(test, root, timeout)
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
        if journal is not None and originals and journal.exists() and all(path.read_bytes() == data for path, data in originals.items()):
            journal.unlink()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

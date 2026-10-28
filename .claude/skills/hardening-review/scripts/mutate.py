#!/usr/bin/env python3
"""Apply hand-written mutations one at a time and check the tests catch each.

    mutate.py SPEC.json [--root DIR]

SPEC.json is data, not code:

    {"test": ["pnpm", "run", "test"], "timeout": 600,
     "mutations": [{"path": "src/a.sh", "old": "exit 1", "new": "exit 0", "why": "the failure path",
                    "equivalent": "optional: why a survivor is harmless"}]}

Each target must be tracked and committed, so a restore can't lose work. The tests run as an argv
list with no shell. Exit 0: every mutation was CAUGHT (or EQUIVALENT with a reason). Exit 1: one
SURVIVED, was NOT FOUND, AMBIGUOUS or INVALID. Exit 2: the spec or the tree was refused.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
from pathlib import Path


class Refused(Exception):
    pass


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
    timeout = spec.get("timeout", 600)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise Refused('"timeout" must be a positive number of seconds')
    mutations = spec.get("mutations")
    if not isinstance(mutations, list) or not mutations:
        raise Refused('"mutations" must be a non-empty list')
    for index, item in enumerate(mutations, 1):
        if not isinstance(item, dict):
            raise Refused(f"mutation {index} must be an object")
        for key in ("path", "old", "new"):
            if not isinstance(item.get(key), str):
                raise Refused(f'mutation {index}: "{key}" must be a string')
        if not item["path"] or not item["old"]:
            raise Refused(f'mutation {index}: "path" and "old" must not be empty')
        equivalent = item.get("equivalent")
        if equivalent is not None and (not isinstance(equivalent, str) or not equivalent.strip()):
            raise Refused(f'mutation {index}: "equivalent" must be a reason')
    return test, float(timeout), mutations


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)


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


def run_tests(argv, root, timeout):
    """(passed, timed_out)."""
    try:
        result = subprocess.run(argv, cwd=root, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, True
    except OSError as error:
        raise Refused(f"cannot run the test command: {error}")
    return result.returncode == 0, False


def restore(originals):
    for path, data in originals.items():
        try:
            if path.read_bytes() != data:
                path.write_bytes(data)
        except OSError:
            path.write_bytes(data)


def label(item):
    return f'{item["path"]}: {item["old"][:70]!r}'


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("spec")
    parser.add_argument("--root", default=".")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    originals = {}
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        test, timeout, mutations = load_spec(args.spec)
        if git(root, "rev-parse", "--show-toplevel").returncode != 0:
            raise Refused(f"{root} is not in a git repository")
        originals = target_files(root, mutations)
        passed, _ = run_tests(test, root, timeout)
        if not passed:
            raise Refused("the tests fail before any mutation: fix them first, or every mutation would look caught")
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
        print("interrupted: files restored", file=sys.stderr)
        return 130
    finally:
        restore(originals)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

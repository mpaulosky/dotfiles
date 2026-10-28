#!/usr/bin/env python3
"""The hardening review's known-open list: findings a person accepted or deferred.

    known_open.py add LIST.json --root DIR --id R3 --lens Security --path src/a.sh --start 10 --end 14 --reason "..."
    known_open.py check LIST.json --root DIR [--for-reviewers]

An entry holds a hash of the lines it points at (`--start 0 --end 0` hashes the whole file). `check`
prints every entry with `changed`: true when those lines now differ, are past the end of the file, or
the file is gone, so the finding is raised again; false means it stays suppressed. `--for-reviewers`
prints only id, lens, path and changed: never the reason, so no summary of a weakness reaches a reviewer.
Exit 2: refused.
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

KEYS = {"id", "lens", "path", "start", "end", "hash", "reason"}


class Refused(Exception):
    pass


def load(listing):
    path = Path(listing)
    if not path.exists():
        return []
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read {listing}: {error}")
    if not isinstance(entries, list) or not all(isinstance(entry, dict) and KEYS <= set(entry) for entry in entries):
        raise Refused(f"{listing} is not a known-open list")
    return entries


def inside(root, relative):
    resolved = (Path(root).resolve() / relative).resolve()
    try:
        resolved.relative_to(Path(root).resolve())
    except ValueError:
        raise Refused(f"{relative} is outside {root}")
    return resolved


def digest(file, start, end):
    """The hash of lines start..end (1-based, inclusive), or None when they aren't there."""
    try:
        data = file.read_bytes()
    except OSError:
        return None
    if start == 0 and end == 0:
        return hashlib.sha256(data).hexdigest()
    lines = data.splitlines(keepends=True)
    if end > len(lines):
        return None
    return hashlib.sha256(b"".join(lines[start - 1:end])).hexdigest()


def add(args):
    entries = load(args.listing)
    if any(entry["id"] == args.id for entry in entries):
        raise Refused(f"{args.id} is already in the list")
    if args.start < 0 or args.end < 0 or (args.start == 0) != (args.end == 0) or args.end < args.start:
        raise Refused("--start and --end are 1-based and inclusive, or both 0 for the whole file")
    file = inside(args.root, args.path)
    value = digest(file, args.start, args.end)
    if value is None:
        raise Refused(f"{args.path} lacks lines {args.start}-{args.end}")
    entries.append({"id": args.id, "lens": args.lens, "path": args.path, "start": args.start, "end": args.end,
                    "hash": value, "reason": args.reason})
    listing = Path(args.listing)
    listing.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=listing.parent, suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        json.dump(entries, stream, indent=2)
    os.replace(temporary, listing)


def check(args):
    result = []
    for entry in load(args.listing):
        try:
            value = digest(inside(args.root, entry["path"]), entry["start"], entry["end"])
        except Refused:
            value = None
        changed = value != entry["hash"]
        if args.for_reviewers:
            result.append({"id": entry["id"], "lens": entry["lens"], "path": entry["path"], "changed": changed})
        else:
            result.append({**entry, "changed": changed})
    print(json.dumps(result, indent=2))


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("add", "check"):
        command = commands.add_parser(name)
        command.add_argument("listing")
        command.add_argument("--root", default=".")
    adding = commands.choices["add"]
    adding.add_argument("--id", required=True)
    adding.add_argument("--lens", required=True)
    adding.add_argument("--path", required=True)
    adding.add_argument("--start", type=int, required=True)
    adding.add_argument("--end", type=int, required=True)
    adding.add_argument("--reason", required=True)
    commands.choices["check"].add_argument("--for-reviewers", action="store_true")
    args = parser.parse_args(argv)
    try:
        add(args) if args.command == "add" else check(args)
    except Refused as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

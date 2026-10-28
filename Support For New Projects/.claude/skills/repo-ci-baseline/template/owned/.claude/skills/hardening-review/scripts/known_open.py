#!/usr/bin/env python3
"""The hardening review's known-open list: findings a person accepted or deferred.

    known_open.py add LIST.json --root DIR --id R3 --lens Security --path src/a.sh --start 10 --end 14 --reason "..."
    known_open.py check LIST.json --root DIR [--for-reviewers]
    known_open.py match LIST.json --root DIR --lens Security --path src/a.sh --line 12

An entry holds a hash of the lines it points at: 1-based and inclusive, or `--start 0 --end 0` for the
whole file. Lines end at a newline only. `check` prints every entry with `changed`: true when those
lines now differ, are past the end of the file, or the file is gone or outside --root. `--for-reviewers`
prints id, lens, path, start, end and changed, never the reason, so no summary of a weakness reaches a
reviewer. `match` says whether a finding (lens, path and line; line 0 for a finding with none) is
settled: `suppressed` is true only when an entry covers it, with a lens in common (`Bar/Security` has
two), the same file, and the line inside its range (a whole-file entry covers any line), and that
entry's lines are unchanged. A finding outside every range is new. Exit 2: refused.
"""
import argparse
import hashlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

STRINGS = ("id", "lens", "path", "hash", "reason")


class Refused(Exception):
    pass


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def valid_range(start, end):
    return integer(start) and integer(end) and ((start == 0 and end == 0) or 1 <= start <= end)


def load(listing):
    path = Path(listing)
    if not path.exists():
        return []
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read {listing}: {error}")
    if not isinstance(entries, list):
        raise Refused(f"{listing} is not a known-open list")
    for index, entry in enumerate(entries, 1):
        name = f"entry {index}" + (f" ({entry['id']})" if isinstance(entry, dict) and isinstance(entry.get("id"), str) else "")
        if not isinstance(entry, dict):
            raise Refused(f"{listing}: {name} is not an object")
        for key in STRINGS:
            if not isinstance(entry.get(key), str):
                raise Refused(f"{listing}: {name} lacks a text {key}")
        if not valid_range(entry.get("start"), entry.get("end")):
            raise Refused(f"{listing}: {name} has a bad range: start and end are whole numbers, 1-based, or both 0")
    return entries


def inside(root, relative):
    base = Path(root).resolve()
    resolved = (base / relative).resolve()
    try:
        resolved.relative_to(base)
    except ValueError:
        raise Refused(f"{relative} is outside {root}")
    return base, resolved


def digest(file, start, end):
    """The hash of lines start..end, or None when they aren't there."""
    try:
        data = file.read_bytes()
    except OSError:
        return None
    if start == 0 and end == 0:
        return hashlib.sha256(data).hexdigest()
    lines = io.BytesIO(data).readlines()
    if end > len(lines):
        return None
    return hashlib.sha256(b"".join(lines[start - 1:end])).hexdigest()


def not_blank(value, what):
    if not value.strip():
        raise Refused(f"{what} must not be blank")


def add(args):
    entries = load(args.listing)
    if any(entry["id"] == args.id for entry in entries):
        raise Refused(f"{args.id} is already in the list")
    for value, what in ((args.id, "--id"), (args.lens, "--lens"), (args.reason, "--reason")):
        not_blank(value, what)
    if not valid_range(args.start, args.end):
        raise Refused("--start and --end are 1-based and inclusive, or both 0 for the whole file")
    base, file = inside(args.root, args.path)
    value = digest(file, args.start, args.end)
    if value is None:
        raise Refused(f"{args.path} lacks lines {args.start}-{args.end}")
    entries.append({"id": args.id, "lens": args.lens, "path": file.relative_to(base).as_posix(), "start": args.start,
                    "end": args.end, "hash": value, "reason": args.reason})
    listing = Path(args.listing)
    private_folder(listing.parent)
    handle, temporary = tempfile.mkstemp(dir=listing.parent, suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        json.dump(entries, stream, indent=2)
    os.replace(temporary, listing)


def private_folder(folder):
    """Make the folder, and each missing one above it, readable by this user only: the reasons can describe a weakness."""
    missing = []
    while not folder.exists():
        missing.append(folder)
        folder = folder.parent
    for made in reversed(missing):
        made.mkdir(mode=0o700)


def changed(root, entry):
    try:
        _, file = inside(root, entry["path"])
    except Refused:
        return True
    return digest(file, entry["start"], entry["end"]) != entry["hash"]


def check(args):
    result = []
    for entry in load(args.listing):
        state = changed(args.root, entry)
        if args.for_reviewers:
            result.append({key: entry[key] for key in ("id", "lens", "path", "start", "end")} | {"changed": state})
        else:
            result.append({**entry, "changed": state})
    print(json.dumps(result, indent=2))


def lenses(text):
    return {part.strip() for part in text.split("/") if part.strip()}


def match(args):
    if args.line < 0:
        raise Refused("--line is 1-based, or 0 for a finding with no line")
    base, file = inside(args.root, args.path)
    covering = []
    for entry in load(args.listing):
        try:
            _, entry_file = inside(args.root, entry["path"])
        except Refused:
            continue
        whole = entry["start"] == 0
        if entry_file != file or not lenses(entry["lens"]) & lenses(args.lens):
            continue
        if whole or entry["start"] <= args.line <= entry["end"]:
            covering.append({"id": entry["id"], "changed": changed(args.root, entry)})
    print(json.dumps({"suppressed": any(not entry["changed"] for entry in covering), "entries": covering}, indent=2))


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("add", "check", "match"):
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
    matching = commands.choices["match"]
    matching.add_argument("--lens", required=True)
    matching.add_argument("--path", required=True)
    matching.add_argument("--line", type=int, required=True)
    args = parser.parse_args(argv)
    try:
        {"add": add, "check": check, "match": match}[args.command](args)
    except Refused as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

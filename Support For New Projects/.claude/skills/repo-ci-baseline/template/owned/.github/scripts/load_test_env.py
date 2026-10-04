#!/usr/bin/env python3
"""Export the repo's optional TEST_ENV secret to the test steps.

Called by each "Tests: <name>" job in .github/workflows/ci.yml, with the
secret in the TEST_ENV environment variable:

    python3 .github/scripts/load_test_env.py --output "$GITHUB_ENV"

TEST_ENV holds one NAME=value line per variable the test fixtures need, such
as MongoDB__ConnectionString=mongodb+srv://... Blank lines and lines starting
with "#" are skipped. Each value is masked in the log before it's appended to
the output file, so later steps (prepare.sh and the test run) see it and the
log never does.

ci.yml is Owned by the Template, so it can't name a repo's own secrets. One
fixed secret holding all of them keeps per-repo values out of it, and unlike
secrets[<dynamic name>] it doesn't send every repo secret to the runner.
An unset secret (any repo without one, and every Dependabot run) exports
nothing.

Values are single-line: GITHUB_ENV's NAME=value form can't hold a newline.
A malformed line fails the job without printing its value.

Standard library only.
"""

import argparse
import os
import re
import sys

NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def parse(text):
    """The (name, value) pairs in TEST_ENV's text; raises ValueError naming the bad line's number."""
    pairs = []
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        name = name.strip()
        if not separator or not NAME.fullmatch(name):
            raise ValueError(f"line {number} isn't NAME=value")
        if name.startswith("GITHUB_") or name.startswith("RUNNER_"):
            raise ValueError(f"line {number} sets a reserved {name.split('_')[0]}_ variable")
        pairs.append((name, value.strip()))
    return pairs


def escape_data(value):
    """A value escaped for a workflow command's data, as the runner decodes it.

    The runner percent-decodes the data of "::add-mask::", so a literal "%25"
    in a secret would otherwise register "%" and leave the real value unmasked.
    """
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main(argv=None, environ=os.environ, out=sys.stdout):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", required=True, help="the file to append NAME=value lines to ($GITHUB_ENV)")
    args = parser.parse_args(argv)

    try:
        pairs = parse(environ.get("TEST_ENV", ""))
    except ValueError as error:
        print(f"::error::The TEST_ENV secret is malformed: {error}.", file=out)
        return 1
    if not pairs:
        print("No TEST_ENV secret; no test secrets exported.", file=out)
        return 0

    for _, value in pairs:
        if value:
            print(f"::add-mask::{escape_data(value)}", file=out)
    with open(args.output, "a", encoding="utf-8") as output:
        for name, value in pairs:
            output.write(f"{name}={value}\n")
    print(f"Exported {len(pairs)} test secrets: {', '.join(name for name, _ in pairs)}", file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

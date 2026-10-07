"""release_post.py's output checked against the renderers that publish it, not against its own model of Markdown.

Each case is a grid: every container prefix with every tricky body. The
scanner's unit tests pin the cases someone thought of; these catch the shape
nobody did, as Copilot found one per review round on the last re-Apply.
"""

import sys
from pathlib import Path

import pytest

from renderers import cmark, kramdown, read

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "template/owned/.github/scripts"))
import release_post as rp  # noqa: E402

SHA = "abc1234"

# A commit subject's leading containers: none, quotes, lists, nesting, a tab, and indent wide enough to make code.
COMMIT_PREFIXES = ["", "> ", "- ", "* ", "1. ", "10. ", "- - ", "> - ", "-\t", ">     ", "-     ", ">     - "]
# Bodies that start like a definition in either renderer, and ones that mustn't be touched. "zq" marks the text
# that has to stay visible.
COMMIT_BODIES = [
    "[zq]: docs/x.md",
    "[zq b]: c d",
    "[zq\\]b]: x",
    "[^zq]: note",
    "*[ZQ]: Hyper",
    "<!--x-->[zq]: x",
    "[Use `zq<T>`]: s",
    "[docs](https://x.test) zq",
    "[WIP] zq",
    "zq plain",
]
COMMIT_CASES = [prefix + body for prefix in COMMIT_PREFIXES for body in COMMIT_BODIES]

# A paragraph's first-line prefix and the prefix its later lines carry, in the README.
README_CONTAINERS = [
    ("", ""),
    ("> ", "> "),
    ("> > ", "> > "),
    ("> ", ""),  # a lazy continuation line
    (">\t", ">\t"),
    ("- ", "  "),
    ("- > ", "  > "),
    ("- - > ", "    > "),
    ("10. > ", "    > "),
    ("1. - > ", "     > "),
]
# Links whose label or title holds what a scanner can misread; {c} is a later line's prefix.
README_BODIES = [
    "[x](docs/a.md)",
    '[<span\n{c}title="]">x</span>](docs/a.md)',
    "[<!X\n{c}a]b>x](docs/a.md)",
    "[<!x a]b>x](docs/a.md)",
    "[<?pi\n{c}a]b?>x](docs/a.md)",
    "[<![CDATA[\n{c}a]b]]>x](docs/a.md)",
    '[x](docs/a.md\n{c}"t `") [y](docs/b.md) `',
    "![<https://example.test/a]b>](docs/logo.png)",
    "[x][a]\n{c}\n{c}[a]: docs/a.md",
]
README_CASES = [first + body.format(c=later) + "\n" for first, later in README_CONTAINERS for body in README_BODIES]


@pytest.fixture(scope="module")
def commit_lines():
    return [rp.render_commits([{"sha": SHA + "def", "commit": {"message": case}}]) for case in COMMIT_CASES]


@pytest.fixture(scope="module", params=[cmark, kramdown], ids=["cmark-gfm", "kramdown"])
def rendered_commits(request, commit_lines):
    return request.param(commit_lines)


@pytest.mark.parametrize("index", range(len(COMMIT_CASES)), ids=[repr(case) for case in COMMIT_CASES])
def test_every_commit_stays_visible(rendered_commits, index):
    # Visible: its text and SHA show, and no escape the post added shows as a stray backslash.
    _, text = read(rendered_commits[index])
    assert "zq" in text.lower()
    assert SHA in text
    assert "\\" not in text


@pytest.fixture(scope="module")
def rendered_readmes():
    rebased = [rp.rebase_readme_links(case) for case in README_CASES]
    return cmark(README_CASES), cmark(rebased)


@pytest.mark.parametrize("index", range(len(README_CASES)), ids=[repr(case) for case in README_CASES])
def test_every_readme_link_is_rebased_and_nothing_else(rendered_readmes, index):
    # GitHub reads the README; the docs/ copy must hold the same links, one directory up, and the same text.
    original, rebased = rendered_readmes
    links, text = read(original[index])
    assert read(rebased[index]) == ([link.removeprefix("docs/") for link in links], text)

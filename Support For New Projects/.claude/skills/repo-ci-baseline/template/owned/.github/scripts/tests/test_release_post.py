import io
import json
import re
import subprocess
import time
import urllib.error
from pathlib import Path

import pytest

import release_post as rp

REPO = "octo/demo"


class FakeGitHub:
    """Stands in for the gh CLI wrapper with canned API data."""

    def __init__(self, releases=None):
        self.pulls = {
            42: {
                "number": 42,
                "title": 'feat(ui): Add the "dark" theme',
                "body": "Adds a theme.",
                "html_url": f"https://github.com/{REPO}/pull/42",
                "merged_at": "2026-09-24T21:30:00Z",
            },
            7: {"number": 7, "title": "fix: Older change", "body": "", "html_url": "", "merged_at": ""},
        }
        self.releases_data = releases if releases is not None else [
            {
                "tag_name": "v0.0.2",
                "name": "Release v0.0.2",
                "published_at": "2026-09-20T10:00:00Z",
                "body": "Source PR: #7\n",
            },
            {"tag_name": "v0.0.1", "name": "Release v0.0.1", "published_at": "2026-09-19T10:00:00Z", "body": ""},
        ]

    def pull(self, number):
        return self.pulls[number]

    def pull_title(self, number):
        if number not in self.pulls:
            raise subprocess.CalledProcessError(1, "gh")
        return self.pulls[number]["title"]

    def commits(self, number):
        return [
            {"sha": "abcdef1234567", "commit": {"message": "feat(ui): Add theme tokens\n\nLong body."}},
            {"sha": "1234567abcdef", "commit": {"message": "test(ui): Cover the theme switch"}},
        ]

    def files(self, number):
        return [
            {"filename": "src/Web/Theme.cs", "additions": 10, "deletions": 2, "patch": "@@ -1 +1 @@\n-a\n+b"},
            {"filename": "tests/Web.Tests/ThemeTests.cs", "additions": 5, "deletions": 0, "patch": "@@ +1 @@\n+t"},
            {"filename": ".github/workflows/ci.yml", "additions": 1, "deletions": 1, "patch": "@@\n-x\n+y"},
            {"filename": ".sandcastle/main.mts", "additions": 3, "deletions": 3, "patch": "@@\n-m\n+n"},
            {"filename": "docs/adr/0001.md", "additions": 4, "deletions": 0, "patch": "@@\n+adr"},
            {"filename": "package-lock.json", "additions": 900, "deletions": 800, "patch": "@@\n+lock"},
            {"filename": "Directory.Packages.props", "additions": 1, "deletions": 0, "patch": "@@\n+pkg"},
        ]

    def releases(self):
        return self.releases_data


def make_repo(tmp_path):
    (tmp_path / "docs" / "blogs").mkdir(parents=True)
    readme = "# Demo\n\n## About\n\nText.\n\n## Releases\n\n<!-- RELEASES_START -->\nold\n<!-- RELEASES_END -->\n\n## License\n"
    (tmp_path / "README.md").write_text(readme, encoding="utf-8")
    # A repo that publishes its README as the Pages landing page.
    (tmp_path / "docs" / "README.md").write_text(readme, encoding="utf-8")
    (tmp_path / "docs" / "index.html").write_text(
        "<html>\n  <body>\n"
        "    <!-- RELEASES_HTML_START -->\n    old\n    <!-- RELEASES_HTML_END -->\n"
        "    <!-- BLOGS_HTML_START -->\n    <!-- BLOGS_HTML_END -->\n"
        "  </body>\n</html>\n",
        encoding="utf-8",
    )
    return tmp_path


def run(tmp_path, gh=None, **kwargs):
    return rp.run(REPO, 42, "v0.0.3", gh or FakeGitHub(), root=tmp_path, **kwargs)


def read_all(root):
    return {
        str(p.relative_to(root)): p.read_text(encoding="utf-8")
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


# Deterministic sections


def test_slugify_matches_the_workflow_slug():
    assert rp.slugify("feat(sandcastle): Hold back issues whose blockers haven't landed") == (
        "feat-sandcastle-hold-back-issues-whose-blockers-haven-t-landed"
    )
    assert rp.slugify("!!!") == "pr-update"


def test_post_title_is_a_valid_yaml_double_quoted_scalar():
    post = rp.render_post({"number": 7}, 'Fix "quotes" and a trailing \\', "v1.2.3", "2026-09-26", [], [], None, "m")
    assert 'post_title: "Fix \\"quotes\\" and a trailing \\\\"\n' in post


def heading_levels(post):
    """Levels of every line in a rendered post that looks like an ATX heading.

    This deliberately over-counts rather than re-implementing the parser under
    test: it strips all quote and list markers and leading indentation from
    every line, and skips only fences and HTML comments that open at column 0,
    which are unambiguously top-level (an indented opener may belong to a list
    item and end with it). So it can never miss a heading (the invariant tests
    need exactly that), but a "#" line in indented code or in a fence inside a
    container counts too, so the invariant tests don't use those.
    nest_headings' exact behaviour inside containers is pinned by its own tests.
    """
    body = post.split("---\n", 2)[2]
    fence = None
    comment = False
    levels = []
    for line in body.splitlines():
        if comment:
            comment = "-->" not in line
            continue
        marker = re.match(r" {0,3}(`{3,}|~{3,})(.*)", line)
        if fence is not None:
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence) and not marker.group(2).strip():
                fence = None
            continue
        if marker and marker.start(1) == 0:
            fence = marker.group(1)
            continue
        if line.startswith("<!--"):
            comment = "-->" not in line[4:]
            continue
        text = re.sub(r"^(?:\s*(?:>|[-+*](?=\s)|\d+[.)](?=\s)))*\s*", "", line)
        if re.match(r"#{1,6}(\s|$)", text):
            levels.append(len(text) - len(text.lstrip("#")))
    return levels


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("> # A\n- # B\n1. # C\n> - > ## D", [1, 1, 1, 1, 2]),
        ("- # A\n  #### B\n    ### C", [1, 1, 4, 3]),  # continuation lines, at any depth
        ("- > ```\n  > # counted\n  > ```", [1, 1]),  # container fences over-count; never miss
        ("```\n# not a heading\n```\n<!--\n# nor this\n-->\n## Real", [1, 2]),
        # An indented opener may belong to a list item and end with it, so it isn't tracked.
        ("- item\n  ```\n# Root", [1, 1]),
        ("- item\n  <!--\n# Root", [1, 1]),
    ],
)
def test_heading_levels_counts_every_heading_looking_line(body, expected):
    assert heading_levels(f"---\nx: 1\n---\n# T\n{body}") == expected


def assert_one_h1_and_no_skipped_levels(post):
    levels = heading_levels(post)
    assert levels[0] == 1
    assert levels.count(1) == 1
    assert all(b - a <= 1 for a, b in zip(levels, levels[1:]))


def test_post_starts_with_one_h1_and_never_skips_a_level():
    commits = [{"sha": "abc1234def", "commit": {"message": "Add a thing"}}]
    files = [{"filename": "src/A.cs", "additions": 1, "deletions": 0}]
    post = rp.render_post({"number": 7, "body": "Why"}, "Add a thing", "v1.2.3", "2026-09-26", commits, files, "Short.", "m")
    assert_one_h1_and_no_skipped_levels(post)


@pytest.mark.parametrize(
    "description",
    [
        "# Context\n\nWhy.\n\n## Details\n\nHow.",
        "#### Details\n\nHow.",
        "### Deep first\n\n# Then shallow\n\n###### Then very deep",
        "## Plan\n\n```bash\n# a shell comment, not a heading\n```\n\n### Steps",
        "```\n```bash\n# a fence line with an info string doesn't close the fence\n```\n\n# After",
        "> # Context\n\n- # Context\n\n1. # Context",
        "<!--\n```\n-->\n# Context",
        "- # A\n  #### B",
    ],
)
def test_headings_in_the_description_and_summary_stay_nested(description):
    summary = "# The gist\n\nShort.\n\n### Detail"
    post = rp.render_post({"number": 7, "body": description}, "T", "v1.2.3", "2026-09-26", [], [], summary, "m")
    assert_one_h1_and_no_skipped_levels(post)


def test_nest_headings_keeps_relative_levels_and_fenced_code():
    text = "# A\n\n```\n# not a heading\n```\n\n### B\n\n~~~\n## still code\n~~~\n\n## C\n#hashtag"
    assert rp.nest_headings(text) == (
        "### A\n\n```\n# not a heading\n```\n\n#### B\n\n~~~\n## still code\n~~~\n\n#### C\n#hashtag"
    )


def test_nest_headings_converts_setext_headings_but_keeps_thematic_breaks():
    text = "Title\n===\n\nText.\n\n---\n\n- item\n---\n\nSub\n---"
    assert rp.nest_headings(text) == "### Title\n\nText.\n\n---\n\n- item\n---\n\n#### Sub"


def test_a_closing_fence_followed_by_a_thematic_break_stays_a_fence():
    text = "```\ncode\n```\n---\n# After"
    assert rp.nest_headings(text) == "```\ncode\n```\n---\n### After"


def test_adjacent_thematic_breaks_are_not_setext_text():
    text = "Text.\n\n---\n---\n\n# After"
    assert rp.nest_headings(text) == "Text.\n\n---\n---\n\n### After"


def test_a_setext_heading_takes_its_whole_paragraph():
    text = "Release\nNotes\n===\n\nBody.\n\nSub\nheading\n---\n\n- item\nlazy continuation\n---"
    assert rp.nest_headings(text) == (
        "### Release Notes\n\nBody.\n\n#### Sub heading\n\n- item\nlazy continuation\n---"
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Table-like and #hashtag lines are paragraph text, so the underline takes them too.
        ("text\n| a | b |\n===", "### text | a | b |"),
        ("#hashtag\nPara\n---", "### #hashtag Para"),
        # A lone === line is text, and becomes part of the heading below it.
        ("===\nTitle\n---", "### === Title"),
        # Text continuing a list item or quote can't be underlined into a heading.
        ("1. one\n===\ntext\n---", "1. one\n===\ntext\n---"),
        ("> quote\n===\n===", "> quote\n===\n==="),
        ("- item\n\n    indented\nPara\n---", "- item\n\n    indented\nPara\n---"),
        # A quote closes at a blank line; a list closes at a thematic break.
        ("> quote\n\nPara\n---", "> quote\n\n### Para"),
        ("- item\ntext\n---\nPara\n---", "- item\ntext\n---\n### Para"),
    ],
)
def test_setext_headings_follow_commonmark_paragraphs(text, expected):
    assert rp.nest_headings(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("> # Context\n> Why.", "> ### Context\n> Why."),
        ("- # Context\n  Why.", "- ### Context\n  Why."),
        ("> - # Deep\n>   ## Deeper", "> - ### Deep\n>   #### Deeper"),
        # Setext headings inside a quote or list item, and a lazy === that isn't one.
        ("> Title\n> ===", "> ### Title"),
        ("- Title\n  ===", "- ### Title"),
        ("> Title\n===", "> Title\n==="),
        # Fence markers inside an HTML comment are comment text, not code.
        ("<!--\n```\n-->\n# Context", "<!--\n```\n-->\n### Context"),
        ("<!-- # not a heading -->\n# Context", "<!-- # not a heading -->\n### Context"),
        # An HTML comment inside a list item is opaque too, fence markers and all.
        ("- <!--\n  ```\n  -->\n# Context", "- <!--\n  ```\n  -->\n### Context"),
        # Tabs expand to 4-column stops, so a tab-indented line continues the list item.
        ("-\t# First\n\t# Second", "-   ### First\n    ### Second"),
        # A line that fails to continue a quote or list item may open any list item
        # (GitHub's renderer and CommonMark's reference parser agree); inside the
        # item, only "1." interrupts.
        ("> paragraph\n2. # Context", "> paragraph\n2. ### Context"),
        ("- a\n2. # b", "- a\n2. ### b"),
        ("- a\n  2. # b", "- a\n  2. # b"),
        ("-\n  # A", "-\n  ### A"),
    ],
)
def test_nest_headings_reaches_into_containers_and_skips_html_comments(text, expected):
    assert rp.nest_headings(text) == expected


@pytest.mark.parametrize("comment", ["<!--\n```\n-->", "- <!--\n  ```\n  -->"])
def test_a_fence_in_an_html_comment_does_not_swallow_the_rest_of_the_post(comment):
    body = f"{comment}\n\nThe real description."
    commits = [{"sha": "abc1234def", "commit": {"message": "Add a thing"}}]
    post = rp.render_post({"number": 7, "body": body}, "T", "v1.2.3", "2026-09-26", commits, [], None, "m")
    assert rp.post_excerpt(post) == "The real description."
    assert "Add a thing" not in rp.section(post, "PR description")


def test_deeply_nested_containers_do_not_exhaust_the_stack():
    # A size-bounded PR body can nest far deeper than Python's recursion limit.
    assert rp.nest_headings("> " * 1100 + "# Context").endswith("> ### Context")
    assert rp.nest_headings("- " * 1100 + "# Context").endswith("- ### Context")


@pytest.mark.parametrize(
    "shape",
    [
        lambda n: "- " * n + "# Context",
        lambda n: "> " * n + "# Context",
        lambda n: "- " * n + "x" + "\n" * n + "  text",
        lambda n: "> x\n" + "lazy\n" * n,
    ],
)
def test_scanning_stays_linear_in_nesting_depth_and_length(shape):
    # Time the same shape at two sizes; a quadratic scan takes ~16x longer at 4x
    # the size (measured before the fix), a linear one ~4x. The best of three
    # runs keeps scheduling noise out, and the 10x bound leaves plenty of slack.
    def best(n):
        text = shape(n)
        runs = []
        for _ in range(3):
            start = time.perf_counter()
            rp.nest_headings(text)
            runs.append(time.perf_counter() - start)
        return min(runs)

    small, large = best(2_000), best(8_000)
    assert large < max(small, 0.001) * 10


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # A "#" line inside a raw HTML block is text: GitHub renders it literally.
        ("<details>\n# x\n</details>", "<details>\n# x\n</details>"),
        ("<div>\n## y\n</div>\n\n# z", "<div>\n## y\n</div>\n\n### z"),
        ("<pre>\n# code\n</pre>\n# after", "<pre>\n# code\n</pre>\n### after"),
        ("- <div>\n  # x\n# root", "- <div>\n  # x\n### root"),
        # Block-tag blocks end at a blank line, so Markdown after one is Markdown again.
        (
            "<details>\n<summary>S</summary>\n\n# x\n\n</details>",
            "<details>\n<summary>S</summary>\n\n### x\n\n</details>",
        ),
        ("<span>\n# inside\n\n# after", "<span>\n# inside\n\n### after"),
        # A block tag interrupts a paragraph; any other tag doesn't...
        ("text\n<details>\n# w\n</details>", "text\n<details>\n# w\n</details>"),
        ("text\n<span>\n# v", "text\n<span>\n### v"),
        # ...unless the line fails to continue its quote, when any HTML block can open.
        ("> quote\n<span>\n# after", "> quote\n<span>\n# after"),
        # A comment can close on the line that opens it.
        ("<!-->\n# after", "<!-->\n### after"),
        # Processing instructions, declarations and CDATA stay opaque until their own marker.
        ("<?php\n# x\n?>\n# after", "<?php\n# x\n?>\n### after"),
        ("<!DOCTYPE html\n# x\n>\n# after", "<!DOCTYPE html\n# x\n>\n### after"),
        ("<![CDATA[\n# x\n]]>\n# after", "<![CDATA[\n# x\n]]>\n### after"),
        # A declaration needs an uppercase letter: GitHub reads "<!doctype" as text.
        ("<!doctype html\n# x", "<!doctype html\n### x"),
        # The tag grammar is ASCII: a non-breaking space or a long s ("\u017f", which
        # Unicode case-folds to "s") makes the line text, so GitHub reads the "#" after it
        # as a heading. ASCII case-insensitivity still applies.
        ("<div\u00a0>\n# x", "<div\u00a0>\n### x"),
        ("<\u017ftyle>\n# x", "<\u017ftyle>\n### x"),
        ('<a\u00a0href="x">\n# y', '<a\u00a0href="x">\n### y'),
        ("<DIV>\n# x", "<DIV>\n# x"),
        # Only spaces and tabs make a blank line: a non-breaking space doesn't end the block.
        ("<div>\n\u00a0\n# x", "<div>\n\u00a0\n# x"),
        ("<div>\n \t\n# x", "<div>\n \t\n### x"),
    ],
)
def test_nest_headings_leaves_raw_html_blocks_alone(text, expected):
    assert rp.nest_headings(text) == expected


def test_an_html_block_never_becomes_the_excerpt():
    body = "<details>\n<summary>Notes</summary>\n\nThe real description.\n\n</details>"
    post = rp.render_post({"number": 7, "body": body}, "T", "v1.2.3", "2026-09-26", [], [], None, "m")
    assert rp.post_excerpt(post) == "The real description."


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # PR bodies from the GitHub API often use CRLF; GitHub reads these as two H1s.
        ("Title\r\n===\r\n\r\n# x", "### Title\n\n### x"),
        ("- item\r\n  ---\r\n", "- ### item\n"),
        ("<div>\r\n\r\n# x", "<div>\n\n### x"),
        ("Title\r===", "### Title"),  # a lone CR is a line ending too
        # A non-breaking space is text: this line continues the paragraph instead of ending it.
        ("para\n\u00a0\n# y", "para\n\u00a0\n### y"),
        # List numbers are ASCII digits: GitHub reads these lines as paragraph text.
        ("\u0661. # x", "\u0661. # x"),
        ("\uff11. # x", "\uff11. # x"),
    ],
)
def test_nest_headings_reads_line_endings_and_blank_lines_as_commonmark_does(text, expected):
    assert rp.nest_headings(text) == expected


def test_code_lines_treats_a_trailing_cr_as_part_of_the_line_ending():
    assert rp.code_lines(["<div>\r", "\r", "# x"]) == {0}


def test_a_fence_line_with_an_info_string_does_not_close_the_fence():
    text = "```\n```python\n# comment\n```\n# Heading"
    assert rp.nest_headings(text) == "```\n```python\n# comment\n```\n### Heading"


def test_section_ignores_a_summary_heading_from_inside_the_pr_description():
    new_post = rp.render_post(
        {"number": 7, "body": "## Summary\n\nFrom the PR body."}, "T", "v1.2.3", "2026-09-26", [], [], None, "m"
    )
    old_post = "## T\n\n### PR description\n\n## Summary\n\nFrom the PR body.\n\n### Commits\n"
    assert rp.section(new_post, "Summary") == ""
    assert rp.section(old_post, "Summary") == ""


@pytest.mark.parametrize(("title", "level"), [("#", "##"), ("##", "###")])
def test_excerpt_skips_a_summary_heading_inside_a_fenced_example(title, level):
    fenced = f"```markdown\n{level} Summary\n\nCode sample, not a summary.\n```"
    post = (
        f"---\npost_title: \"T\"\n---\n{title} T\n\n{level} PR description\n\n"
        f"The real description.\n\n{fenced}\n\n{level} Commits\n\n- Add a thing\n"
    )
    assert rp.section(post, "Summary") == ""
    assert rp.post_excerpt(post) == "The real description."


def test_nested_description_headings_do_not_end_the_section():
    post = rp.render_post({"number": 7, "body": "# Context\n\nWhy."}, "T", "v1.2.3", "2026-09-26", [], [], None, "m")
    assert rp.first_paragraph(rp.section(post, "PR description")) == "Why."


@pytest.mark.parametrize(("title", "level"), [("#", "##"), ("##", "###")])
def test_section_reads_posts_from_before_and_after_the_h1_title(title, level):
    # Posts written before the title became an H1 used a ## title and ### section headings.
    text = f"{title} T\n\n{level} Summary\n\nThe gist.\n\n{level} PR description\n\nWhy.\n"
    assert rp.first_paragraph(rp.section(text, "Summary")) == "The gist."
    assert rp.first_paragraph(rp.section(text, "PR description")) == "Why."


def test_commits_section_lists_subjects_only():
    section = rp.render_commits(FakeGitHub().commits(42))
    assert section == (
        "## Commits\n\n"
        "- feat(ui): Add theme tokens (`abcdef1`)\n"
        "- test(ui): Cover the theme switch (`1234567`)\n"
    )


def test_commits_section_without_commits():
    assert "No commits were found." in rp.render_commits([])


def test_files_section_groups_by_area_in_fixed_order():
    section = rp.render_files(FakeGitHub().files(42))
    assert section == (
        "## Files changed\n\n"
        "### src/\n\n"
        "- `src/Web/Theme.cs` (+10 / -2)\n\n"
        "### tests/\n\n"
        "- `tests/Web.Tests/ThemeTests.cs` (+5 / -0)\n\n"
        "### .github/\n\n"
        "- `.github/workflows/ci.yml` (+1 / -1)\n\n"
        "### .sandcastle/\n\n"
        "- `.sandcastle/main.mts` (+3 / -3)\n\n"
        "### docs/\n\n"
        "- `docs/adr/0001.md` (+4 / -0)\n\n"
        "### other\n\n"
        "- `Directory.Packages.props` (+1 / -0)\n"
        "- `package-lock.json` (+900 / -800)\n"
    )


@pytest.mark.parametrize(
    "path, excluded",
    [
        ("package-lock.json", True),
        ("web/package-lock.json", True),
        ("pnpm-lock.yaml", True),
        ("src/AtelierStore.Web/pnpm-lock.yaml", True),
        ("poetry.lock", True),
        ("docs/blogs/2026-09-24-pr-1-x.md", True),
        ("README.md", True),
        ("docs/README.md", True),
        ("src/README.md", False),
        ("docs/adr/0001.md", False),
        ("src/Web/Theme.cs", False),
    ],
)
def test_diff_exclusions(path, excluded):
    assert rp.is_excluded_from_diff(path) is excluded


def test_build_diff_skips_excluded_files():
    diff = rp.build_diff(FakeGitHub().files(42))
    assert "diff --git a/src/Web/Theme.cs b/src/Web/Theme.cs" in diff
    assert "package-lock.json" not in diff


def test_build_diff_truncates_with_a_note():
    files = [{"filename": "src/big.cs", "additions": 1, "deletions": 0, "patch": "+" + "x" * 200}]
    diff = rp.build_diff(files, limit=100)
    assert diff.startswith("diff --git a/src/big.cs b/src/big.cs")
    assert "[Diff truncated" in diff
    assert len(diff) < 200


# Marker rewriting


def test_replace_between_keeps_markers_and_indent():
    text = "a\n  <!-- X_START -->\n  old\n  <!-- X_END -->\nb\n"
    out = rp.replace_between(text, "X", ["<p>1</p>", "<p>2</p>"])
    assert out == "a\n  <!-- X_START -->\n  <p>1</p>\n  <p>2</p>\n  <!-- X_END -->\nb\n"
    assert rp.replace_between(out, "X", ["<p>1</p>", "<p>2</p>"]) == out


def test_replace_between_without_markers_returns_none():
    assert rp.replace_between("no markers", "X", ["y"]) is None


def test_run_leaves_a_missing_docs_readme_missing(tmp_path):
    make_repo(tmp_path)
    (tmp_path / "docs" / "README.md").unlink()
    run(tmp_path)

    assert "v0.0.3" in (tmp_path / "README.md").read_text(encoding="utf-8")
    assert not (tmp_path / "docs" / "README.md").exists()


def test_run_writes_readme_and_index_tables(tmp_path):
    make_repo(tmp_path)
    run(tmp_path)

    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    post = "2026-09-24-pr-42-feat-ui-add-the-dark-theme.md"
    assert f'| [v0.0.3](https://github.com/{REPO}/releases/tag/v0.0.3) | 2026-09-24 | feat(ui): Add the "dark" theme | [Post](https://github.com/{REPO}/blob/main/docs/blogs/{post}) |' in readme
    assert f"| [v0.0.2](https://github.com/{REPO}/releases/tag/v0.0.2) | 2026-09-20 | fix: Older change | — |" in readme
    assert "| [v0.0.1](https://github.com/octo/demo/releases/tag/v0.0.1) | 2026-09-19 | Release v0.0.1 | — |" in readme
    assert readme.endswith("## License\n")
    assert (tmp_path / "docs" / "README.md").read_text(encoding="utf-8") == readme

    index = (tmp_path / "docs" / "index.html").read_text(encoding="utf-8")
    assert "old" not in index
    assert f'<td><a href="https://github.com/{REPO}/releases/tag/v0.0.3">v0.0.3</a></td>' in index
    assert "<td>feat(ui): Add the &quot;dark&quot; theme</td>" in index
    assert f'<td><a href="https://github.com/{REPO}/blob/main/docs/blogs/{post}">Post</a></td>' in index
    assert "<td>—</td>" in index
    # Blog post cards: date, release, linked title, excerpt, source PR
    assert '<time datetime="2026-09-24">24 Sep 2026</time><span class="post-tag">v0.0.3</span>' in index
    assert f'<h3 class="post-title"><a href="https://github.com/{REPO}/blob/main/docs/blogs/{post}">feat(ui): Add the &quot;dark&quot; theme</a></h3>' in index
    assert '<p class="post-excerpt">Adds a theme.</p>' in index
    assert f'<p class="post-source"><a href="https://github.com/{REPO}/pull/42">PR #42</a></p>' in index


# docs/README.md links (from TicketManager #104)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # A docs/ prefix is dropped; the docs folder itself becomes ./
        ("| [Post](docs/blogs/2026-09-28-pr-1-x.md) |\n", "| [Post](blogs/2026-09-28-pr-1-x.md) |\n"),
        ("[docs](docs/) and [docs](docs)\n", "[docs](./) and [docs](./)\n"),
        # Anything else relative goes up one level.
        ("[License](LICENSE) and [web](./src/Web)\n", "[License](../LICENSE) and [web](../src/Web)\n"),
        ("[props](Directory.Packages.props)\n", "[props](../Directory.Packages.props)\n"),
        # Images, titles and angle-bracketed targets keep their form.
        ('![logo](docs/logo.png "Logo")\n', '![logo](logo.png "Logo")\n'),
        ("[x](<docs/a b.md>)\n", "[x](<a b.md>)\n"),
        # Reference definitions and HTML src/href attributes.
        ("[post]: docs/blogs/README.md\n", "[post]: blogs/README.md\n"),
        ('<img src="docs/banner.png" alt="">\n', '<img src="banner.png" alt="">\n'),
        ("<a href='CONTRIBUTING.md'>c</a>\n", "<a href='../CONTRIBUTING.md'>c</a>\n"),
        # Balanced parentheses belong to the destination; every title form is kept.
        ("[x](docs/a_(b).md) [y](a_(b)_(c).md)\n", "[x](a_(b).md) [y](../a_(b)_(c).md)\n"),
        ("[a](docs/a.md 'A') [b](b.md (B)) [c](docs/c.md \"C\")\n", "[a](a.md 'A') [b](../b.md (B)) [c](c.md \"C\")\n"),
        # Attribute names in any case, spaced "=", unquoted values.
        ("<img SRC=docs/banner.png>\n", "<img SRC=banner.png>\n"),
        ('<a href = "docs/x.md">x</a>\n', '<a href = "x.md">x</a>\n'),
        ('<img\nsrc="docs/a.png" data-src="docs/b.png">\n', '<img\nsrc="a.png" data-src="docs/b.png">\n'),
        # ../ is relative too, so it goes up one more level.
        ("[up](../up.md)\n", "[up](../../up.md)\n"),
    ],
)
def test_rebase_readme_links(text, expected):
    assert rp.rebase_readme_links(text) == expected


def test_rebase_readme_links_keeps_absolute_anchor_query_and_root_relative_links():
    text = "[a](https://example.com/docs/x.md) [b](#usage) [c](/docs/x) [d](mailto:me@example.com) [e](?tab=all)\n"
    assert rp.rebase_readme_links(text) == text


def test_rebase_readme_links_leaves_fenced_code_alone():
    text = "```md\n[x](docs/a.md)\n```\n[y](docs/b.md)\n````\n```\n[z](docs/c.md)\n````\n"
    assert rp.rebase_readme_links(text) == "```md\n[x](docs/a.md)\n```\n[y](b.md)\n````\n```\n[z](docs/c.md)\n````\n"


def test_rebase_readme_links_leaves_fenced_code_in_block_quotes_alone():
    # A fence closes at its own quote depth, or ends with its quote.
    text = (
        "> ```md\n> [a](docs/a.md)\n> ```\n> [b](docs/b.md)\n"
        ">  > ~~~\n> > [c](docs/c.md)\n> > ~~~\n"
        "> ```\n> [d](docs/d.md)\n[e](docs/e.md)\n"
    )
    assert rp.rebase_readme_links(text) == (
        "> ```md\n> [a](docs/a.md)\n> ```\n> [b](b.md)\n"
        ">  > ~~~\n> > [c](docs/c.md)\n> > ~~~\n"
        "> ```\n> [d](docs/d.md)\n[e](e.md)\n"
    )


@pytest.mark.parametrize(
    "text",
    [
        "Write `[x](docs/a.md)` for a link.\n",
        'Use `<a href="docs/a.md">` or ``<img src="docs/b.png">``.\n',
        "``[x](docs/a.md) with ` inside``\n",
        "> - `[x](docs/a.md)`\n",
        # A span may cross a line break inside a paragraph.
        "See `[x](docs/a.md)\nand [y](docs/b.md)` here.\n",
        "Use `<a\nhref=\"docs/a.md\">` there.\n",
        # Indented code, at the top level, after a blank line in a list item, and in a quote.
        "Example:\n\n    [x](docs/a.md)\n    [y]: docs/b.md\n    <img src=\"docs/c.png\">\n",
        "- item\n\n      [x](docs/a.md)\n",
        ">     [x](docs/a.md)\n",
        # A fence in a list item, indented past the item's content column.
        "1. item\n\n   ```\n   [x](docs/a.md)\n   ```\n",
    ],
)
def test_rebase_readme_links_leaves_code_spans_and_indented_code_alone(text):
    assert rp.rebase_readme_links(text) == text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Links around and after code spans are still rebased, and so is one whose text is code.
        ("`docs/a.md` is [here](docs/a.md)\n", "`docs/a.md` is [here](a.md)\n"),
        ("[`a.md`](docs/a.md) and `x` <img src=\"docs/b.png\">\n", "[`a.md`](a.md) and `x` <img src=\"b.png\">\n"),
        # A blank line ends the paragraph, so these backticks pair with nothing across it.
        ("a `[x](docs/a.md)\n\n[y](docs/b.md)` b\n", "a `[x](a.md)\n\n[y](b.md)` b\n"),
        # So does a blank line with a CRLF ending, which keeps its "\r" in the README's lines.
        ("a `[x](docs/a.md)\r\n\r\n[y](docs/b.md)` b\r\n", "a `[x](a.md)\r\n\r\n[y](b.md)` b\r\n"),
        # After a span that crossed lines, the rest of its last line is text again.
        ("`x\ny` [z](docs/a.md)\n", "`x\ny` [z](a.md)\n"),
        # Backtick runs of different lengths don't pair, so this holds no code span.
        ("``[x](docs/a.md)`\n", "``[x](a.md)`\n"),
        # An escaped backtick opens no span.
        ("\\`[x](docs/a.md)`\n", "\\`[x](a.md)`\n"),
        # A reference definition is read before code spans, so code in its label doesn't hide it.
        ("[`a`]: docs/a.md\n", "[`a`]: a.md\n"),
        # Four spaces continuing a paragraph are text, not indented code.
        ("Text\n    [x](docs/a.md)\n", "Text\n    [x](a.md)\n"),
        # Backticks in a raw HTML block are text, not code spans.
        ('<div>\n`<img src="docs/a.png">`\n</div>\n', '<div>\n`<img src="a.png">`\n</div>\n'),
    ],
)
def test_rebase_readme_links_still_rebases_text_beside_code(text, expected):
    assert rp.rebase_readme_links(text) == expected


def test_run_rebases_links_in_docs_readme_only(tmp_path):
    make_repo(tmp_path)
    links = "[Architecture](docs/ARCHITECTURE.md), [props](Directory.Packages.props) and [docs](docs).\n"
    readme_path = tmp_path / "README.md"
    readme_path.write_text(readme_path.read_text(encoding="utf-8") + "\n" + links, encoding="utf-8")
    run(tmp_path)

    readme = readme_path.read_text(encoding="utf-8")
    assert links in readme
    docs_readme = (tmp_path / "docs" / "README.md").read_text(encoding="utf-8")
    assert "[Architecture](ARCHITECTURE.md), [props](../Directory.Packages.props) and [docs](./).\n" in docs_readme
    assert docs_readme == rp.rebase_readme_links(readme)


def test_blog_post_cards_are_newest_first_and_capped_at_ten(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    for n in range(1, 13):
        (blog_dir / f"2026-09-{n:02d}-pr-{n}-post-{n}.md").write_text(
            "---\n"
            f'post_title: "Post <{n}>"\n'
            "tags:\n"
            f"  - release:v0.0.{n}\n"
            "  - automation\n"
            f'post_date: "2026-09-{n:02d}"\n'
            "---\nbody\n",
            encoding="utf-8",
        )
    posts = rp.read_blog_posts(blog_dir)
    lines = rp.render_blogs_html(posts, REPO)
    cards = [line for line in lines if line.strip() == '<li class="post-card">']
    assert len(cards) == 10
    html_text = "\n".join(lines)
    assert "Post &lt;12&gt;" in html_text
    assert "Post &lt;2&gt;" not in html_text
    assert html_text.index("2026-09-12") < html_text.index("2026-09-11")


def test_same_day_posts_are_ordered_by_release_version():
    posts = [
        {"date": "2026-09-24", "tag": "v0.0.9", "pr": "4", "title": "a", "file": "a.md"},
        {"date": "2026-09-24", "tag": "v0.0.32", "pr": "28", "title": "b", "file": "b.md"},
    ]
    assert [p["tag"] for p in rp.newest_first(posts)] == ["v0.0.32", "v0.0.9"]


def test_readme_without_markers_gets_releases_section_after_about(tmp_path):
    make_repo(tmp_path)
    (tmp_path / "README.md").write_text("# Demo\n\n## About\n\nText.\n\n## License\n", encoding="utf-8")
    run(tmp_path)
    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert readme.index("## About") < readme.index("## Releases") < readme.index("## License")
    assert f"[All releases →](https://github.com/{REPO}/releases)" in readme


def test_readme_legacy_dev_blog_block_is_removed(tmp_path):
    make_repo(tmp_path)
    (tmp_path / "README.md").write_text(
        "# Demo\n\n## Dev Blog\n\n<!-- BLOG_START -->\nx\n<!-- BLOG_END -->\n\n## About\n\nText.\n",
        encoding="utf-8",
    )
    run(tmp_path)
    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "Dev Blog" not in readme
    assert "BLOG_START" not in readme


def test_index_html_without_markers_is_left_alone(tmp_path):
    make_repo(tmp_path)
    (tmp_path / "docs" / "index.html").write_text("<html></html>\n", encoding="utf-8")
    run(tmp_path)
    assert (tmp_path / "docs" / "index.html").read_text(encoding="utf-8") == "<html></html>\n"


def test_running_twice_leaves_every_file_unchanged(tmp_path):
    make_repo(tmp_path)
    run(tmp_path)
    first = read_all(tmp_path)
    run(tmp_path)
    assert read_all(tmp_path) == first


def test_blog_index_lists_the_post_once(tmp_path):
    make_repo(tmp_path)
    run(tmp_path)
    run(tmp_path)
    index = (tmp_path / "docs" / "blogs" / "README.md").read_text(encoding="utf-8")
    assert index.count("pr-42-") == 1
    assert "| 2026-09-24 | [feat(ui): Add the \"dark\" theme](2026-09-24-pr-42-feat-ui-add-the-dark-theme.md) | release,automation |" in index


def test_blog_index_keeps_posts_whose_title_mentions_date(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    older = "| 2026-09-20 | [fix(ui): Date parsing fix](2026-09-20-pr-7-fix-ui-date-parsing-fix.md) | release,automation |"
    for name in ["2026-09-20-pr-7-fix-ui-date-parsing-fix.md", "2026-09-24-pr-8-feat-ui-next.md"]:
        (blog_dir / name).write_text("post\n", encoding="utf-8")
    rp.update_blog_index(blog_dir, "2026-09-20", "fix(ui): Date parsing fix", "2026-09-20-pr-7-fix-ui-date-parsing-fix.md")
    rp.update_blog_index(blog_dir, "2026-09-24", "feat(ui): Next", "2026-09-24-pr-8-feat-ui-next.md")
    index = (blog_dir / "README.md").read_text(encoding="utf-8")
    assert older in index
    assert index.count("| Date | Title | Tags |") == 1


def test_table_separators_use_the_compact_style(tmp_path):
    # markdownlint MD060 ("compact") needs a space on both sides of every pipe.
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    rp.update_blog_index(blog_dir, "2026-09-24", "feat(ui): Next", "2026-09-24-pr-8-feat-ui-next.md")
    index = (blog_dir / "README.md").read_text(encoding="utf-8")
    assert "| ---- | ----- | ---- |" in index.splitlines()
    assert "| ------- | ---- | ----- | --------- |" in rp.render_releases_markdown([]).splitlines()


def test_blog_index_replaces_an_old_style_separator(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    (blog_dir / "README.md").write_text("| Date | Title | Tags |\n|------|-------|------|\n", encoding="utf-8")
    rp.update_blog_index(blog_dir, "2026-09-24", "feat(ui): Next", "2026-09-24-pr-8-feat-ui-next.md")
    index = (blog_dir / "README.md").read_text(encoding="utf-8")
    assert "|------|-------|------|" not in index
    assert index.count("| ---- | ----- | ---- |") == 1


# Blog post cards and excerpts


def card_post(summary="Release notes seed for v0.0.3 from PR #42.", body=""):
    return f'---\npost_title: "T"\nsummary: "{summary}"\npost_date: "2026-09-24"\n---\n## T\n\n{body}'


def test_excerpt_prefers_the_ai_summary_section():
    text = card_post(body="### Summary\n\nClaude wrote this.\n\n### PR description\n\nThe description.\n")
    assert rp.post_excerpt(text, "Release notes seed for v0.0.3 from PR #42.") == "Claude wrote this."


def test_excerpt_uses_a_real_front_matter_summary_over_the_description():
    text = card_post(body="### PR description\n\nThe description.\n")
    assert rp.post_excerpt(text, "A hand-written summary.") == "A hand-written summary."


def test_excerpt_skips_the_seed_summary_headings_and_issue_references():
    body = (
        "### PR description\n\nFixes #16.\n\n## Problem\n\n"
        "`FindBySlugAsync` lowercases the **slug**, see [the issue](https://x/16).\n\n"
        "### Commits\n\n- abc Commit subject\n"
    )
    assert rp.post_excerpt(card_post(body=body), "Release notes seed for v0.0.3 from PR #42.") == (
        "FindBySlugAsync lowercases the slug, see the issue."
    )


def test_excerpt_joins_a_list_and_keeps_snake_case():
    body = "### PR description\n\n## Summary\n\n- Removes the `pull_request` trigger.\n- Keeps _manual_ runs.\n"
    assert rp.post_excerpt(card_post(body=body)) == "Removes the pull_request trigger. Keeps manual runs."


def test_excerpt_skips_code_blocks_and_tables():
    body = "### PR description\n\n```bash\necho hi\n\necho there\n```\n\n| a | b |\n| - | - |\n\nReal text.\n"
    assert rp.post_excerpt(card_post(body=body)) == "Real text."


def test_excerpt_is_empty_without_a_description():
    assert rp.post_excerpt(card_post(body="### PR description\n\nNo PR description was provided.\n")) == ""
    assert rp.post_excerpt("no front matter or sections") == ""


def test_long_excerpts_are_cut_at_a_word_with_an_ellipsis():
    text = "word " * 100
    short = rp.shorten(text.strip())
    assert len(short) <= rp.EXCERPT_LENGTH
    assert short.endswith("word…")
    assert rp.shorten("Short enough.") == "Short enough."


def test_display_date_formats_iso_dates_and_leaves_others_alone():
    assert rp.display_date("2026-09-07") == "7 Sep 2026"
    assert rp.display_date("someday") == "someday"


def test_blog_cards_escape_titles_and_excerpts():
    posts = [{"file": "a.md", "pr": "5", "title": "<b>T</b>", "date": "2026-09-24", "tag": "", "excerpt": "a < b & c"}]
    html_text = "\n".join(rp.render_blogs_html(posts, REPO))
    assert "&lt;b&gt;T&lt;/b&gt;" in html_text
    assert '<p class="post-excerpt">a &lt; b &amp; c</p>' in html_text
    assert "post-tag" not in html_text


def test_blog_cards_without_posts_show_an_empty_message():
    assert rp.render_blogs_html([], REPO) == ['<p class="post-empty">No blog posts yet.</p>']


def test_real_pages_site_is_unchanged_by_a_second_table_update(tmp_path):
    # The committed docs/index.html must already be what update_tables writes,
    # so a release run only changes it when releases or posts change.
    source = Path(__file__).resolve().parents[3] / "docs" / "index.html"
    if not source.exists():
        pytest.skip("this repo has no docs/index.html Pages site")
    (tmp_path / "docs" / "blogs").mkdir(parents=True)
    (tmp_path / "docs" / "index.html").write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    rp.update_tables(REPO, FakeGitHub(), tmp_path)
    once = (tmp_path / "docs" / "index.html").read_text(encoding="utf-8")
    rp.update_tables(REPO, FakeGitHub(), tmp_path)
    assert (tmp_path / "docs" / "index.html").read_text(encoding="utf-8") == once
    assert "<!-- RELEASES_HTML_START -->" in once and "<!-- BLOGS_HTML_START -->" in once


# Post content and the AI summary


def post_text(tmp_path):
    return (tmp_path / "docs" / "blogs" / "2026-09-24-pr-42-feat-ui-add-the-dark-theme.md").read_text(encoding="utf-8")


def test_no_key_writes_post_without_summary(tmp_path, capsys):
    make_repo(tmp_path)
    run(tmp_path, api_key=None)
    post = post_text(tmp_path)

    assert "## Summary" not in post
    assert 'ai_note: "Generated by release automation from the PR title, description, commits and changed files. No AI summary."' in post
    assert "::notice::" in capsys.readouterr().out
    # Front matter fields the workflow always wrote.
    for line in [
        'post_title: "feat(ui): Add the \\"dark\\" theme"',
        "author1: mpaulosky",
        'post_slug: "v0.0.3-pr-42"',
        "microsoft_alias: n/a",
        "  - release:v0.0.3",
        'summary: "Release notes seed for v0.0.3 from PR #42."',
        'post_date: "2026-09-24"',
    ]:
        assert line in post
    # Nothing renders a featured image, so the post doesn't carry one.
    assert "featured_image" not in post
    assert post.index("## PR description") < post.index("## Commits") < post.index("## Files changed")
    assert "Adds a theme." in post


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_summary_is_included_when_the_api_answers(tmp_path):
    make_repo(tmp_path)
    captured = {}

    def urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        payload = {"content": [{"type": "text", "text": "This release adds a dark theme."}]}
        return FakeResponse(json.dumps(payload).encode("utf-8"))

    run(tmp_path, api_key="sk-test", model="claude-test", urlopen=urlopen)
    post = post_text(tmp_path)

    assert post.index("## Summary\n\nThis release adds a dark theme.\n") < post.index("## PR description")
    assert "Includes an AI summary written by claude-test." in post
    assert 'summary: "Release notes seed for v0.0.3 from PR #42."' in post

    request = captured["request"]
    assert captured["timeout"] == 60
    assert request.full_url == "https://api.anthropic.com/v1/messages"
    assert request.get_header("X-api-key") == "sk-test"
    sent = json.loads(request.data)
    assert sent["model"] == "claude-test"
    prompt = sent["messages"][0]["content"]
    assert "feat(ui): Add theme tokens" in prompt
    assert "diff --git a/src/Web/Theme.cs" in prompt
    assert "+lock" not in prompt


@pytest.mark.parametrize(
    "error",
    [
        urllib.error.HTTPError("https://api.anthropic.com/v1/messages", 529, "Overloaded", {}, None),
        urllib.error.URLError("no route"),
        TimeoutError("timed out"),
        ValueError("bad json"),
    ],
)
def test_api_failure_writes_post_without_summary(tmp_path, capsys, error):
    make_repo(tmp_path)

    def urlopen(request, timeout):
        raise error

    run(tmp_path, api_key="sk-test", urlopen=urlopen)
    post = post_text(tmp_path)

    assert "## Summary" not in post
    assert "No AI summary." in post
    assert "::warning::" in capsys.readouterr().out


def test_empty_api_answer_is_treated_as_no_summary(tmp_path, capsys):
    make_repo(tmp_path)

    def urlopen(request, timeout):
        return FakeResponse(b'{"content": []}')

    run(tmp_path, api_key="sk-test", urlopen=urlopen)
    assert "## Summary" not in post_text(tmp_path)
    assert "::warning::" in capsys.readouterr().out


def test_dependabot_pr_gets_no_summary_even_with_a_key(tmp_path, capsys):
    make_repo(tmp_path)
    gh = FakeGitHub()
    gh.pulls[42]["user"] = {"login": "dependabot[bot]"}

    calls = []

    def urlopen(request, timeout):
        calls.append(request)
        return FakeResponse(b'{"content": [{"type": "text", "text": "Summary."}]}')

    run(tmp_path, gh=gh, api_key="sk-test", urlopen=urlopen)
    post = post_text(tmp_path)
    assert calls == []
    assert "## Summary" not in post
    assert "No AI summary." in post
    assert "::notice::" in capsys.readouterr().out


def test_rewriting_a_post_under_a_new_name_drops_the_old_one(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    stale = "2026-09-23-pr-42-old-title.md"
    (blog_dir / stale).write_text("old\n", encoding="utf-8")
    rp.update_blog_index(blog_dir, "2026-09-23", "Old title", stale)
    (blog_dir / "2026-09-23-pr-420-other.md").write_text("other\n", encoding="utf-8")
    rp.update_blog_index(blog_dir, "2026-09-23", "Other", "2026-09-23-pr-420-other.md")

    run(tmp_path)

    assert not (blog_dir / stale).exists()
    assert (blog_dir / "2026-09-23-pr-420-other.md").exists()
    index = (blog_dir / "README.md").read_text(encoding="utf-8")
    assert stale not in index
    assert "2026-09-23-pr-420-other.md" in index
    assert index.count("pr-42-") == 1


def test_update_tables_without_a_new_release_lists_existing_releases(tmp_path):
    make_repo(tmp_path)
    rp.update_tables(REPO, FakeGitHub(), root=tmp_path)
    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "v0.0.3" not in readme
    assert f"| [v0.0.2](https://github.com/{REPO}/releases/tag/v0.0.2) | 2026-09-20 | fix: Older change | — |" in readme
    assert "v0.0.2" in (tmp_path / "docs" / "index.html").read_text(encoding="utf-8")


# Untrusted Markdown (mpaulosky/dotfiles#48)

HOSTILE = [
    "<script>alert(1)</script>",
    "Text <img src=x onerror=alert(1)> more",
    "<div>\n# x\n</div>",
    # Escaping the HTML block's lines must not bring its fence line to life and expose the later code.
    "<div>\n```\n</div>\n\n```\n<script>alert(1)</script>\n```",
    "```js title\n<script>alert(1)</script>",  # unclosed, and kramdown reads no fence with a two-word info
    "- item\n  ```\n  <script>alert(1)</script>\n  ```",
    "> ```\n> <script>alert(1)</script>",
    "x `y\n`<script>alert(1)</script>`",
    "<!-- a --><script>alert(1)</script>",
]


def outside_code(post):
    """The post's lines, after its front matter, that CommonMark reads as neither fenced nor indented code.

    Raw HTML blocks count as outside: they are what must not get through.
    """
    lines = post.split("---\n", 2)[2].split("\n")
    blocks = []
    rp.scan_blocks(list(lines), [], blocks=blocks)
    code = {index for block in blocks for index in range(block["lines"][0], block["lines"][-1] + 1)}
    return [line for index, line in enumerate(lines) if index not in code]


@pytest.mark.parametrize("body", HOSTILE)
def test_no_raw_html_reaches_the_post_outside_code(body):
    post = rp.render_post({"number": 7, "body": body}, "T", "v1.2.3", "2026-09-26", [], [], body, "m")
    for line in outside_code(post):
        # Only the raw-tag comments, the <code> spans the sanitizer writes, and safe autolinks.
        assert not re.search(r"<(?!code>|/code>|https?://|mailto:|!-- \{% (?:end)?raw %\} -->)", line), line


def test_the_pr_title_is_escaped_in_the_post_and_both_tables(tmp_path):
    title = "feat: Add <b>bold</b> and {{ site.x }}"
    post = rp.render_post({"number": 7}, title, "v1.2.3", "2026-09-26", [], [], None, "m")
    assert "# feat: Add &lt;b>bold&lt;/b> and {{ site.x }}\n" in post  # inside {% raw %}
    assert 'post_title: "feat: Add <b>bold</b> and {{ site.x }}"' in post  # YAML, never rendered as Markdown

    rp.update_blog_index(tmp_path, "2026-09-26", title, "2026-09-26-pr-7-x.md")
    row = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "[feat: Add &lt;b>bold&lt;/b> and &#123;&#123; site.x }}](2026-09-26-pr-7-x.md)" in row

    entry = {"tag": "v1.2.3", "url": "u", "date": "2026-09-26", "title": title, "post_url": ""}
    assert "| feat: Add &lt;b>bold&lt;/b> and &#123;&#123; site.x }} |" in rp.render_releases_markdown([entry])


def test_the_pr_body_is_escaped():
    post = rp.render_post({"number": 7, "body": "Why <img src=x onerror=alert(1)>"}, "T", "v1", "2026-09-26", [], [], None, "m")
    assert "Why &lt;img src=x onerror=alert(1)>" in rp.section(post, "PR description")


def test_the_ai_summary_is_escaped():
    post = rp.render_post({"number": 7}, "T", "v1", "2026-09-26", [], [], "Adds <iframe src=x></iframe>.", "m")
    assert "Adds &lt;iframe src=x>&lt;/iframe>." in rp.section(post, "Summary")


def test_commit_subjects_are_escaped():
    commits = [{"sha": "abc1234def", "commit": {"message": "fix: Drop <script> {: .x}\n\nbody"}}]
    assert "- fix: Drop &lt;script> &#123;: .x} (`abc1234`)" in rp.render_commits(commits)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("src/Web/Theme.cs", "`src/Web/Theme.cs`"),
        ("docs/a b (1).md", "`docs/a b (1).md`"),
        ("src/a`b.cs", "<code>src&#47;a&#96;b&#46;cs</code>"),  # a backtick can't close the span early
        ("src/<x>.cs", "<code>src&#47;&#60;x&#62;&#46;cs</code>"),
        (" a.md ", "<code> a&#46;md </code>"),  # a code span would trim one space from each end
    ],
)
def test_file_names_are_code_that_cannot_break_out(name, expected):
    assert rp.render_files([{"filename": name, "additions": 1, "deletions": 0}]).splitlines()[-1] == f"- {expected} (+1 / -0)"


def test_code_keeps_its_text():
    body = "```cs\nList<T> x = new();\n```\n\nUse `List<T>`, or `plain`.\n\n    indented <b>"
    assert rp.sanitize_markdown(body) == (
        "```cs\nList<T> x = new();\n```\n\n"
        "Use <code>List&#60;T&#62;</code>, or `plain`.\n\n"
        "```text\nindented <b>\n```"
    )


def test_a_code_block_is_rewritten_as_a_fence_both_parsers_agree_on():
    # Unclosed, a two-word info string (kramdown reads no fence there), and backticks inside.
    assert rp.sanitize_markdown("~~~js title\n````\n<b>") == "`````js\n````\n<b>\n`````"


def test_a_code_block_in_a_list_moves_out_of_it():
    body = "1. Run:\n   ```bash\n   cat <file>\n   ```\n2. Next"
    assert rp.sanitize_markdown(body) == "1. Run:\n\n```bash\ncat <file>\n```\n\n2. Next"


def test_a_fence_line_that_was_not_a_fence_is_escaped():
    assert rp.sanitize_markdown("<div>\n```\n</div>") == "&lt;div>\n\\```\n&lt;/div>"


def test_html_comments_are_dropped():
    assert rp.sanitize_markdown("a <!-- hidden --> b\n<!--\nmulti\n-->\nc") == "a  b\n\nc"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("[a](javascript:alert(1))", "[a](#javascript:alert(1))"),
        ("[a](JaVa&#115;cript:x)", "[a](#JaVa&#115;cript:x)"),  # entities decode in a destination
        ("[a](java&#9;script:x)", "[a](#java&#9;script:x)"),  # browsers drop the tab
        # Padding can push the scheme any distance from the start: the whole destination is read.
        ("[a](j" + "&#9;" * 60 + "avascript:x)", "[a](#j" + "&#9;" * 60 + "avascript:x)"),
        ("[a](java&#" + "0" * 250 + "9;script:x)", "[a](#java&#" + "0" * 250 + "9;script:x)"),
        ("![a](data:text/html,x)", "![a](#data:text/html,x)"),
        ("[a](<vbscript:x>)", "[a](&lt;#vbscript:x>)"),
        ("[a]: javascript:x", "[a]: #javascript:x"),
        ("> [a]:\n> javascript:x", "> [a]:\n> #javascript:x"),
        ("[a](https://example.com) [b](mailto:a@b.c) [c](#top) [d](docs/x.md)",
         "[a](https://example.com) [b](mailto:a@b.c) [c](#top) [d](docs/x.md)"),
        ("[^1]: Note: a footnote", "[^1]: Note: a footnote"),
        ("> [^note]: javascript: is how it starts", "> [^note]: javascript: is how it starts"),
        # Only a footnote definition alone at the start of its line is exempt; an escaped "\\[^" is a reference label.
        ("[open][label \\[^x]\n[label \\[^x]: javascript:x", "[open][label \\[^x]\n[label \\[^x]: #javascript:x"),
        ("[a [^x]: javascript:x", "[a [^x]: #javascript:x"),
        ("x [^1]: javascript:x", "x [^1]: #javascript:x"),
        # kramdown's footnote IDs are \w[\w-]*; any other "[^...]:" is a reference definition.
        ("[^!]: javascript:x", "[^!]: #javascript:x"),
        ("[^a:b]: javascript:x", "[^a:b]: #javascript:x"),
        ("[^-x]: javascript:x", "[^-x]: #javascript:x"),
        ("[^é]: javascript:x", "[^é]: #javascript:x"),
        ("[^note-2_b]: javascript: is how it starts", "[^note-2_b]: javascript: is how it starts"),
    ],
)
def test_link_destinations_with_unsafe_schemes_are_neutralized(text, expected):
    assert rp.sanitize_markdown(text) == expected


def test_autolinks_keep_working():
    assert rp.sanitize_markdown("See <https://example.com/a?b=1> or <mailto:a@b.c>, not <a@b.c>.") == (
        "See <https://example.com/a?b=1> or <mailto:a@b.c>, not &lt;a@b.c>."
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('para\n{: onclick="alert(1)"}', 'para\n&#123;: onclick="alert(1)"}'),
        ("*a*{: .x}", "*a*&#123;: .x}"),
        ("{::nomarkdown}x{:/}", "&#123;::nomarkdown}x&#123;:/}"),
        ("\\{: .x}", "\\&#123;: .x}"),
        ("`{:x}`", "<code>&#123;&#58;x&#125;</code>"),
    ],
)
def test_kramdown_attribute_lists_and_extensions_are_neutralized(text, expected):
    assert rp.sanitize_markdown(text) == expected


def test_the_post_is_liquid_raw_and_its_text_cannot_end_the_raw_block():
    body = "Jinja: {{ x }} {% if y %}\n\n```\n{% endraw %}{%- endraw -%}\n```"
    post = rp.render_post({"number": 7, "body": body}, "T", "v1", "2026-09-26", [], [], None, "m")
    after_front_matter = post.split("---\n", 2)[2]
    assert after_front_matter.startswith("<!-- {% raw %} -->\n# T\n")
    assert post.endswith("\n<!-- {% endraw %} -->\n")
    assert post.count("{% endraw %}") == 3  # the closing tag and one per broken {%
    assert "{% endraw %}{{ '{%' }}{% raw %} endraw %}" in post
    assert "{% endraw %}{{ '{%' }}{% raw %}- endraw -%}" in post


def test_excerpts_read_escaped_text_as_the_text_it_stands_for():
    post = rp.render_post({"number": 7, "body": "Returns `List<T>` for <id> & {: x}."}, "T", "v1", "2026-09-26", [], [], None, "m")
    assert rp.post_excerpt(post) == "Returns List<T> for <id> & {: x}."


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("&#9; &#x9; &#0009; &#x0000a;", "\t \t \t \n"),
        ("&#" + "0" * 5000 + "9;", "\t"),  # leading zeros past Python's 4300-digit limit
        ("&#x" + "0" * 5000 + "41;", "A"),
        ("&#" + "9" * 5000 + ";", "\ufffd"),  # no character has a number that long
        ("&#; &#x; a &amp; b", "&#; &#x; a & b"),
    ],
)
def test_safe_unescape_never_raises(text, expected):
    assert rp.safe_unescape(text) == expected


def test_an_oversized_character_reference_is_sanitized_not_fatal():
    # html.unescape raises on it, which would stop the release before its post was written.
    padded = "&#" + "0" * 5000 + "9;"
    assert rp.neutralize_links(f"[a](java{padded}script:x)") == f"[a](#java{padded}script:x)"
    post = rp.render_post({"number": 7, "body": f"Text {padded} [a](java{padded}script:x)"}, "T", "v1", "2026-09-26", [], [], None, "m")
    assert "](#java" in post
    assert rp.post_excerpt(post).startswith("Text")


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        # A code span may cross a line break; its text stays code, and a risky one becomes <code>
        # with the break as the space CommonMark renders.
        ("Use `List<T>\nand Map<K>` here", "Use <code>List&#60;T&#62; and Map&#60;K&#62;</code> here"),
        ("Use `plain\ntext` and <b>", "Use `plain\ntext` and &lt;b>"),
        # A blank line ends the paragraph, so these backticks open no span and <T> is escaped.
        ("Use `a <T>\n\nb` c", "Use `a &lt;T>\n\nb` c"),
    ],
)
def test_code_spans_may_cross_line_breaks(body, expected):
    assert rp.sanitize_markdown(body) == expected


# Each line that starts another block ends the paragraph, so a code span can't cross it (#57).
PARAGRAPH_BOUNDARIES = [
    pytest.param("{a}\n# {b}", id="atx-heading"),
    pytest.param("- {a}\n- {b}", id="list-item-same-level"),
    pytest.param("- x\n  - {a}\n- {b}", id="list-item-outer-level"),
    pytest.param("{a}\n***\n{b}", id="thematic-break"),
    pytest.param("{a}\n```\nx\n```\n{b}", id="fence"),
    pytest.param("{a}\n---\n{b}", id="setext-underline-dash"),
    pytest.param("{a}\n===\n{b}", id="setext-underline-equals"),
    pytest.param("{a}\n> {b}", id="quote-opens"),
    pytest.param("> {a}\n> > {b}", id="quote-deepens"),
]


@pytest.mark.parametrize("shape", PARAGRAPH_BOUNDARIES)
def test_a_code_span_ends_with_its_paragraph_in_a_post(shape):
    # Paired, the span would hold "<T>" and become <code>; unpaired, "<T>" is escaped text.
    body = shape.format(a="`a <T>", b="b` c")
    assert rp.sanitize_markdown(body).count("&lt;T>") == 1
    assert "<code>" not in rp.sanitize_markdown(body)


@pytest.mark.parametrize("shape", PARAGRAPH_BOUNDARIES)
def test_a_code_span_ends_with_its_paragraph_in_the_docs_readme(shape):
    # Copilot's example, from mpaulosky/TicketManager#118: both links are prose, so both are rebased.
    text = shape.format(a="`[a](docs/a.md)", b="`[b](docs/b.md)") + "\n"
    assert rp.rebase_readme_links(text) == text.replace("docs/", "")


@pytest.mark.parametrize(
    "shape",
    [
        pytest.param("> {a}\n{b}", id="lazy-continuation"),
        pytest.param("> > {a}\n> {b}", id="lazy-continuation-at-an-outer-quote"),
        pytest.param("{a}\n    {b}", id="indented-continuation"),
        pytest.param("- {a}\n  {b}", id="list-item-continuation"),
    ],
)
def test_a_code_span_still_crosses_a_paragraph_continuation_line(shape):
    post = rp.sanitize_markdown(shape.format(a="`a <T>", b="b` c"))
    assert "<code>a &#60;T&#62;" in post
    assert "&lt;" not in post
    text = shape.format(a="`[a](docs/a.md)", b="`[b](docs/b.md)") + "\n"
    assert rp.rebase_readme_links(text) == text.replace("docs/b.md", "b.md")


def test_a_title_cannot_close_its_blog_index_link_early(tmp_path):
    # "]" would end the label, so the row would link to the title's URL instead of the post.
    rp.update_blog_index(tmp_path, "2026-10-05", "fix: ](https://evil.example) `a[b` x", "p.md")
    [row] = [line for line in (tmp_path / "README.md").read_text().splitlines() if "p.md" in line]
    assert row == "| 2026-10-05 | [fix: &#93;(https://evil.example) `a[b` x](p.md) | release,automation |"


def test_a_reference_label_with_an_escaped_footnote_opener_is_neutralized():
    body = "[open][label \\[^x]\n\n[label \\[^x]: javascript:alert(1)"
    assert "]: #javascript:" in rp.sanitize_markdown(body)


# Code is published as written: it's found once, on the raw text, and every prose
# transformation runs only outside it (#58).


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        # A comment or link inside a span is code: it's kept, as entities, not dropped or neutralized.
        ("Write `<!-- TODO -->` here", "Write <code>&#60;&#33;&#45;&#45; TODO &#45;&#45;&#62;</code> here"),
        ("Write `[x](javascript:x)`", "Write <code>&#91;x&#93;&#40;javascript&#58;x&#41;</code>"),
        # A comment that starts first hides the backticks inside it, as in CommonMark.
        ("a <!-- ` --> b ` c", "a  b ` c"),
        ("a <!-- `x` --> b", "a  b"),
        # A span that starts first holds the comment's opener, so the rest is text.
        ("`a <!--` b -->", "<code>a &#60;&#33;&#45;&#45;</code> b -->"),
        # An unclosed backtick is text, and the comment after it is still dropped.
        ("`a <!-- b --> c", "`a  c"),
    ],
)
def test_code_spans_are_found_before_comments_are_dropped(body, expected):
    assert rp.sanitize_markdown(body) == expected


def test_a_title_keeps_comments_and_links_in_its_code_spans():
    assert rp.sanitize_inline("fix: Drop `<!-- x -->` and `[a](javascript:x)`") == (
        "fix: Drop <code>&#60;&#33;&#45;&#45; x &#45;&#45;&#62;</code>"
        " and <code>&#91;a&#93;&#40;javascript&#58;x&#41;</code>"
    )


@pytest.mark.parametrize(
    "body",
    [
        "`<!-- x -->` and `<script>alert(1)</script>`",
        "`<!-- x -->`<script>alert(1)</script>",
        "<!-- ` --> `<script>alert(1)</script>`",
        "`x <!-- `<script>alert(1)</script>-->",
        "<!-- `x -->`<script>alert(1)</script>",
        "[a](x `<script>alert(1)</script>`)",
        '[a](x "`<script>alert(1)</script>`")',
        "`a\n<!-- b`\n<script>alert(1)</script>\n-->",
        "`a\nb <!-- c`\n<script>alert(1)</script>\n-->",
    ],
)
def test_code_spans_around_comments_and_links_render_inert(body):
    # However the scanner and the renderer pair the backticks, every "<" is an entity or in <code>.
    post = rp.render_post({"number": 7, "body": body}, "T", "v1.2.3", "2026-09-26", [], [], body, "m")
    for line in outside_code(post):
        assert not re.search(r"<(?!code>|/code>|!-- \{% (?:end)?raw %\} -->)", line), line


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        # A comment between "](" and the destination is dropped, so the destination is still read.
        ("[a](<!-- x -->javascript:alert(1))", "[a](#javascript:alert(1))"),
        # A backtick in the destination makes it one link, read whole.
        ("[a](javascript:`x`)", "[a](#javascript:`x`)"),
        # A "[^1]:" after a code span isn't at the start of its line, so it's no footnote.
        ("`x` [^1]: javascript:x", "`x` [^1]: #javascript:x"),
    ],
)
def test_link_destinations_beside_code_are_still_neutralized(body, expected):
    assert rp.sanitize_markdown(body) == expected


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        # A fence in a list item, indented code, and indented code in a quote keep their tabs.
        ("- item\n\n  ```\n  a\tb\n  ```", "- item\n\n```text\na\tb\n```"),
        ("Text:\n\n    a\tb\n\tc\td", "Text:\n\n```text\na\tb\nc\td\n```"),
        (">     a\tb", "```text\na\tb\n```"),
        # A tab that spans the indentation keeps the columns past it, as spaces.
        ("- item\n\n\t\tcode", "- item\n\n```text\n  code\n```"),
    ],
)
def test_code_keeps_its_tabs(body, expected):
    assert rp.sanitize_markdown(body) == expected


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("```py\ns = '''a\n\n\nb'''\n```", "```py\ns = '''a\n\n\nb'''\n```"),
        ("Text:\n\n    a\n\n\n\n    b", "Text:\n\n```text\na\n\n\n\nb\n```"),
        ("- x\n\n  ```\n  a\n\n\n  b\n  ```\n\n\n\nafter", "- x\n\n```text\na\n\n\nb\n```\n\nafter"),
    ],
)
def test_code_keeps_its_blank_lines(body, expected):
    assert rp.sanitize_markdown(body) == expected


def test_the_readme_keeps_blank_lines_in_its_code():
    readme = "# T\n\n```py\na\n\n\nb\n```\n\n\n\nText\n\n    c\n\n\n\n    d\n"
    updated = rp.update_readme(readme, "<!-- RELEASES_START -->\n<!-- RELEASES_END -->", REPO)
    assert updated.startswith("# T\n\n```py\na\n\n\nb\n```\n\nText\n\n    c\n\n\n\n    d\n")


def test_a_link_title_keeps_its_code_in_a_post():
    # The title is part of the link, so its backticks open no span and its "<" is escaped as text.
    assert rp.sanitize_markdown('[x](https://a.example "Use `<b>`")') == '[x](https://a.example "Use `&lt;b>`")'


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('[x](docs/a.md "Use `code`")\n', '[x](a.md "Use `code`")\n'),
        ("[x](docs/a.md 'Use `code`') and [y](docs/b.md (`b`))\n", "[x](a.md 'Use `code`') and [y](b.md (`b`))\n"),
        # A title's backtick would otherwise pair with a later one and hide the next link.
        ('[x](a.md "`") [y](docs/b.md) `\n', '[x](../a.md "`") [y](b.md) `\n'),
        # So would a backtick in the destination.
        ("[x](docs/a`b.md) [y](docs/b.md) `\n", "[x](a`b.md) [y](b.md) `\n"),
        # A comment hides its backticks, so the link after it is text.
        ("Text <!-- ` --> [x](docs/a.md) `\n", "Text <!-- ` --> [x](a.md) `\n"),
    ],
)
def test_a_link_title_keeps_its_code_in_the_docs_readme(text, expected):
    assert rp.rebase_readme_links(text) == expected


def test_a_title_cannot_close_its_blog_index_link_when_its_backticks_pair_differently(tmp_path):
    # The sanitizer reads the first "](" as a link, so it pairs no backticks. Read again, the
    # escaped "<" ends that link early and two backticks pair around "](https://...)". Every
    # "]" is an entity, so neither reading can link the row elsewhere.
    rp.update_blog_index(tmp_path, "2026-10-05", "a](<a b`>)](https://evil.example) `", "p.md")
    [row] = [line for line in (tmp_path / "README.md").read_text().splitlines() if "p.md" in line]
    assert "](https://evil" not in row
    assert row.endswith("](p.md) | release,automation |")


@pytest.mark.parametrize(
    "shape",
    [
        lambda n: "[a](" * n,
        lambda n: "](" * n + "`",
        lambda n: "](x " * n,
        lambda n: '](x "' * n,
        lambda n: "<!--`" * n,
        lambda n: "](((" * n,
        lambda n: "](" + "(a)" * n + "](" * n,
    ],
)
def test_finding_code_stays_linear(shape):
    # As in test_scanning_stays_linear_in_nesting_depth_and_length: 4x the size, well under 16x the time.
    def best(n):
        text = shape(n)
        runs = []
        for _ in range(3):
            start = time.perf_counter()
            rp.sanitize_markdown(text)
            rp.rebase_readme_links(text)
            runs.append(time.perf_counter() - start)
        return min(runs)

    small, large = best(2_000), best(8_000)
    assert large < max(small, 0.001) * 10


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        # No "[" opens a label, so "](" starts no link and the backticks pair as a code span.
        ('Text ](x "`<T>`")', 'Text ](x "<code>&#60;T&#62;</code>")'),
        # An escaped "[" opens no label either.
        ('\\[x](docs/x.md "Use `List<T>`")', '\\[x](docs/x.md "Use <code>List&#60;T&#62;</code>")'),
        # A "]" before the "](" closes the only label, so it is text too.
        ('[a] ](x "`<T>`")', '[a] ](x "<code>&#60;T&#62;</code>")'),
        # A "[" inside a code span opens no label.
        ('`[` ](x "`<T>`")', '`[` ](x "<code>&#60;T&#62;</code>")'),
    ],
)
def test_a_close_bracket_without_a_label_starts_no_link(body, expected):
    assert rp.sanitize_markdown(body) == expected


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        # A ">" line is blank inside the quote, so the code on both sides of it is one block.
        ("> intro\n>\n>     a\n>\n>     b\n", "> intro\n>\n\n```text\na\n\nb\n```"),
        ("> - x\n>\n>       a\n>\n>       b", "> - x\n>\n\n```text\na\n\nb\n```"),
    ],
)
def test_quoted_indented_code_keeps_its_blank_lines(body, expected):
    assert rp.sanitize_markdown(body) == expected


@pytest.mark.parametrize(
    "body",
    [
        # A blank line ends the quote, so the code after it is a second block.
        ">     a\n\n    b",
        # A blank line in the outer quote ends the inner one.
        "> >     a\n>\n> >     b",
    ],
)
def test_indented_code_in_different_containers_stays_apart(body):
    assert rp.sanitize_markdown(body).count("```text") == 2

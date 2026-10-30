"""Tests for references/tokens.md (mpaulosky/dotfiles#231): it lists every API call the
Template's workflows make with RELEASE_PR_PAT or GITHUB_TOKEN, says whether each needs
the PAT and why, and gives land.sh's poll interval and cost. No GitHub.

The Template's workflows are the source of truth, so the page is checked against them:
add a call to pr-automerge.yml and this fails until the page lists it.
"""

import argparse
import re
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILL / "github"))
import land  # noqa: E402

TOKENS = SKILL / "references" / "tokens.md"
AUTOMERGE_DOC = SKILL / "references" / "automerge.md"
WORKFLOWS = SKILL / "template" / "owned" / ".github" / "workflows"


def inline_script(workflow):
    """The body of the workflow's `script: |` block, without its // comments."""
    lines = (WORKFLOWS / workflow).read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if re.fullmatch(r"\s*script: \|\s*", line))
    indent = len(lines[start]) - len(lines[start].lstrip())
    body = []
    for line in lines[start + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        body.append(re.sub(r"(^|\s)//.*$", r"\1", line))
    return "\n".join(body)


def automerge_calls():
    """{(call name, "pat" | "token")} for every API call pr-automerge.yml's script makes.

    A call can be made through both clients: graphql (GITHUB_TOKEN reads the PR, the PAT requests Copilot's
    review) and issues.createComment (GITHUB_TOKEN records that Copilot was asked, the PAT asks Dependabot to
    rebase), mpaulosky/dotfiles#360. Each pair needs its own row.
    """
    calls = set()
    for client, call in re.findall(r"\b(github|patClient)\.(graphql|rest\.\w+\.\w+)", inline_script("pr-automerge.yml")):
        calls.add((re.sub(r"^rest\.", "", call), "pat" if client == "patClient" else "token"))
    return calls


def page():
    assert TOKENS.is_file(), "references/tokens.md doesn't exist"
    return TOKENS.read_text()


def table_rows(text):
    """The cells of each table row, as [workflow, call, client, why]."""
    rows = []
    for line in text.splitlines():
        if line.startswith("|") and not re.fullmatch(r"[|\s:-]+", line):
            rows.append([cell.strip() for cell in line.strip().strip("|").split("|")])
    return rows


def section(text, heading_pattern):
    """The text from the first heading matching the pattern to the next heading of its level or higher."""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if re.match(r"#{2,4} ", line) and re.search(heading_pattern, line)), None)
    assert start is not None, f"tokens.md has no heading matching {heading_pattern!r}"
    level = len(lines[start]) - len(lines[start].lstrip("#"))
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"#{1,%d} " % level, lines[i])), len(lines))
    return "\n".join(lines[start:end])


def test_pr_automerge_makes_calls_through_two_clients():
    calls = automerge_calls()

    assert calls, "found no API calls in pr-automerge.yml's script"
    assert {client for _call, client in calls} == {"pat", "token"}


def test_lists_every_pr_automerge_call_with_its_client_and_why():
    rows = table_rows(page())

    for call, client in sorted(automerge_calls()):
        listed = [row for row in rows if len(row) >= 4 and f"`{call}" in row[1]]
        assert listed, f"tokens.md has no table row for `{call}`"
        if client == "pat":
            matching = [row for row in listed if "PAT" in row[2] and "GITHUB_TOKEN" not in row[2]]
        else:
            matching = [row for row in listed if "GITHUB_TOKEN" in row[2]]
        assert matching, f"tokens.md has no row for `{call}` through {client}: {[row[2] for row in listed]}"
        assert all(row[3] for row in matching), f"`{call}`'s row gives no reason"


def test_pr_automerge_asks_copilot_with_the_pat_and_records_the_ask_with_github_token():
    # mpaulosky/dotfiles#360: the one Copilot request is a person's call; the record comment is GITHUB_TOKEN's.
    calls = automerge_calls()

    assert ("graphql", "pat") in calls and ("graphql", "token") in calls
    assert ("issues.createComment", "token") in calls and ("issues.createComment", "pat") in calls
    rows = table_rows(page())
    request = [row for row in rows if len(row) >= 4 and "PAT" in row[2] and "graphql" in row[1]
               and re.search(r"requestReviews|Copilot", row[1])]
    record = [row for row in rows if len(row) >= 4 and "GITHUB_TOKEN" in row[2] and "createComment" in row[1]
              and re.search(r"Copilot|asked|record", row[1])]
    assert request, "tokens.md has no PAT row for the graphql call that requests Copilot's review (name Copilot or requestReviewsByLogin)"
    assert record, "tokens.md has no GITHUB_TOKEN row for the comment that records Copilot was asked"


def test_documents_the_exhaustion_comment_and_the_deletion_of_a_duplicate_with_github_token():
    # mpaulosky/dotfiles#375: PR Auto-Merge posts one comment when a PR's review loop is exhausted, and a run that
    # finds another run's comment ahead of its own deletes its own. Both are GITHUB_TOKEN's (pull-requests: write).
    calls = automerge_calls()

    assert ("issues.deleteComment", "token") in calls
    assert ("issues.deleteComment", "pat") not in calls
    rows = table_rows(page())
    posted = [row for row in rows if len(row) >= 4 and "GITHUB_TOKEN" in row[2] and "createComment" in row[1]
              and re.search(r"exhaust", " ".join(row), re.IGNORECASE)]
    deleted = [row for row in rows if len(row) >= 4 and "GITHUB_TOKEN" in row[2] and "deleteComment" in row[1]]
    assert posted, "tokens.md has no GITHUB_TOKEN row for the comment that documents an exhausted review loop"
    assert deleted and deleted[0][3], "tokens.md has no GITHUB_TOKEN row, with a reason, for deleting a duplicate exhaustion comment"


def test_tokens_md_no_longer_says_the_label_comes_off_at_the_review_cap():
    # The label comes off when the review loop is exhausted (mpaulosky/dotfiles#375), not at a cap of reviewed commits.
    text = page()

    assert not re.search(r"review cap|MAX_CLAUDE_ROUNDS commits|reviewed MAX_CLAUDE_ROUNDS", text), \
        "tokens.md still describes taking review:claude off at the review cap or after MAX_CLAUDE_ROUNDS reviewed commits"
    assert re.search(r"exhaust", text, re.IGNORECASE)


@pytest.mark.parametrize(
    "call",
    [
        "gh pr list",
        "gh api",
        "gh pr edit",
        "gh pr create",
        "gh pr merge",
        "git push",
        "create-pull-request",
    ],
)
def test_lists_the_release_and_backfill_workflows_calls(call):
    rows = table_rows(page())

    listed = [row for row in rows if len(row) >= 4 and re.search(rf"`[^`]*{re.escape(call)}[^`]*`", row[1])]
    assert listed, f"tokens.md has no table row for `{call}`"
    assert listed[0][3], f"`{call}`'s row gives no reason"
    assert re.search(r"PAT|GITHUB_TOKEN", listed[0][2])


def test_moves_the_blog_pr_lookups_and_label_to_github_token():
    rows = table_rows(page())

    for call in ("gh pr list", "gh api"):
        listed = [row for row in rows if len(row) >= 4 and f"`{call}" in row[1]]
        assert listed and all("GITHUB_TOKEN" in row[2] for row in listed), call
    for call in ("gh pr edit", "gh pr create", "gh pr merge"):
        listed = [row for row in rows if len(row) >= 4 and f"`{call}" in row[1]]
        assert listed and all("PAT" in row[2] and "GITHUB_TOKEN" not in row[2] for row in listed), call


def test_says_where_sandcastle_s_token_stands():
    text = page()

    assert "SANDCASTLE_GH_TOKEN" in text
    assert "RELEASE_PR_PAT" in text


def test_explains_the_shared_allowance_and_the_incident():
    text = page()

    assert "5,000" in text
    assert re.search(r"shar(e|es|ed)\b", text)
    assert "rate limit" in text.lower()
    assert "2026-10-18" in text


def default_interval(monkeypatch):
    """land.sh's --interval default, read from the parser land.main builds."""
    class Parsed(Exception):
        pass

    parse = argparse.ArgumentParser.parse_args

    def spy(self, args=None, namespace=None):
        raise Parsed(parse(self, args, namespace))

    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", spy)
    with pytest.raises(Parsed) as parsed:
        land.main([])
    return parsed.value.args[0].interval


def test_gives_land_sh_s_default_poll_interval(monkeypatch):
    interval = default_interval(monkeypatch)
    text = section(page(), r"land\.sh")

    assert re.search(rf"\b{interval:g} ?s(econds)?\b", text), f"the land.sh section doesn't give the {interval:g} s default"
    assert "--interval" in text


def test_gives_the_requests_a_land_sh_round_makes_and_the_shared_allowance():
    text = section(page(), r"land\.sh")

    assert re.search(r"GraphQL", text)
    assert re.search(r"\bper (repo|round|poll)\b|\ba round\b", text)
    assert "5,000" in text
    assert re.search(r"shar(e|es|ed)\b", text)
    assert "gh api rate_limit" in text


def test_automerge_md_gives_the_same_default_interval_and_points_at_tokens_md(monkeypatch):
    interval = default_interval(monkeypatch)
    text = AUTOMERGE_DOC.read_text()
    landing = text[text.index("### Landing a round"):]

    assert f"default every {interval:g} s" in landing
    assert "tokens.md" in landing
    assert "tokens.md" in text.split("### Landing a round")[0], "the Token bullet doesn't link tokens.md"


def test_skill_md_links_tokens_md():
    assert "references/tokens.md" in (SKILL / "SKILL.md").read_text()

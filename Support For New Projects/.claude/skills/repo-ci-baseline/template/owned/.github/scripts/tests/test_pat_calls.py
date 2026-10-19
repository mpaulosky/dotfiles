"""Pins which token each gh call in the blog-PR steps uses (mpaulosky/dotfiles#231).

release.yml's "Open or update the blog PR" and backfill-blog-posts.yml's "Open or
update the backfill PR" run as RELEASE_PR_PAT, so a PR they open is a person's and
its checks start. The PAT is the owner's account, whose REST allowance everything
acting as the owner shares, so only the calls GitHub must treat as a person's use
it. The lookups (gh pr list) and the docs-only label (gh api) are made with
GITHUB_TOKEN, which has an allowance of its own for the repo. references/tokens.md
lists each call and why.

The steps are inline in the workflows, so their text is read out of the files.
"""

import re
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parents[2] / "workflows"

STEPS = [
    ("release.yml", "Open or update the blog PR"),
    ("backfill-blog-posts.yml", "Open or update the backfill PR"),
]

JOB_TOKEN_ENV = "JOB_TOKEN: ${{ secrets.GITHUB_TOKEN }}"
PAT_ENV = "GH_TOKEN: ${{ secrets.RELEASE_PR_PAT || secrets.GITHUB_TOKEN }}"
READ_WITH_JOB_TOKEN = re.compile(r'GH_TOKEN="\$JOB_TOKEN" gh (pr list|api)\b')


def step_lines(workflow, name):
    """The lines of the step called `name`, up to the next step."""
    lines = (WORKFLOWS / workflow).read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {name}")
    indent = len(lines[start]) - len(lines[start].lstrip())
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("- name:") and len(lines[i]) - len(lines[i].lstrip()) == indent),
        len(lines),
    )
    return [line.strip() for line in lines[start:end]]


def commands(lines, pattern):
    """The non-comment lines that run a gh command matching pattern."""
    return [line for line in lines if not line.startswith("#") and re.search(pattern, line)]


@pytest.mark.parametrize(("workflow", "name"), STEPS)
def test_step_keeps_the_pat_as_its_gh_token_and_adds_a_job_token(workflow, name):
    lines = step_lines(workflow, name)

    assert PAT_ENV in lines
    assert JOB_TOKEN_ENV in lines


@pytest.mark.parametrize(("workflow", "name"), STEPS)
def test_step_looks_up_the_blog_pr_with_the_job_token(workflow, name):
    lines = step_lines(workflow, name)
    lists = commands(lines, r"\bgh pr list\b")

    # The lookup before opening or editing the PR, and the one before labelling it.
    assert len(lists) == 2
    for line in lists:
        assert READ_WITH_JOB_TOKEN.search(line), line


@pytest.mark.parametrize(("workflow", "name"), STEPS)
def test_step_adds_the_docs_only_label_with_the_job_token(workflow, name):
    lines = step_lines(workflow, name)
    labels = commands(lines, r"\bgh api\b")

    assert len(labels) == 1
    assert READ_WITH_JOB_TOKEN.search(labels[0]), labels[0]
    assert "docs-only" in labels[0]


@pytest.mark.parametrize(("workflow", "name"), STEPS)
def test_step_creates_and_merges_the_pr_with_the_pat(workflow, name):
    lines = step_lines(workflow, name)
    # A PR a person authored starts its pull_request runs without "Approve and
    # run", and GitHub merges an auto-merge as whoever armed it.
    writes = commands(lines, r"\bgh pr (create|edit|merge)\b")

    assert any("gh pr create" in line for line in writes)
    assert any("gh pr merge" in line for line in writes)
    for line in writes:
        assert "JOB_TOKEN" not in line, line


@pytest.mark.parametrize(("workflow", "name"), STEPS)
def test_step_makes_no_gh_call_the_pins_do_not_cover(workflow, name):
    lines = step_lines(workflow, name)
    calls = commands(lines, r"\bgh [a-z]")
    covered = r"\bgh (pr (list|create|edit|merge)|api)\b"

    assert [line for line in calls if not re.search(covered, line)] == []


def test_release_step_edits_the_pr_with_the_pat():
    lines = step_lines(*STEPS[0])
    edits = commands(lines, r"\bgh pr edit\b")

    # PR Title has to re-check the edited title, and a GITHUB_TOKEN edit starts no workflow.
    assert len(edits) == 1
    assert "JOB_TOKEN" not in edits[0]

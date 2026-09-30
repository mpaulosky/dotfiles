import io
import json

import pytest

import backfill_blog_posts as bf

REPO = "octo/demo"


def release(tag, pr, published="2026-09-20T10:00:00Z"):
    body = f"Source PR: #{pr}\nSource PR URL: https://github.com/{REPO}/pull/{pr}\n" if pr else "Notes.\n"
    return {"tag_name": tag, "name": f"Release {tag}", "published_at": published, "body": body}


class FakeGitHub:
    """Three releases for PRs 1, 2 (Dependabot) and 4, and one without a source PR."""

    def __init__(self):
        self.pulls = {
            1: {"number": 1, "title": "chore: First", "body": "One.", "merged_at": "2026-09-18T10:00:00Z"},
            2: {
                "number": 2,
                "title": "Bump codeql-action",
                "body": "Bumps.",
                "merged_at": "2026-09-19T10:00:00Z",
                "user": {"login": "dependabot[bot]"},
            },
            4: {"number": 4, "title": "feat: Fourth", "body": "Four.", "merged_at": "2026-09-20T10:00:00Z"},
        }
        for number, pr in self.pulls.items():
            pr["html_url"] = f"https://github.com/{REPO}/pull/{number}"
        self.releases_data = [
            release("v0.0.4", 4, "2026-09-20T11:00:00Z"),
            release("v0.0.2", 2, "2026-09-19T11:00:00Z"),
            release("v0.0.1", 1, "2026-09-18T11:00:00Z"),
            release("v0.0.0", None, "2026-09-17T11:00:00Z"),
        ]
        self.pulled = []

    def pull(self, number):
        self.pulled.append(number)
        return self.pulls[number]

    def pull_title(self, number):
        return self.pulls[number]["title"]

    def commits(self, number):
        return [{"sha": f"{number}" * 7, "commit": {"message": f"change {number}"}}]

    def files(self, number):
        return [{"filename": f"src/{number}.cs", "additions": 1, "deletions": 0, "patch": "+x"}]

    def releases(self):
        return self.releases_data


def make_repo(tmp_path):
    (tmp_path / "docs" / "blogs").mkdir(parents=True)
    (tmp_path / "README.md").write_text(
        "# Demo\n\n## Releases\n\n<!-- RELEASES_START -->\nold\n<!-- RELEASES_END -->\n", encoding="utf-8"
    )
    (tmp_path / "docs" / "README.md").write_text("# Demo\n", encoding="utf-8")
    (tmp_path / "docs" / "index.html").write_text(
        "<!-- RELEASES_HTML_START -->\n<!-- RELEASES_HTML_END -->\n"
        "<!-- BLOGS_HTML_START -->\n<!-- BLOGS_HTML_END -->\n",
        encoding="utf-8",
    )
    return tmp_path


def read_all(root):
    return {
        str(p.relative_to(root)): p.read_text(encoding="utf-8") for p in sorted(root.rglob("*")) if p.is_file()
    }


def posts(root):
    return sorted(p.name for p in (root / "docs" / "blogs").glob("*-pr-*.md"))


@pytest.mark.parametrize(
    "text, expected",
    [
        ("", None),
        ("  ", None),
        (None, None),
        ("1", {1}),
        ("1, 3,#4 ,", {1, 3, 4}),
    ],
)
def test_parse_pr_numbers(text, expected):
    assert bf.parse_pr_numbers(text) == expected


def test_parse_pr_numbers_rejects_non_numbers():
    with pytest.raises(ValueError):
        bf.parse_pr_numbers("1, two")


def test_selects_releases_without_a_post_oldest_first(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    (blog_dir / "2026-09-19-pr-2-bump.md").write_text("post\n", encoding="utf-8")
    selected = bf.select_releases(FakeGitHub().releases(), blog_dir)
    assert selected == [(1, "v0.0.1"), (4, "v0.0.4")]


def test_regenerate_selects_every_release_with_a_source_pr(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    (blog_dir / "2026-09-19-pr-2-bump.md").write_text("post\n", encoding="utf-8")
    selected = bf.select_releases(FakeGitHub().releases(), blog_dir, regenerate=True)
    assert selected == [(1, "v0.0.1"), (2, "v0.0.2"), (4, "v0.0.4")]


def test_pr_numbers_limit_the_selection(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    selected = bf.select_releases(FakeGitHub().releases(), blog_dir, regenerate=True, only={2, 99})
    assert selected == [(2, "v0.0.2")]


def test_a_post_for_pr_1_does_not_count_for_pr_10(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    (blog_dir / "2026-09-18-pr-10-other.md").write_text("post\n", encoding="utf-8")
    assert (1, "v0.0.1") in bf.select_releases(FakeGitHub().releases(), blog_dir)


def test_run_writes_missing_posts_with_the_existing_tags(tmp_path):
    make_repo(tmp_path)
    written = bf.run(REPO, FakeGitHub(), root=tmp_path)

    assert written == [1, 2, 4]
    assert posts(tmp_path) == [
        "2026-09-18-pr-1-chore-first.md",
        "2026-09-19-pr-2-bump-codeql-action.md",
        "2026-09-20-pr-4-feat-fourth.md",
    ]
    fourth = (tmp_path / "docs" / "blogs" / "2026-09-20-pr-4-feat-fourth.md").read_text(encoding="utf-8")
    assert "- **Release tag:** `v0.0.4`" in fourth
    assert "## Commits" in fourth and "## Files changed" in fourth

    index = (tmp_path / "docs" / "blogs" / "README.md").read_text(encoding="utf-8")
    assert index.index("pr-4-") < index.index("pr-2-") < index.index("pr-1-")

    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "old" not in readme
    assert f"| [v0.0.4](https://github.com/{REPO}/releases/tag/v0.0.4) | 2026-09-20 | feat: Fourth | [Post](" in readme
    assert "| [v0.0.0](https://github.com/octo/demo/releases/tag/v0.0.0) | 2026-09-17 | Release v0.0.0 | — |" in readme
    assert (tmp_path / "docs" / "README.md").read_text(encoding="utf-8") == readme

    html = (tmp_path / "docs" / "index.html").read_text(encoding="utf-8")
    assert html.count('">Post</a>') == 3
    assert f'<a href="https://github.com/{REPO}/pull/2">PR #2</a>' in html


def test_dependabot_post_has_no_summary_but_others_do(tmp_path):
    make_repo(tmp_path)

    def urlopen(request, timeout):
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        return Response(json.dumps({"content": [{"type": "text", "text": "A summary."}]}).encode("utf-8"))

    bf.run(REPO, FakeGitHub(), root=tmp_path, api_key="sk-test", urlopen=urlopen)
    blog_dir = tmp_path / "docs" / "blogs"
    assert "## Summary" not in (blog_dir / "2026-09-19-pr-2-bump-codeql-action.md").read_text(encoding="utf-8").splitlines()
    assert "## Summary" in (blog_dir / "2026-09-18-pr-1-chore-first.md").read_text(encoding="utf-8").splitlines()


def test_second_run_without_regenerate_changes_nothing(tmp_path):
    make_repo(tmp_path)
    bf.run(REPO, FakeGitHub(), root=tmp_path)
    first = read_all(tmp_path)

    gh = FakeGitHub()
    assert bf.run(REPO, gh, root=tmp_path) == []
    assert gh.pulled == []
    assert read_all(tmp_path) == first


def test_regenerate_replaces_old_format_posts(tmp_path):
    blog_dir = make_repo(tmp_path) / "docs" / "blogs"
    old = "2026-09-17-pr-1-chore-first.md"
    (blog_dir / old).write_text('---\npost_title: "chore: First"\n---\n## chore: First\n', encoding="utf-8")

    assert bf.run(REPO, FakeGitHub(), root=tmp_path, regenerate=True) == [1, 2, 4]
    assert old not in posts(tmp_path)
    assert "2026-09-18-pr-1-chore-first.md" in posts(tmp_path)
    assert old not in (blog_dir / "README.md").read_text(encoding="utf-8")


def test_regenerate_twice_changes_nothing(tmp_path):
    make_repo(tmp_path)
    bf.run(REPO, FakeGitHub(), root=tmp_path, regenerate=True)
    first = read_all(tmp_path)
    bf.run(REPO, FakeGitHub(), root=tmp_path, regenerate=True)
    assert read_all(tmp_path) == first


def test_main_passes_the_inputs(monkeypatch, tmp_path):
    calls = {}

    def fake_run(repository, gh, root, regenerate, only, api_key, model, wait_for):
        calls.update(
            repository=repository, regenerate=regenerate, only=only, api_key=api_key, model=model, wait_for=wait_for
        )
        return []

    monkeypatch.setattr(bf, "run", fake_run)
    monkeypatch.setenv("ANTHROPIC_API_KEY", " sk-test ")
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    bf.main(["--repo", REPO, "--regenerate", "true", "--pr-numbers", "3, 1"])
    assert calls == {
        "repository": REPO,
        "regenerate": True,
        "only": {1, 3},
        "api_key": "sk-test",
        "model": bf.rp.DEFAULT_MODEL,
        "wait_for": None,
    }


class LaggingGitHub(FakeGitHub):
    """Lists v0.0.4 (PR 4) only from the given call on, like a just-published Release."""

    def __init__(self, listed_from_call):
        super().__init__()
        self.listed_from_call = listed_from_call
        self.calls = 0

    def releases(self):
        self.calls += 1
        if self.calls < self.listed_from_call:
            return [r for r in self.releases_data if r["tag_name"] != "v0.0.4"]
        return self.releases_data


def test_run_lists_again_until_a_just_published_release_appears(tmp_path):
    make_repo(tmp_path)
    gh = LaggingGitHub(listed_from_call=3)
    slept = []

    written = bf.run(REPO, gh, root=tmp_path, wait_for={4}, sleep=slept.append)

    assert written == [1, 2, 4]
    assert slept == [bf.WAIT_DELAY, bf.WAIT_DELAY]
    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert "[v0.0.4]" in readme


def test_the_tables_use_the_listing_the_posts_came_from(tmp_path):
    make_repo(tmp_path)
    gh = LaggingGitHub(listed_from_call=2)

    bf.run(REPO, gh, root=tmp_path, wait_for={4}, sleep=lambda _: None)

    # One listing that lacked v0.0.4, one that had it; the tables reuse the second.
    assert gh.calls == 2
    assert "[v0.0.4]" in (tmp_path / "README.md").read_text(encoding="utf-8")


def test_run_writes_what_is_listed_when_a_release_never_appears(tmp_path, capsys):
    make_repo(tmp_path)
    gh = LaggingGitHub(listed_from_call=99)
    slept = []

    written = bf.run(REPO, gh, root=tmp_path, wait_for={4}, sleep=slept.append)

    assert written == [1, 2]
    assert gh.calls == bf.WAIT_ATTEMPTS
    assert len(slept) == bf.WAIT_ATTEMPTS - 1
    assert "::warning::No Release is listed yet for PR #4" in capsys.readouterr().out


def test_run_lists_once_without_wait_for(tmp_path):
    make_repo(tmp_path)
    gh = LaggingGitHub(listed_from_call=99)

    written = bf.run(REPO, gh, root=tmp_path, sleep=lambda _: pytest.fail("slept"))

    assert written == [1, 2]
    assert gh.calls == 1


def test_main_passes_wait_for_prs(monkeypatch):
    seen = {}
    monkeypatch.setattr(bf, "run", lambda *args, **kwargs: seen.update(kwargs))
    monkeypatch.setattr(bf.rp, "GitHub", lambda repo: object())

    bf.main(["--repo", REPO, "--wait-for-prs", "187, #188"])

    assert seen["wait_for"] == {187, 188}

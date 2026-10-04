import json

import pytest

import release_queue as rq


def pull(number, merged_at, title=None, sha=None, updated_at=None):
    return {
        "number": number,
        "title": title or f"feat: PR {number}",
        "merged_at": merged_at,
        "updated_at": updated_at or merged_at or "2026-09-29T00:00:00Z",
        "merge_commit_sha": sha or f"sha{number}",
    }


def release(tag, pr):
    return {"tag_name": tag, "body": f"Source PR: #{pr}\n"}


def never_contained(sha):
    return False


def order_of(pulls):
    """Positions on main in merge-time order, as a fresh fetch of main would give them."""
    merged = sorted((pr for pr in pulls if pr["merged_at"]), key=lambda pr: pr["merged_at"])
    return {pr["merge_commit_sha"]: position for position, pr in enumerate(merged)}


# queue()


def test_unreleased_prs_are_queued_oldest_merge_first():
    pulls = [
        pull(12, "2026-09-29T10:02:00Z"),
        pull(10, "2026-09-29T10:00:00Z"),
        pull(11, "2026-09-29T10:01:00Z"),
    ]

    assert rq.queue(pulls, released=set(), in_cutoff=never_contained, has_cutoff=True, main_order=order_of(pulls)) == [10, 11, 12]


def test_released_and_skip_release_prs_are_left_out():
    pulls = [
        pull(10, "2026-09-29T10:00:00Z"),
        pull(11, "2026-09-29T10:01:00Z", title="docs: Add release blog for PR #10 [skip-release]"),
        pull(12, "2026-09-29T10:02:00Z"),
    ]

    assert rq.queue(pulls, released={10}, in_cutoff=never_contained, has_cutoff=True, main_order=order_of(pulls)) == [12]


def test_a_dependabot_merge_is_released_by_the_next_merged_prs_run():
    # A Dependabot PR is auto-merged with GITHUB_TOKEN, which starts no
    # workflows, so it never gets a release run of its own. The next merged
    # PR's run must release it first, in merge order: dependency bumps ship
    # with the next release by design (release-pipeline.md).
    bump = pull(30, "2026-09-29T09:00:00Z", title="chore(deps): bump the all-nuget group with 3 updates")
    trigger = pull(31, "2026-09-29T10:00:00Z")
    pulls = [trigger, bump]

    queued = rq.queue(pulls, released=set(), in_cutoff=never_contained, has_cutoff=True, trigger=31,
                      trigger_pull=trigger, main_order=order_of(pulls))

    assert queued == [30, 31]


def test_prs_already_inside_the_cutoff_release_are_left_out():
    # PRs merged before the newest Release are history, even without a Release of their own
    # (for example, merged before release automation existed).
    pulls = [pull(1, "2026-01-01T00:00:00Z"), pull(20, "2026-09-29T10:00:00Z")]

    queued = rq.queue(pulls, released=set(), in_cutoff=lambda sha: sha == "sha1", has_cutoff=True, main_order=order_of(pulls))

    assert queued == [20]


def test_without_any_release_only_the_triggering_pr_is_queued():
    pulls = [pull(1, "2026-01-01T00:00:00Z"), pull(2, "2026-01-02T00:00:00Z")]

    queued = rq.queue(pulls, released=set(), in_cutoff=never_contained, has_cutoff=False, trigger=2, main_order=order_of(pulls))

    assert queued == [2]


def test_the_triggering_pr_is_queued_even_when_the_listing_missed_it():
    pulls = [pull(10, "2026-09-29T10:00:00Z")]
    trigger = pull(11, "2026-09-29T10:01:00Z")

    queued = rq.queue(
        pulls, released=set(), in_cutoff=never_contained, has_cutoff=True, trigger=11, trigger_pull=trigger,
        main_order=order_of(pulls + [trigger]),
    )

    assert queued == [10, 11]


def test_a_released_triggering_pr_is_not_queued_again():
    pulls = [pull(10, "2026-09-29T10:00:00Z")]

    assert rq.queue(pulls, released={10}, in_cutoff=never_contained, has_cutoff=True, trigger=10, main_order=order_of(pulls)) == []


def test_an_older_owed_pr_goes_ahead_of_a_manually_triggered_newer_one():
    # A manual run for a newer PR must not let it take a version ahead of an older PR still owed one.
    pulls = [pull(10, "2026-09-29T10:00:00Z"), pull(11, "2026-09-29T10:01:00Z")]

    assert rq.queue(pulls, released=set(), in_cutoff=never_contained, has_cutoff=True, trigger=11, main_order=order_of(pulls)) == [10, 11]


def test_unmerged_prs_are_left_out():
    pulls = [pull(10, None), pull(11, "2026-09-29T10:01:00Z")]

    assert rq.queue(pulls, released=set(), in_cutoff=never_contained, has_cutoff=True, main_order=order_of(pulls)) == [11]



def test_prs_merged_in_the_same_second_follow_their_order_on_main():
    # merged_at has one-second resolution; main's history decides a tie.
    pulls = [
        pull(21, "2026-09-29T10:00:00Z", sha="b"),
        pull(20, "2026-09-29T10:00:00Z", sha="a"),
    ]
    order = {"b": 0, "a": 1}  # b merged first

    queued = rq.queue(pulls, released=set(), in_cutoff=never_contained, has_cutoff=True, main_order=order)

    assert queued == [21, 20]


def test_a_listed_merge_missing_from_main_stops_the_run_instead_of_guessing_its_place():
    pulls = [pull(30, "2026-09-29T10:00:00Z", sha="known"), pull(31, "2026-09-29T10:00:00Z", sha="missing")]

    with pytest.raises(rq.UnknownMergeOrder, match="#31"):
        rq.queue(pulls, released=set(), in_cutoff=never_contained, has_cutoff=True, main_order={"known": 0})


# cutoff_release()


def test_the_cutoff_is_the_newest_published_release_by_version():
    releases = [release("v0.0.9", 9), release("v0.0.10", 10), release("v0.0.1-1170", None)]

    assert rq.cutoff_release(releases) == ("v0.0.10", 10)


def test_there_is_no_cutoff_without_a_release():
    assert rq.cutoff_release([release("v0.0.1-1170", None)]) == (None, None)


# GitHub.merged_pulls()


class PagedGitHub(rq.GitHub):
    """merged_pulls() over canned pages instead of the API."""

    def __init__(self, pages):
        super().__init__("octo/demo")
        self.pages = pages
        self.fetched = []

    def _closed_pulls_page(self, page):
        self.fetched.append(page)
        return self.pages[page - 1] if page <= len(self.pages) else []


def test_merged_pulls_pages_back_to_the_boundary_and_stops():
    pages = [
        [pull(30, "2026-09-29T12:00:00Z"), pull(29, None, updated_at="2026-09-29T11:00:00Z")],
        [pull(28, "2026-09-29T10:00:00Z"), pull(5, "2026-01-01T00:00:00Z")],
        [pull(4, "2025-12-01T00:00:00Z")],
    ]
    gh = PagedGitHub(pages)

    numbers = [pr["number"] for pr in gh.merged_pulls(since="2026-09-29T09:00:00Z")]

    assert numbers == [30, 28]
    assert gh.fetched == [1, 2]


def test_merged_pulls_keeps_paging_while_every_pr_is_newer_than_the_boundary():
    pages = [[pull(n, "2026-09-29T12:00:00Z")] for n in (40, 39, 38)]
    gh = PagedGitHub(pages)

    numbers = [pr["number"] for pr in gh.merged_pulls(since="2026-09-29T09:00:00Z")]

    assert numbers == [40, 39, 38]
    assert gh.fetched == [1, 2, 3, 4]


# main()


class FakeGitHub:
    def __init__(self, pulls, releases):
        self._pulls = pulls
        self._releases = releases
        self.since = None

    def merged_pulls(self, since):
        self.since = since
        return self._pulls

    def pull(self, number):
        if number in getattr(self, "extra", {}):
            return self.extra[number]
        return next(dict(p, base={"ref": "main"}) for p in self._pulls if p["number"] == number)

    def releases(self):
        return self._releases


def test_main_prints_the_queue_as_json_and_lists_merges_since_the_cutoff_pr(capsys):
    gh = FakeGitHub(
        pulls=[
            pull(9, "2026-09-29T09:00:00Z"),
            pull(10, "2026-09-29T10:00:00Z"),
            pull(11, "2026-09-29T10:01:00Z"),
        ],
        releases=[release("v0.0.9", 9)],
    )

    rq.main(["--repo", "octo/demo", "--pr", "11"], gh=gh, contains=lambda tag, sha: sha == "sha9", main_order={"sha9": 0, "sha10": 1, "sha11": 2})

    assert json.loads(capsys.readouterr().out) == [10, 11]
    assert gh.since == "2026-09-29T09:00:00Z"



def test_main_skips_a_manually_named_pr_merged_into_another_branch(capsys):
    # A manual run can name any PR. One merged elsewhere is never owed a release from main,
    # so it's left out instead of failing the run on a merge commit main doesn't have.
    other = dict(pull(12, "2026-09-29T10:05:00Z"), base={"ref": "develop"})
    gh = FakeGitHub(pulls=[pull(9, "2026-09-29T09:00:00Z"), pull(10, "2026-09-29T10:00:00Z")],
                    releases=[release("v0.0.9", 9)])
    gh.extra = {12: other}

    rq.main(["--repo", "octo/demo", "--pr", "12"], gh=gh, contains=lambda tag, sha: sha == "sha9",
            main_order={"sha9": 0, "sha10": 1})

    assert json.loads(capsys.readouterr().out) == [10]

def test_main_ignores_a_tag_whose_release_was_never_published(capsys):
    # PR 10 got its tag, but the run failed before the Release: it's still owed one,
    # so the cutoff stays at the last published Release (PR 9).
    gh = FakeGitHub(
        pulls=[pull(9, "2026-09-29T09:00:00Z"), pull(10, "2026-09-29T10:00:00Z")],
        releases=[release("v0.0.9", 9)],
    )
    checked = []

    def contains(tag, sha):
        checked.append(tag)
        return sha == "sha9"

    rq.main(["--repo", "octo/demo"], gh=gh, contains=contains, main_order={"sha9": 0, "sha10": 1})

    assert json.loads(capsys.readouterr().out) == [10]
    assert set(checked) == {"v0.0.9"}

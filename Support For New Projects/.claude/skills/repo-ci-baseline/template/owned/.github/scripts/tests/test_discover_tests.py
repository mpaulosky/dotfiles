import json

import discover_tests as dt


def project(root, folder, body="", props_dir=None):
    """Writes tests/<folder>/<folder>.csproj holding body; returns its path."""
    path = root / "tests" / folder / f"{folder}.csproj"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>{body}</PropertyGroup>\n</Project>\n')
    return path


def props(directory, body):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "Directory.Build.props").write_text(f"<Project>\n  <PropertyGroup>{body}</PropertyGroup>\n</Project>\n")


def names(root):
    return [entry["test_name"] for entry in dt.discover(root)[1]]


def run(root, tmp_path):
    output = tmp_path / "github_output"
    status = dt.main(["--root", str(root), "--output", str(output)])
    return status, output.read_text() if output.exists() else ""


def test_a_csproj_that_sets_is_test_project_is_a_test_project(tmp_path):
    project(tmp_path, "App.Tests", "<IsTestProject>true</IsTestProject>")

    assert names(tmp_path) == ["App.Tests"]


def test_a_project_setting_nothing_is_a_helper_library(tmp_path):
    project(tmp_path, "App.Tests", "<IsTestProject>true</IsTestProject>")
    project(tmp_path, "TestingSupport.Library")

    assert names(tmp_path) == ["App.Tests"]


def test_is_test_project_set_in_tests_directory_build_props_counts(tmp_path):
    # atelier-store and Blazor-Server set it once for every test project.
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    project(tmp_path, "Web.Tests.Unit")
    project(tmp_path, "Web.Tests.Bunit")

    assert names(tmp_path) == ["Web.Tests.Bunit", "Web.Tests.Unit"]


def test_the_csproj_overrides_directory_build_props(tmp_path):
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    project(tmp_path, "Web.Tests.Unit")
    project(tmp_path, "TestingSupport.Library", "<IsTestProject>false</IsTestProject>")

    assert names(tmp_path) == ["Web.Tests.Unit"]


def test_the_nearest_directory_build_props_that_sets_it_wins(tmp_path):
    props(tmp_path, "<IsTestProject>false</IsTestProject>")
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    props(tmp_path / "tests" / "Web.Tests.Unit", "<Nullable>enable</Nullable>")
    project(tmp_path, "Web.Tests.Unit")

    assert names(tmp_path) == ["Web.Tests.Unit"]


def test_value_matching_ignores_case_and_whitespace(tmp_path):
    project(tmp_path, "App.Tests", "<IsTestProject> True </IsTestProject>")

    assert names(tmp_path) == ["App.Tests"]


def test_a_matrix_entry_carries_the_project_settings(tmp_path):
    project(tmp_path, "Web.Tests.E2E", '<IsTestProject>true</IsTestProject><X Include="Microsoft.Playwright" />')

    [entry] = dt.discover(tmp_path)[1]

    assert entry == {
        "project_path": "tests/Web.Tests.E2E/Web.Tests.E2E.csproj",
        "test_name": "Web.Tests.E2E",
        "test_id": "web-tests-e2e",
        "build_before_test": True,
        "no_build": True,
        "requires_playwright": True,
        "verbosity": "normal",
    }


def test_main_writes_the_matrix_and_has_tests(tmp_path):
    root = tmp_path / "repo"
    project(root, "App.Tests", "<IsTestProject>true</IsTestProject>")

    status, output = run(root, tmp_path)

    assert status == 0
    lines = output.splitlines()
    assert lines[0] == "matrix<<EOF"
    assert [entry["test_name"] for entry in json.loads(lines[1])["include"]] == ["App.Tests"]
    assert lines[2:] == ["EOF", "has_tests=true"]


def test_main_skips_tests_when_there_are_no_projects(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()

    status, output = run(root, tmp_path)

    assert status == 0
    assert output.splitlines()[-1] == "has_tests=false"


def test_main_fails_when_projects_exist_but_none_is_a_test_project(tmp_path, capsys):
    # A skipped matrix passes "Test Suite", so this must not look like a repo without tests.
    root = tmp_path / "repo"
    project(root, "Web.Tests.Unit")

    status, output = run(root, tmp_path)

    assert status == 1
    assert output == ""
    assert "::error::" in capsys.readouterr().out

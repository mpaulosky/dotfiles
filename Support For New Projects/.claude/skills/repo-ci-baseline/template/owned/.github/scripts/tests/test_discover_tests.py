import json

import pytest

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
    # atelier-store sets it once for every test project.
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    project(tmp_path, "Web.Tests.Unit")
    project(tmp_path, "Web.Tests.Bunit")

    assert names(tmp_path) == ["Web.Tests.Bunit", "Web.Tests.Unit"]


def test_the_csproj_overrides_directory_build_props(tmp_path):
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    project(tmp_path, "Web.Tests.Unit")
    project(tmp_path, "TestingSupport.Library", "<IsTestProject>false</IsTestProject>")

    assert names(tmp_path) == ["Web.Tests.Unit"]


IMPORT_PARENT = (
    "<Import Project=\"$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', "
    "'$(MSBuildThisFileDirectory)../'))\" />"
)


def props_file(directory, body, outside=""):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "Directory.Build.props").write_text(
        f"<Project>\n  {outside}\n  <PropertyGroup>{body}</PropertyGroup>\n</Project>\n"
    )


def test_only_the_nearest_directory_build_props_is_read(tmp_path):
    # MSBuild imports just the nearest one, so it hides tests/Directory.Build.props.
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    props(tmp_path / "tests" / "Web.Tests.Unit", "<Nullable>enable</Nullable>")
    project(tmp_path, "Web.Tests.Unit")
    project(tmp_path, "Web.Tests.Bunit")

    assert names(tmp_path) == ["Web.Tests.Bunit"]


def test_a_nearer_directory_build_props_that_imports_its_parent_inherits_it(tmp_path):
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    props_file(tmp_path / "tests" / "Web.Tests.Unit", "<Nullable>enable</Nullable>", IMPORT_PARENT)
    project(tmp_path, "Web.Tests.Unit")

    assert names(tmp_path) == ["Web.Tests.Unit"]


def test_the_nearer_directory_build_props_value_wins_over_its_parent(tmp_path):
    props(tmp_path / "tests", "<IsTestProject>true</IsTestProject>")
    props_file(tmp_path / "tests" / "Helpers", "<IsTestProject>false</IsTestProject>", IMPORT_PARENT)
    project(tmp_path, "Helpers")
    project(tmp_path, "Web.Tests.Unit")

    assert names(tmp_path) == ["Web.Tests.Unit"]


def test_a_root_directory_build_props_counts(tmp_path):
    props(tmp_path, "<IsTestProject>true</IsTestProject>")
    project(tmp_path, "Web.Tests.Unit")

    assert names(tmp_path) == ["Web.Tests.Unit"]


def when(condition, body):
    return f'<PropertyGroup Condition="{condition}">{body}</PropertyGroup>'


def test_a_conditional_is_test_project_applies_only_where_the_condition_holds(tmp_path):
    # Blazor-Server's root Directory.Build.props.
    props_file(tmp_path, "", when("$(MSBuildProjectName.Contains('.Tests'))", "<IsTestProject>true</IsTestProject>"))
    project(tmp_path, "Domain.Tests.Unit")
    project(tmp_path, "TestingSupport.Library")

    assert names(tmp_path) == ["Domain.Tests.Unit"]


@pytest.mark.parametrize(
    ("condition", "expected"),
    [
        ("$(MSBuildProjectName.Contains('.Tests'))", ["Web.Tests.Unit"]),
        ("$(MSBuildProjectName.StartsWith('Web.'))", ["Web.Tests.Unit"]),
        ("$(MSBuildProjectName.EndsWith('.Unit'))", ["Web.Tests.Unit"]),
        # MSBuild compares with == and != case-insensitively.
        ("'$(MSBuildProjectName)' == 'web.tests.unit'", ["Web.Tests.Unit"]),
        ("'$(MSBuildProjectName)' != 'TestingSupport.Library'", ["Web.Tests.Unit"]),
        ("!$(MSBuildProjectName.Contains('Support'))", ["Web.Tests.Unit"]),
    ],
)
def test_each_condition_shape_is_evaluated(tmp_path, condition, expected):
    props_file(tmp_path / "tests", "", when(condition, "<IsTestProject>true</IsTestProject>"))
    project(tmp_path, "Web.Tests.Unit")
    project(tmp_path, "TestingSupport.Library")

    assert names(tmp_path) == expected


def test_a_condition_on_the_property_itself_is_evaluated(tmp_path):
    props(tmp_path / "tests", "<IsTestProject Condition=\"$(MSBuildProjectName.Contains('.Tests'))\">true</IsTestProject>")
    project(tmp_path, "App.Tests")
    project(tmp_path, "TestingSupport.Library")

    assert names(tmp_path) == ["App.Tests"]


def test_a_condition_that_does_not_hold_leaves_the_earlier_value(tmp_path):
    props_file(
        tmp_path / "tests",
        "<IsTestProject>true</IsTestProject></PropertyGroup>\n  "
        + when("'$(MSBuildProjectName)' == 'Helpers'", "<IsTestProject>false</IsTestProject>")
        + "\n  <PropertyGroup>",
    )
    project(tmp_path, "Helpers")
    project(tmp_path, "Web.Tests.Unit")

    assert names(tmp_path) == ["Web.Tests.Unit"]


def test_an_unknown_condition_counts_as_holding_and_is_logged(tmp_path, capsys):
    props_file(tmp_path, "", when("'$(Configuration)' == 'Debug'", "<IsTestProject>true</IsTestProject>"))
    project(tmp_path, "App.Tests")

    assert names(tmp_path) == ["App.Tests"]
    out = capsys.readouterr().out
    assert "::notice::" in out
    assert "'$(Configuration)' == 'Debug'" in out


def test_a_project_with_the_msbuild_namespace_is_read(tmp_path):
    path = tmp_path / "tests" / "App.Tests" / "App.Tests.csproj"
    path.parent.mkdir(parents=True)
    path.write_text(
        '\ufeff<?xml version="1.0" encoding="utf-8"?>\n'
        '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">'
        "<PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>\n",
        encoding="utf-8",
    )

    assert names(tmp_path) == ["App.Tests"]


def test_property_names_ignore_case(tmp_path):
    project(tmp_path, "App.Tests", "<isTestProject>true</isTestProject>")

    assert names(tmp_path) == ["App.Tests"]


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



def test_list_prints_each_test_project_path(tmp_path, capsys):
    # scripts/gate.sh reads these, so it tests what CI tests, at any depth under tests/.
    root = tmp_path / "repo"
    project(root, "App.Tests", "<IsTestProject>true</IsTestProject>")
    project(root, "TestingSupport.Library")
    nested = root / "tests" / "Integration" / "Api.Tests" / "Api.Tests.csproj"
    nested.parent.mkdir(parents=True)
    nested.write_text("<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>\n")

    status = dt.main(["--root", str(root), "--list"])

    assert status == 0
    assert capsys.readouterr().out.splitlines() == [
        "tests/App.Tests/App.Tests.csproj",
        "tests/Integration/Api.Tests/Api.Tests.csproj",
    ]


def test_list_keeps_messages_off_stdout(tmp_path, capsys):
    root = tmp_path / "repo"
    props_file(root, "", when("'$(Configuration)' == 'Debug'", "<IsTestProject>true</IsTestProject>"))
    project(root, "App.Tests")

    status = dt.main(["--root", str(root), "--list"])

    assert status == 0
    captured = capsys.readouterr()
    assert captured.out == "tests/App.Tests/App.Tests.csproj\n"
    assert "can't evaluate Condition" in captured.err


def test_list_prints_nothing_when_there_are_no_projects(tmp_path, capsys):
    root = tmp_path / "repo"
    root.mkdir()

    assert dt.main(["--root", str(root), "--list"]) == 0
    assert capsys.readouterr().out == ""


def test_list_fails_when_projects_exist_but_none_is_a_test_project(tmp_path, capsys):
    root = tmp_path / "repo"
    project(root, "Web.Tests.Unit")

    status = dt.main(["--root", str(root), "--list"])

    assert status == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "resolves IsTestProject to true" in captured.err

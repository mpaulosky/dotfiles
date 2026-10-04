import io

import pytest

import load_test_env as lte


def run(tmp_path, test_env=None):
    output = tmp_path / "github_env"
    environ = {} if test_env is None else {"TEST_ENV": test_env}
    log = io.StringIO()
    status = lte.main(["--output", str(output)], environ=environ, out=log)
    return status, output.read_text() if output.exists() else "", log.getvalue()


def test_parse_reads_name_value_lines_and_skips_blanks_and_comments():
    text = "# MongoDB\nMongoDB__ConnectionString=mongodb://u:p@host/db?x=1\n\n  Auth0__Domain = example.test  \n"

    assert lte.parse(text) == [
        ("MongoDB__ConnectionString", "mongodb://u:p@host/db?x=1"),
        ("Auth0__Domain", "example.test"),
    ]


def test_parse_reads_crlf_text():
    assert lte.parse("A=1\r\nB=2\r\n") == [("A", "1"), ("B", "2")]


@pytest.mark.parametrize("line", ["no-separator", "=value", "1BAD=value", "has space=value", "a-b=value"])
def test_parse_rejects_a_line_that_isnt_name_value(line):
    with pytest.raises(ValueError, match="line 2 isn't NAME=value"):
        lte.parse(f"OK=1\n{line}\n")


@pytest.mark.parametrize("name", ["GITHUB_TOKEN", "RUNNER_TEMP"])
def test_parse_rejects_reserved_names(name):
    with pytest.raises(ValueError, match="reserved"):
        lte.parse(f"{name}=x")


def test_parse_accepts_lowercase_names_that_only_look_reserved():
    # Linux names are distinct by case, and the runner blocks no prefix.
    assert lte.parse("github_client_id=x\nrunner_name=y") == [("github_client_id", "x"), ("runner_name", "y")]


@pytest.mark.parametrize("name", ["NODE_OPTIONS", "node_options"])
def test_parse_rejects_node_options_the_runner_wont_export(name):
    with pytest.raises(ValueError, match="line 1 sets NODE_OPTIONS"):
        lte.parse(f"{name}=--max-old-space-size=4096")


def test_main_masks_each_value_before_exporting_it(tmp_path):
    status, output, log = run(tmp_path, "A=secret-one\nB=secret-two\n")

    assert status == 0
    assert output == "A=secret-one\nB=secret-two\n"
    assert "::add-mask::secret-one" in log
    assert "::add-mask::secret-two" in log
    assert "Exported 2 test secrets: A, B" in log


def test_escape_data_encodes_what_the_runner_decodes():
    assert lte.escape_data("a%25b%c\rd\ne") == "a%2525b%25c%0Dd%0Ae"


def test_main_escapes_a_value_before_masking_it(tmp_path):
    # The runner percent-decodes "::add-mask::" data, so "%25" must reach it as "%2525".
    status, output, log = run(tmp_path, "TOKEN=abc%25def\n")

    assert status == 0
    assert "::add-mask::abc%2525def" in log
    assert output == "TOKEN=abc%25def\n"


def test_main_doesnt_mask_an_empty_value(tmp_path):
    # "::add-mask::" with nothing after it would be a malformed command.
    status, output, log = run(tmp_path, "EMPTY=\n")

    assert status == 0
    assert output == "EMPTY=\n"
    assert "add-mask" not in log


@pytest.mark.parametrize("test_env", [None, "", "\n# only a comment\n"])
def test_main_exports_nothing_without_a_secret(tmp_path, test_env):
    status, output, log = run(tmp_path, test_env)

    assert status == 0
    assert output == ""
    assert "No TEST_ENV secret" in log


def test_main_fails_on_a_malformed_secret_without_printing_values(tmp_path):
    status, output, log = run(tmp_path, "A=hunter2\nnot a pair hunter3\n")

    assert status == 1
    assert output == ""
    assert "line 2" in log
    assert "hunter2" not in log and "hunter3" not in log

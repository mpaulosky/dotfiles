"""The two renderers a release post and the docs/README.md copy meet, as test oracles.

GitHub renders Markdown with cmark-gfm; GitHub Pages publishes the posts with
kramdown's GFM parser. Each function renders a list of documents in one call.
"""

import json
import shutil
import subprocess
from html.parser import HTMLParser
from pathlib import Path

import cmarkgfm

# The versions the github-pages gem pins.
KRAMDOWN_GEMS = ("kramdown:2.4.0", "kramdown-parser-gfm:1.1.0")
KRAMDOWN_IMAGE = "repo-ci-baseline-kramdown:2.4.0"
KRAMDOWN_RB = Path(__file__).with_name("kramdown.rb")


def cmark(docs):
    options = cmarkgfm.Options.CMARK_OPT_UNSAFE
    return [cmarkgfm.github_flavored_markdown_to_html(doc, options=options) for doc in docs]


def kramdown_command():
    """A local Ruby with the pinned gems, else a Docker image built with them once."""
    if shutil.which("ruby"):
        probe = subprocess.run(
            ["ruby", "-e", 'gem "kramdown", "2.4.0"; gem "kramdown-parser-gfm", "1.1.0"'],
            capture_output=True,
        )
        if probe.returncode == 0:
            return ["ruby", str(KRAMDOWN_RB)]
    if not shutil.which("docker"):
        raise RuntimeError("kramdown needs Ruby with " + " and ".join(KRAMDOWN_GEMS) + ", or Docker")
    if subprocess.run(["docker", "image", "inspect", KRAMDOWN_IMAGE], capture_output=True).returncode:
        dockerfile = "FROM ruby:3.3-slim\nRUN gem install --no-document " + " ".join(KRAMDOWN_GEMS) + "\n"
        subprocess.run(["docker", "build", "-q", "-t", KRAMDOWN_IMAGE, "-"], input=dockerfile.encode(), check=True)
    return ["docker", "run", "--rm", "-i", "-v", f"{KRAMDOWN_RB}:/kramdown.rb:ro", KRAMDOWN_IMAGE, "ruby", "/kramdown.rb"]


def kramdown(docs):
    result = subprocess.run(kramdown_command(), input=json.dumps(docs), capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


class _Reader(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.text = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and "href" in attrs:
            self.links.append(attrs["href"])
        elif tag == "img" and "src" in attrs:
            self.links.append(attrs["src"])

    def handle_data(self, data):
        self.text.append(data)


def read(html):
    """(links, text) of rendered HTML: every href and src in order, and the visible text."""
    reader = _Reader()
    reader.feed(html)
    return reader.links, "".join(reader.text)

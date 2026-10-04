---
description: 'Documentation and content creation standards'
applyTo: '**/*.md'
---

# Markdown Instructions

`markdownlint-cli2` enforces these rules in CI and in the pre-commit and pre-push hooks, using `.markdownlint-cli2.jsonc`.
Its `ignores` list skips build output and the release blog posts in `docs/blogs/`, which the release workflow generates from PR bodies.

## Structure

- Start each document with one `#` H1 title. Use `##` and `###` below it, in order, without skipping levels.
  If you need H4, consider restructuring. H5 is a strong sign to restructure.
- Files with YAML front matter, such as instruction and skill files, still start their body with an H1.
- Use blank lines to separate headings, lists, code blocks, and paragraphs. Avoid runs of blank lines.

## Content

- **Lists:** Use `-` for bullets and `1.` for numbered lists. Indent nested lists by two spaces.
- **Code blocks:** Use fenced code blocks with a language (`csharp`, `bash`, `text`, and so on).
- **Links:** Use `[descriptive text](url)`. Use relative links for files in this repository, and make sure they resolve.
- **Images:** Use `![alt text](url)` with meaningful alt text.
- **Tables:** Use tables for tabular data, with a header row.
- **Line length:** Keep lines at or under 200 characters. Table rows are exempt because they can't wrap.
  Prefer one sentence or clause per line in long paragraphs.

Blog posts under `docs/blogs/` have extra front-matter rules in `blog.instructions.md`.
The Jekyll pages under `docs/` may carry front matter for the site, instruction files need their `applyTo` header,
skill files need their `name` and `description`, and issue templates under `.github/ISSUE_TEMPLATE/` need theirs for
GitHub's template picker. Other Markdown files have no front matter.

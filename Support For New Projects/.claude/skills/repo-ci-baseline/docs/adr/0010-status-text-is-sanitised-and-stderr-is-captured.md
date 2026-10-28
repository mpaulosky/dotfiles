# Text the status prints is sanitised, and gh and git stderr is captured into the thrown message

**Status:** accepted (mpaulosky/dotfiles#315). Implemented in `template/owned/.sandcastle/lib/status.mts` (`terminalText`, `terminalLine`, `plainStderr`),
`lib/github.mts` (`ghWithStderr`, `readRepoName`) and `lib/host-safety.mts` ([sandcastle.md](../../references/sandcastle.md), "Sandcastle status").

`sandcastle:status` is read-only and prints to a person's terminal, but most of what it prints is written by others: issue and PR titles, branch names, thread
text, and the error text gh and git write. Control characters in it can overwrite or fake a line of the report, and bidi, zero-width and tag characters can hide text.
gh and git also write to the process's stderr themselves when they are run with it inherited, which no later cleaning reaches.

## Considered options

- **Print the text as it is:** rejected. A title with an escape sequence or a line break could rewrite the report.
- **Allow only printable ASCII:** rejected. Titles and names in other scripts and emoji would turn to nothing.
- **Drop every invisible character, joiners too (rejected):** safest, but it breaks emoji sequences and the zero-width non-joiner Persian and the Indic scripts need.
- **Drop the invisible characters, and keep a few joiners where they do their work (chosen).**
- **Let gh and git write their stderr to the terminal:** rejected. It is outside every cleaning step. The reads capture it and put it in the thrown message.

## Decisions

- **`terminalText` is the one way GitHub-derived text reaches the terminal.** Whitespace, a line break too, becomes one space. Control, format (bidi, zero-width, tag),
  default-ignorable, surrogate, noncharacter, filler and supplementary-plane private-use characters are dropped.
- **Three joiners stay where they do their work:** a zero-width joiner between two pictographs (a skin tone or an emoji variation selector may sit in it), that
  variation selector right after a pictograph, and a zero-width non-joiner between two letters of Arabic, Syriac, Thaana or an Indic script. Elsewhere they are dropped,
  and at most eight survive in one text. In the Indic scripts only the non-joiner survives, so Sinhala's "Sri" and Devanagari half-forms lose their joiner, and keycap
  and flag-tag emoji fall apart.
- **What may draw as nothing is capped, not removed:** at most eight private-use (icon glyph) or unassigned code points per text, and no more than three combining marks
  in a row. The limit is honest: a few invisible bits can still ride on one text, and no more.
- **`terminalText` is idempotent**, and `terminalLine` keeps at most eight spaces of indent. `plainStderr` makes `console.error` plain text: its arguments are data (a
  string as it is, an Error as its message, anything else through `inspect`), never a format string.
- **gh and git stderr is captured into the thrown message, never inherited,** on the status's path (`ghWithStderr`, `readRepoName`, `protectHostGit`'s `git config`).
  The entry file prints the message through `terminalText`. The field-built reason applies to every `ghWithStderr` caller in the pipeline, not only the status's.
- **The message is built from fields, never from the command line.** When gh printed nothing, the text after `failed:` says why it stopped from the error's `code`,
  `signal` or `status`. Node's own message holds the whole command line, which quotes titles and branches, and `build.mts` reads what follows `failed:` to tell a
  GitHub server error or a refused workflow push from other failures, so a title like "Internal Server Error" would steer it.

## Consequences

- Text in a script that needs a joiner outside the kept cases loses it, and text that stacks more than three combining marks (Tibetan, Hebrew with niqqud and
  cantillation, some Indic clusters) loses the extras. Both are known costs, noted in the code and in the reference. Whether three is the right number is the owner's call.
- A joiner stays only between assigned pictographs, since the cap on unassigned code points could otherwise drop the pictograph it sat beside and leave it dangling.
- Elsewhere in the pipeline `sh()` and `commentOnIssue` still let stderr through. A follow-up moves them to the same convention.
- A new read on the status's path goes through `ghWithStderr`, and a new line it prints goes through `terminalText` or `terminalLine`.

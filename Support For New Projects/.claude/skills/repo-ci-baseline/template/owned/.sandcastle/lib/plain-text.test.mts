import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPITAL_LOOK_ALIKES, LOOK_ALIKES, plainText, TAG, visibleLetters } from "./plain-text.mts";

describe("visibleLetters", () => {
  for (const [form, text] of [
    ["plain words", "Review notes"],
    ["emphasis and a heading mark", "## Re*view* **notes**"],
    ["a decimal character reference", "Re&#118;iew&#32;notes"],
    ["a hexadecimal character reference", "Re&#x76;iew&#x20;notes"],
    ["a named character reference", "Review&nbsp;notes"],
    ["fullwidth letters", "\uff32\uff45\uff56\uff49\uff45\uff57 \uff4e\uff4f\uff54\uff45\uff53"],
    ["a format character", "Review\u200e\u034f notes"],
  ] as const) {
    it(`reads ${form} as the letters a reader sees`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  // R61: a stray < and > far apart aren't a tag, so what's between them shows.
  for (const [form, text] of [
    ["a stray < and > on other lines", "a < b\n\n## Review notes\n\nc > d"],
    ["a < left open before the heading", "x <\n## Review notes"],
    ["a < before and a > after, in one line", "1 < 2 Review notes 3 > 2"],
  ] as const) {
    it(`reads ${form} without swallowing the words between them`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  // Round 2: GitHub shows a < that isn't a tag, so the words after it count.
  for (const [form, text] of [
    ["a < followed by a letter, then a blank line", "<x\n\n## Review notes\n\ny>"],
    ["a < followed by a letter, then a heading line", "a <b\n## Review notes\n>"],
    ["a < followed by a letter, with a comma inside", "Compare <x Review, notes> here"],
    ["a Markdown autolink", "<https://example.com/Review-notes>"],
    ["a generic type left open", "Result<T Review notes"],
  ] as const) {
    it(`reads ${form} as text`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  // Round 2: a tag inside the phrase mustn't split it, and a tag's own words
  // (names and values) count too, since a raw reader sees them.
  for (const [form, text] of [
    ["an anchor inside the phrase", 'Re<a href="u">view notes</a>'],
    ["a span inside the phrase", 'Rev<span class="x">iew notes'],
    ["a span in a heading", '## <span title="x">Review notes</span>'],
    ["a heading with an id", '<h2 id="notes">Review notes</h2>'],
    ["a < inside a quoted value", '<img alt="<Review notes>" src="x.png">'],
    ["words as valueless attributes", "<x Review notes>"],
    ["a tag open across a line", '<img\n  alt="Review notes">'],
  ] as const) {
    it(`reads ${form} as visible`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  it("reads HTML tags drawn as nothing, as GitHub draws them", () => {
    assert.ok(visibleLetters("<h2>Review <b>notes</b></h2>").split(" ").includes("reviewnotes"));
  });

  it("gives a reading that starts with the phrase for a heading whose tag has attributes", () => {
    assert.ok(visibleLetters('<h2 id="notes" class="x">Review notes</h2>').split(" ").some((reading) => reading.startsWith("reviewnotes")));
  });

  // Round 3: the tag's own name and attributes are words a raw reader sees,
  // and GitHub prints a `<` that isn't a tag, in code or escaped, as text.
  for (const [form, text] of [
    ["a tag-shaped phrase in a code span", "Uses `<Review notes>` here."],
    ["an escaped <", "\\<Review notes>"],
    ["an escaped < in a heading", "## \\<Review notes>"],
    ["a tag-shaped phrase in a fence", "```\n<Review notes>\n```"],
    ["a no-break space inside a tag-shaped phrase", "<Review\u00a0notes>"],
    ["a no-break space after a stray <", "R<eview\u00a0notes> more"],
    ["a closing-tag-shaped phrase", "Review </notes>"],
    ["an image whose alt holds the second word", '## Review <img alt="notes" src="x.png">'],
    ["an image whose alt holds the end of the phrase", 'Rev<img alt="iew notes" src="x.png">'],
    ["two images whose alts hold a word each", '<img alt="Review " src="a"><img alt="notes" src="b">'],
    ["a heading made of an image", '<h2><img alt="Review notes" src="x"></h2>'],
    ["a quoted value that holds a blank line", 'Revie<w _="\n\n">notes'],
    ["a comment that closes at once", "<!--><h2>Review notes</h2><!-- -->"],
    ["a comment that closes at once, with a dash", "<!---><h2>Review notes</h2><!-- -->"],
  ] as const) {
    it(`reads ${form} as visible`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  // Round 3: pins of the tag grammar, which decides the reading with tags
  // drawn as nothing.
  for (const [form, text] of [
    ["a quoted value that holds a >", 'Re<a title="x>y">view notes</a>'],
    ["a tag open across one line ending", 'Re<a\nhref="u">view notes</a>'],
    ["a closing tag inside a word", "Rev</b>iew notes"],
    ["a self-closing tag inside a word", "Rev<br/>iew notes"],
  ] as const) {
    it(`draws ${form} as nothing`, () => {
      assert.ok(visibleLetters(text).split(" ").includes("reviewnotes"), visibleLetters(text));
    });
  }

  // The tag grammar itself (CommonMark's), tested on TAG directly since the
  // other readings of visibleLetters would hide a change to it.
  for (const [form, text] of [
    ["a blank line between attributes", 'Re<a\n\nhref="u">view'],
    ["a blank line holding spaces and a tab", 'Re<a\n \t \nhref="u">view'],
    ["a no-break space between a name and an attribute", 'Re<a\u00a0href="u">view'],
    ["a blank line inside a double-quoted value", '<a _="\n\nx">'],
    ["a blank line inside a single-quoted value", "<a _='\n \nx'>"],
    ["a blank line holding a tab inside a quoted value", '<a _="x\n\t\ny">'],
    ["a name that starts with a digit", "<1a>"],
    ["an autolink", "<https://example.com/x>"],
  ] as const) {
    it(`doesn't take ${form} for a tag`, () => {
      assert.equal(text.match(TAG), null);
    });
  }

  for (const [form, text] of [
    ["a quoted value holding one line ending", '<a title="x\ny">'],
    ["a quoted value holding a >", '<a title="x>y">'],
    ["an unquoted value holding a no-break space", "<a href=x\u00a0y>"],
    ["an unquoted value holding an ideographic space", "<a href=x\u3000y>"],
    ["a form feed between attributes", "<b\f>"],
    ["a vertical tab between attributes", "<b\v>"],
    ["a closing tag", "</b >"],
    ["a self-closing tag", "<br/>"],
  ] as const) {
    it(`takes ${form} for a tag`, () => {
      assert.equal(text.match(TAG)?.[0], text);
    });
  }

  // Round 4: what the browser reads as a tag where CommonMark doesn't, a
  // blockquote's marker, a literal < beside a real tag, a title beside an alt.
  for (const [form, text] of [
    ["an unquoted value with a no-break space", "Re<a href=x\u00a0>view notes</a>"],
    ["an unquoted value with an ideographic space", "Re<a href=x\u3000>view notes</a>"],
    ["an unquoted value with a no-break space inside the tag", "Rev<b title=x\u00a0y>iew notes"],
    ["a form feed inside a tag", "Rev<b\f>iew notes"],
    ["a tag name the browser accepts, in an HTML block", "<div>\nRev<x_>iew notes\n</div>"],
    ["a no-break space inside a tag, in an HTML block", '<div>\nRe<a\u00a0href="u">view notes\n</div>'],
    ["a heading made of a tag the browser accepts", "<h2><x_>Review notes</h2>"],
    ["a real tag and a code span", "Re<b>view</b> `<notes>`"],
    ["a real tag and an escaped <", "Re<b>view</b> \\<notes>"],
    ["a code span and an image's alt", '`<x Review>`<img alt="notes" src="b">'],
    ["a title before an alt", '## Review <img title="x" alt="notes" src="missing.png">'],
    ["a titled span inside the phrase and an alt", 'Re<span title="x">view <img alt="notes" src="x.png">'],
    ["an aria-label inside the phrase", 'Rev<span aria-label="iew notes"></span>'],
    ["a tag open across a blockquote's line", "> Re<b\n> x>view notes"],
    ["a tag with an attribute across a blockquote's line", '> Re<span\n> class="x">view notes'],
    ["a comment closed by --!>", "<!-- x --!><h2>Review notes</h2><!-- -->"],
    ["a declaration-shaped text", "## <! Review notes>"],
    ["a processing-instruction-shaped text", "## <? Review notes >"],
    ["a comment that never closes", "## <!-- Review notes >"],
  ] as const) {
    it(`reads ${form} as the phrase`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  it("doesn't read an attribute whose name only ends in alt as alt text", () => {
    assert.ok(!visibleLetters('Review <img data-alt="notes" src=x>').split(" ").includes("reviewnotes"));
  });

  it("reads a real declaration, CDATA section and processing instruction as hidden", () => {
    assert.equal(visibleLetters("a<!x>b<![CDATA[ hidden ]]>c<?php hidden ?>d"), "abcd");
  });

  // R95's browser reading drops what a browser calls a tag.
  it("reads <div> and a tag a browser accepts as drawing nothing", () => {
    assert.ok(visibleLetters("Re<a\u00a0href=x>view").split(" ").includes("review"));
  });

  // The expected look-alikes, written out here rather than read from the
  // tables, so a wrong letter or a mistyped code point fails.
  const expectedLookAlikes: [string, string][] = [
    ["\u0131", "i"], ["\u0435", "e"], ["\u043e", "o"], ["\u0456", "i"], ["\u0455", "s"], ["\u0433", "r"], ["\u0442", "t"],
    ["\u03b5", "e"], ["\u03bf", "o"], ["\u03bd", "v"], ["\u03b9", "i"], ["\u03c4", "t"], ["\u03c9", "w"],
    ["\u0475", "v"], ["\u051d", "w"], ["\u0578", "n"], ["\u057c", "n"], ["\u0585", "o"],
    ["\u0280", "r"], ["\u1d07", "e"], ["\u1d20", "v"], ["\u026a", "i"], ["\u1d21", "w"], ["\u0274", "n"], ["\u1d0f", "o"], ["\u1d1b", "t"], ["\ua731", "s"],
  ];
  const expectedCapitals: [string, string][] = [
    ["\u0395", "e"], ["\u039d", "n"], ["\u0399", "i"], ["\u039f", "o"], ["\u03a4", "t"],
    ["\u0415", "e"], ["\u041e", "o"], ["\u0422", "t"], ["\u0406", "i"], ["\u0405", "s"], ["\u051c", "w"],
  ];
  it("holds exactly the look-alikes written out in this test", () => {
    assert.deepEqual(Object.entries(LOOK_ALIKES).sort(), [...expectedLookAlikes].sort());
    assert.deepEqual(Object.entries(CAPITAL_LOOK_ALIKES).sort(), [...expectedCapitals].sort());
  });
  for (const [letter, latin] of [...expectedLookAlikes, ...expectedCapitals]) {
    it(`reads U+${letter.codePointAt(0)!.toString(16).padStart(4, "0")} as ${latin}, written out`, () => {
      assert.equal(visibleLetters(letter), latin);
    });
  }

  // Round 2: every look-alike in the tables is read as its letter, capital or not.
  for (const [letter, latin] of Object.entries(LOOK_ALIKES)) {
    it(`reads U+${letter.codePointAt(0)!.toString(16).padStart(4, "0")} as ${latin}`, () => {
      assert.equal(visibleLetters(letter), latin);
    });
  }
  for (const [letter, latin] of Object.entries(CAPITAL_LOOK_ALIKES)) {
    it(`reads capital U+${letter.codePointAt(0)!.toString(16).padStart(4, "0")} as ${latin}`, () => {
      assert.equal(visibleLetters(letter), latin);
    });
  }

  for (const [form, text] of [
    ["Greek capitals", "R\u0395VI\u0395W \u039dOTES"],
    ["Cyrillic capitals", "R\u0415VIEW N\u041eT\u0415\u0405"],
    ["Latin small capitals", "\u0280\u1d07\u1d20\u026a\u1d07\u1d21 \u0274\u1d0f\u1d1b\u1d07\ua731"],
    ["Greek lowercase epsilon", "R\u03b5view notes"],
  ] as const) {
    it(`reads the phrase in ${form}`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  it("doesn't take a Cyrillic or Greek capital that looks like P for an R", () => {
    assert.equal(visibleLetters("\u0420 \u03a1"), "\u0440\u03c1");
  });

  // R62: text in a tag's attributes, which a tooltip or a failed image shows.
  for (const [form, text] of [
    ["a double-quoted alt", '<img alt="Review notes" src="x.png">'],
    ["a single-quoted title", "<a title='Review notes'>x</a>"],
    ["an unquoted value", "<p title=reviewnotes>x</p>"],
    ["an image's alt text", "![Review notes](x.png)"],
    ["a link's title", '[x](https://example.com "Review notes")'],
  ] as const) {
    it(`reads ${form} as visible`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  // R63: letters that draw nothing, and one that lowercases to two characters.
  for (const [form, text] of [
    ["a Hangul filler", "Review\u3164notes"],
    ["a halfwidth Hangul filler", "Review\uffa0 notes"],
    ["Hangul choseong and jungseong fillers", "Rev\u115f\u1160iew notes"],
    ["a dotted capital I", "Rev\u0130ew notes"],
    ["a dotless i", "Rev\u0131ew notes"],
  ] as const) {
    it(`reads ${form} as the letters a reader sees`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  // R64: HTML decodes a numeric reference with no semicolon.
  for (const [form, text] of [
    ["a decimal reference without a semicolon", "Review&#32notes"],
    ["a hexadecimal reference without a semicolon", "Re&#x76iew notes"],
    ["a reference ending the line", "Review notes&#33"],
  ] as const) {
    it(`reads ${form} as the letters a reader sees`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  // R65: letters of the phrase drawn by another script's look-alike.
  for (const [form, text] of [
    ["Cyrillic e and o", "R\u0435view n\u043et\u0435s"],
    ["Cyrillic i and s", "Rev\u0456ew note\u0455"],
    ["Greek omicron and nu", "Re\u03bdiew n\u03bfte\u0073"],
    ["Armenian n", "Review \u0578otes"],
  ] as const) {
    it(`reads ${form} as the Latin letters they look like`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  it("reads an HTML comment, which shows nothing, as nothing, even across lines", () => {
    assert.equal(visibleLetters("a<!-- Review\nnotes -->b <?php hidden ?>c"), "abc");
  });

  it("reads nothing as nothing, and markup alone as nothing", () => {
    assert.equal(visibleLetters(""), "");
    assert.equal(visibleLetters("## ** &nbsp; &#33;"), "");
    assert.ok(visibleLetters("<br><hr/>").split(" ").includes(""), "a reading with the tags drawn as nothing is empty");
  });

  it("reads a character reference with leading zeros, and one for a lone surrogate or a NUL, without throwing", () => {
    assert.equal(visibleLetters("&#0118;iew&#0;&#xD800;"), "view");
  });

  it("keeps the letters of any script, since it only reads letters", () => {
    assert.equal(visibleLetters("Überprüfung 検討 Δ"), "überprüfung検討δ");
  });

  it("takes a reference to a code point that doesn't exist for nothing, rather than throw", () => {
    assert.equal(visibleLetters("a&#99999999;b&#x110000;c"), "abc");
  });
});

describe("plainText", () => {
  it("escapes a leading tilde, which would otherwise open a code fence", () => {
    assert.equal(plainText("~~~x"), "\\~~~x");
  });

  it("escapes it after leading whitespace too, and leaves a tilde elsewhere in the line alone", () => {
    assert.equal(plainText("  ~~~x"), "\\~~~x");
    assert.equal(plainText("a ~~~x"), "a ~~~x");
  });
});

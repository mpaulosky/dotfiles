---
name: dotnet-tdd
description: Test-driven development for C#/.NET with xUnit v3. Use when building features or fixing bugs test-first in a .NET codebase, or when the user mentions red-green-refactor.
---

# .NET Test-Driven Development

TDD is the red → green loop, run in **vertical slices**: one test → one minimal
implementation → repeat, each test a **tracer bullet** that responds to what the
last cycle taught you. For depth beyond the loop, use [skill:dotnet-xunit]
(Fact/Theory, fixtures, `IAsyncLifetime`, parallelism, analyzers) and
[skill:dotnet-testing-strategy] (unit vs integration vs E2E, test doubles,
project layout).

## Steps

1. **Learn the vocabulary.** Read `CONTEXT.md` (if it exists) so test names and
   interfaces use the project's domain language, and read the ADRs in the area
   you're touching. Done when you can name the module under test in the
   project's own terms.

2. **Agree the seams.** Write down the seams you intend to test and ask the
   user: "What's the public interface, and which seams should we test?" Done
   when the user has confirmed the list; every test you write sits on a
   confirmed seam. Agreeing up front lands testing effort on critical paths and
   complex logic rather than every edge case. If the interface's shape is itself
   in question (module depth, where the seam belongs, what it should expose),
   call the Skill tool with "codebase-design" and consult it as vocabulary
   reference.

3. **Red.** Write one failing test for one behavior at one seam, then run exactly that test:

   ```bash
   dotnet test --filter "FullyQualifiedName~OrderServiceTests.CalculateTotal_EmptyCart_ReturnsZero"
   ```

   Done when it fails on an **assertion mismatch**: the test correctly describes
   behavior that doesn't exist yet. A compile error or `NullReferenceException`
   is a different signal. If the test project fails to build, add the minimal
   production signature throwing `NotImplementedException` so red comes from the
   assertion, not `csc`.

4. **Green.** Write only enough code to pass this test; leave future cases to future slices. Re-run the same `--filter` command until it passes. Done when the target test is green.

5. **Regression check.** Run `dotnet test` for the whole project (or keep
   `dotnet watch test` running). Done when the full suite is green; this catches
   a slice that passed its own test but broke another seam. Then return to step
   3 for the next slice.

Refactoring (extracting fixtures, reshaping seams, replacing heavy mock setups with fakes) belongs to the review stage after the loop (see the `code-review` skill).

## Seams

A **seam** is the public boundary you test at: the public members of a class or
the contract of an injected interface, where you observe behavior without
reaching inside. Tests verify behavior through seams, so code can change
entirely while tests survive. A good test reads like a specification:
`SubmitOrder_WhenInventoryInsufficient_ReturnsOutOfStockError` says exactly what
capability exists.

See [tests.md](tests.md) for good/bad C# test examples, AAA layout and naming, and [mocking.md](mocking.md) when a test needs a test double.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests
  `private`/`internal` methods (via reflection or `InternalsVisibleTo`), asserts
  on call counts instead of outcomes, or verifies through a side channel
  (querying the database instead of going through the repository interface). The
  tell: the test breaks on a refactor that didn't change behavior.
- **Tautological**: the assertion recomputes the expected value the way the code
  does (`CalculateTotal(items).Should().Be(items.Sum(i => i.Price))`), so it
  passes by construction. Take expected values from an independent source of
  truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk
  tests verify _imagined_ behavior: they test the _shape_ of things, go
  insensitive to real changes, and fix test structure before you understand the
  implementation.
- **Over-mocked boundary**: `Substitute.For<T>()` on a type you own instead of the real thing or a fake.

## xUnit v3 loop tips

- `dotnet watch test --filter "FullyQualifiedName~ClassName"` re-runs on save and keeps the loop inside the class under development.
- Extend a cycle with `[Theory]`/`[InlineData]` rows only for more cases of the _same_ behavior; a new behavior gets a new `[Fact]`.
- Write each slice against a plain instance. Introducing an `IClassFixture`/`ICollectionFixture` for speed or isolation is a refactor for the review stage.

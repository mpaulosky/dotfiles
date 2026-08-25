## Refactor Candidates

After a GREEN TDD cycle, look for:

- **Duplication** → Extract shared mapping, guard, or orchestration logic
- **Long methods** → Break into private helpers (keep tests on the public
  handler/component interface)
- **Shallow modules** → Combine or deepen pass-through wrappers that add no
  leverage
- **Feature envy** → Move lifecycle or validation logic back to the domain
  type or module that owns the data
- **Primitive obsession** → Introduce richer types only when they clarify
  behavior and earn their keep
- **Existing code** the new code reveals as problematic, such as repeated
  configuration lookups, auth token plumbing, or cache invalidation rituals

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLE_AGENTS } from "./repo-config.mts";
import { withUiRole } from "./ui-role-fixture.mts";

const agents: Record<string, unknown> = ROLE_AGENTS;

describe("withUiRole", () => {
  it("gives ROLE_AGENTS a ui entry that copies the backend's, not the backend's own object", async () => {
    await withUiRole(true, () => {
      assert.deepEqual(agents.ui, ROLE_AGENTS.backend);
      assert.notEqual(agents.ui, ROLE_AGENTS.backend);
    });
  });

  it("leaves ROLE_AGENTS without a ui entry when asked to", async () => {
    await withUiRole(false, () => {
      assert.equal("ui" in agents, false);
    });
  });

  it("returns what the callback returns, whether it is sync or async", async () => {
    assert.equal(await withUiRole(true, () => 7), 7);
    assert.equal(await withUiRole(false, async () => "x"), "x");
  });

  it("puts ROLE_AGENTS back as it found it, opted in or out, even when the callback throws", async () => {
    const before = agents.ui;
    for (const enabled of [true, false]) {
      await assert.rejects(
        withUiRole(enabled, () => {
          throw new Error("boom");
        }),
        /boom/,
      );

      assert.equal(agents.ui, before);
      assert.equal("ui" in agents, before !== undefined);
    }
  });

  it("restores a ui entry the repo already had", async () => {
    const before = agents.ui;
    const own = { ...ROLE_AGENTS.backend, maxIterations: 7 };
    agents.ui = own;
    try {
      await withUiRole(false, () => {
        assert.equal("ui" in agents, false);
      });
      assert.equal(agents.ui, own);

      await withUiRole(true, () => {
        assert.notEqual(agents.ui, own);
      });
      assert.equal(agents.ui, own);
    } finally {
      if (before === undefined) delete agents.ui;
      else agents.ui = before;
    }
  });
});

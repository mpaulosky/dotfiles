// Test support for the opt-in ui role (see OptInRole in lib/config.mts): runs a function with the
// repo's `ui` entry in ROLE_AGENTS present or absent, whatever lib/repo-config.mts says, so a test of
// the role doesn't depend on the repo having opted in or out.

import { ROLE_AGENTS } from "./repo-config.mts";

// Runs `run` with ROLE_AGENTS holding a `ui` entry (a copy of the backend's) or none, then puts
// ROLE_AGENTS back as it was, on every path.
export async function withUiRole<T>(enabled: boolean, run: () => T | Promise<T>): Promise<T> {
  const agents: Record<string, unknown> = ROLE_AGENTS;
  const original = agents.ui;
  if (enabled) agents.ui = { ...ROLE_AGENTS.backend };
  else delete agents.ui;
  try {
    return await run();
  } finally {
    if (original === undefined) delete agents.ui;
    else agents.ui = original;
  }
}

import {
  defineSquad,
  defineTeam,
  defineAgent,
} from '@bradygaster/squad-sdk';

/**
 * Squad Configuration — IssueTrackerApp
 * Universe: Lord of the Rings
 */

const aragorn = defineAgent({
  name: 'aragorn',
  role: 'lead',
  description: 'Lead — scope, decisions, code review',
  label: 'squad:aragorn',
  status: 'active',
});

const legolas = defineAgent({
  name: 'legolas',
  role: 'frontend',
  description: 'Frontend Dev — Blazor UI, components, Tailwind',
  label: 'squad:legolas',
  status: 'active',
});

const sam = defineAgent({
  name: 'sam',
  role: 'backend',
  description: 'Backend Dev — APIs, MongoDB, MediatR, domain logic',
  label: 'squad:sam',
  status: 'active',
});

const gimli = defineAgent({
  name: 'gimli',
  role: 'tester',
  description: 'Tester — xUnit, bUnit, architecture tests, quality',
  label: 'squad:gimli',
  status: 'active',
});

const boromir = defineAgent({
  name: 'boromir',
  role: 'devops',
  description: 'DevOps — Aspire, CI/CD, Docker, infrastructure',
  label: 'squad:boromir',
  status: 'active',
});

const frodo = defineAgent({
  name: 'frodo',
  role: 'writer',
  description: 'Tech Writer — docs, README, changelogs',
  label: 'squad:frodo',
  status: 'active',
});

const gandalf = defineAgent({
  name: 'gandalf',
  role: 'security',
  description: 'Security Officer — Auth0, roles, threat review',
  label: 'squad:gandalf',
  status: 'active',
});

const scribe = defineAgent({
  name: 'scribe',
  role: 'scribe',
  description: 'Scribe — memory, decisions, session logs',
  status: 'active',
});

const ralph = defineAgent({
  name: 'ralph',
  role: 'monitor',
  description: 'Work Monitor — backlog, issue queue, keep-alive',
  status: 'active',
});

export default defineSquad({
  version: '1.0.0',
  repo: 'mpaulosky/IssueTrackerApp',

  team: defineTeam({
    name: 'IssueTrackerApp',
    universe: 'Lord of the Rings',
    members: [
      'aragorn', 'legolas', 'sam', 'gimli',
      'boromir', 'frodo', 'gandalf', 'scribe', 'ralph',
    ],
  }),

  agents: [aragorn, legolas, sam, gimli, boromir, frodo, gandalf, scribe, ralph],
});

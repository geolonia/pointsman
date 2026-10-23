// The structure of the documentation site, in one place.
//
// Pages written for the site live in docs/<group>/ (English) and
// docs/ja/<group>/ (Japanese), with their own front matter. The older
// reference files stay where they are (docs/*.md, docs/spikes/*.md): code,
// openapi.yaml, other repositories and GitHub links point at those paths.
// LEGACY gives each one its place on the site; scripts/sync.mjs adds the
// front matter. They are in English only for now: the Japanese site shows
// the English text with a notice until a page is rewritten for both.

/** Where the docs are published on https://pointsman.net (astro.config.mjs `base`, with a trailing slash). */
export const BASE = '/docs/';

/** The sidebar groups, in order. Each lists the pages of docs/<dir>/. */
export const GROUPS = [
  { dir: 'tutorials', en: 'Tutorials', ja: 'チュートリアル' },
  { dir: 'how-to', en: 'How-to guides', ja: 'ハウツーガイド' },
  { dir: 'reference', en: 'Reference', ja: 'リファレンス' },
  { dir: 'explanation', en: 'Explanation', ja: '解説' },
  { dir: 'about', en: 'About', ja: 'このサイトについて' },
  { dir: 'background', en: 'Background', ja: '背景資料', collapsed: true },
];

/**
 * The older files: source path in the repository → slug on the site, the
 * sidebar order in its group, a one-line description, and optionally a
 * shorter label for the sidebar. The title is the file's first heading.
 */
export const LEGACY = {
  'docs/authoring.md': { slug: 'how-to/write-a-profile-with-ai', order: 10, label: 'Write a profile with an AI assistant', description: 'Write a profile with an AI assistant, and check that the rules do what the examples say.' },
  'docs/deployment.md': { slug: 'how-to/deploy', order: 40, label: 'Deploy Pointsman', description: 'Deploy Pointsman to Cloudflare from a private configuration repository.' },

  'docs/profile-format.md': { slug: 'reference/profile-format', order: 10, label: 'Profile format', description: 'Every field of a decision profile: questions, policy, facts, test cases, chains.' },
  'docs/models.md': { slug: 'reference/models', order: 40, description: 'Which AI models answer the questions, and how to configure them.' },
  'docs/decision-log.md': { slug: 'reference/decision-log', order: 60, description: 'What Pointsman stores for each decision, and how feedback and accuracy work.' },
  'docs/reviews.md': { slug: 'reference/reviews', order: 70, description: 'The review queue for decisions a person checks, and signed callbacks.' },
  'docs/mcp.md': { slug: 'reference/mcp', order: 80, description: 'The MCP server: authentication, and how agents make decisions through it.' },
  'docs/github-connector.md': { slug: 'reference/github-connector', order: 90, description: 'The GitHub connector: check runs, actions, apps and settings.' },

  'docs/modules.md': { slug: 'explanation/modules', order: 30, description: 'Fact modules: how the engine gets facts, and how a deployment chooses its modules.' },
  'docs/connectors.md': { slug: 'explanation/connectors', order: 40, description: 'Connectors: how other systems send cases to Pointsman and get the results.' },
  'docs/adapters.md': { slug: 'explanation/adapters', order: 50, label: 'Adapters', description: 'What the engine needs from a runtime, and why the core does not depend on Cloudflare.' },
  'docs/decision-chains.md': { slug: 'explanation/decision-chains', order: 60, label: 'Decision chains', description: 'How a decision builds on earlier decisions.' },

  'docs/fiware-demo.md': { slug: 'background/fiware-demo', order: 10, label: 'FIWARE demo storyboard', description: 'The storyboard of the FIWARE road-closure demo.' },
  'docs/decision-model-standards.md': { slug: 'background/decision-model-standards', order: 20, label: 'Decision record standards', description: 'Existing standards for recording automated decisions, and what Pointsman takes from them.' },
  'docs/data-model/README.md': { slug: 'background/data-model', order: 30, title: 'The Decision data model', description: 'Where the Decision data model is published.' },
  'docs/threat-model-pilot-notes.md': { slug: 'background/threat-model-pilot', order: 40, label: 'Threat-model pilot', description: 'Lessons from the first threat-model run.' },
  'docs/spikes/spatial-facts.md': { slug: 'background/spikes/spatial-facts', order: 50, description: 'Spike: facts from spatial operations for decisions about places.' },
  'docs/spikes/fiware-bridge.md': { slug: 'background/spikes/fiware-bridge', order: 51, description: 'Spike: a bridge between a FIWARE context broker and Pointsman.' },
  'docs/spikes/decision-data-model.md': { slug: 'background/spikes/decision-data-model', order: 52, description: 'Spike: a first draft of the Decision data model.' },
  'docs/spikes/dmn-policy-tables.md': { slug: 'background/spikes/dmn-policy-tables', order: 53, description: 'Spike: DMN decision tables for policies.' },
  'docs/spikes/local-decider.md': { slug: 'background/spikes/local-decider', order: 54, description: 'Spike: a small local decision model through the same adapter.' },
  'docs/spikes/decap-cms.md': { slug: 'background/spikes/decap-cms', order: 55, description: 'Spike: Decap CMS as a profile editor.' },
};

/** The Starlight sidebar: one group per folder, its pages ordered by `sidebar.order`. */
export const sidebar = GROUPS.map((g) => ({
  label: g.en,
  translations: { ja: g.ja },
  collapsed: g.collapsed ?? false,
  items: [{ autogenerate: { directory: g.dir } }],
}));

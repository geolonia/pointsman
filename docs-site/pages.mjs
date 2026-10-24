// The structure of the documentation site, in one place.
//
// Pages written for the site live in docs/<group>/ (English) and
// docs/ja/<group>/ (Japanese), with their own front matter. The older
// reference files stay where they are (docs/*.md, docs/spikes/*.md): code,
// openapi.yaml, other repositories and GitHub links point at those paths.
// LEGACY gives the ones that are pages their place on the site, and
// scripts/sync.mjs adds their front matter; REPO_ONLY lists the others. The
// LEGACY pages are in English only for now: the Japanese site shows the
// English text with a notice until a page is rewritten for both.

/** Where the docs are published on https://pointsman.net (astro.config.mjs `base`, with a trailing slash). */
export const BASE = '/docs/';

/** The sidebar groups, in order. Each lists the pages of docs/<dir>/. */
export const GROUPS = [
  { dir: 'tutorials', en: 'Tutorial', ja: 'チュートリアル' },
  { dir: 'how-to', en: 'How-to guides', ja: 'ハウツーガイド' },
  { dir: 'reference', en: 'Reference', ja: 'リファレンス' },
  { dir: 'explanation', en: 'Explanation', ja: '解説' },
  { dir: 'about', en: 'About', ja: 'このサイトについて' },
];

/**
 * The older files that are pages of the site: source path in the repository
 * → slug on the site, the sidebar order in its group, a one-line
 * description, and optionally a shorter label for the sidebar. The title is
 * the file's first heading.
 */
export const LEGACY = {
  'docs/authoring.md': { slug: 'how-to/write-a-profile-with-ai', order: 10, label: 'Write a profile with an AI assistant', description: 'Write a profile with an AI assistant, and check that the rules do what the examples say.' },
  'docs/deployment.md': { slug: 'how-to/deploy', order: 20, label: 'Deploy Pointsman', description: 'Deploy Pointsman to Cloudflare from a private configuration repository, and rotate its API tokens.' },

  'docs/profile-format.md': { slug: 'reference/profile-format', order: 10, label: 'Profile format', description: 'Every field of a decision profile, with an example: questions, policy, facts, test cases, chains.' },
  'docs/github-connector.md': { slug: 'reference/github-connector', order: 90, description: 'The GitHub connector: check runs, actions, apps and settings.' },
};

/**
 * Files in docs/ that stay in the repository but are not pages of the site:
 * notes for people working on the engine, design notes, plans and spike
 * reports. Code, openapi.yaml and other repositories link to them on GitHub,
 * and the site links them there too.
 */
export const REPO_ONLY = [
  'docs/adapters.md',
  'docs/connectors.md',
  'docs/data-model/README.md',
  'docs/decision-chains.md',
  'docs/decision-log.md',
  'docs/decision-model-standards.md',
  'docs/fiware-demo.md',
  'docs/mcp.md',
  'docs/models.md',
  'docs/modules.md',
  'docs/reviews.md',
  'docs/threat-model-pilot-notes.md',
  'docs/spikes/decap-cms.md',
  'docs/spikes/decision-data-model.md',
  'docs/spikes/dmn-policy-tables.md',
  'docs/spikes/fiware-bridge.md',
  'docs/spikes/local-decider.md',
  'docs/spikes/spatial-facts.md',
];

/**
 * The Starlight sidebar: one group per folder, its pages ordered by
 * `sidebar.order`. Autogenerate includes a folder's own index page
 * (docs/about/index.md) too, so it is not listed again by hand.
 */
export const sidebar = GROUPS.map((g) => ({
  label: g.en,
  translations: { ja: g.ja },
  collapsed: g.collapsed ?? false,
  items: [{ autogenerate: { directory: g.dir } }],
}));

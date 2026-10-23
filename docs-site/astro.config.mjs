// The Pointsman documentation site, published on https://pointsman.net under
// /docs/, next to the landing page in site/ (a Cloudflare Worker with static
// assets: wrangler.jsonc, built and deployed by Cloudflare's GitHub app). The pages come from docs/: scripts/sync.mjs
// copies them into src/content/docs/ (not committed) before each build.
// The sidebar and the slugs of the older reference files are in pages.mjs;
// each page's edit link (editUrl) is set by the sync.

import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';
import { BASE, sidebar } from './pages.mjs';

export default defineConfig({
  site: 'https://pointsman.net',
  base: BASE.replace(/\/$/, ''),
  trailingSlash: 'always',
  // No raster images to optimise; SVGs pass through.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Pointsman',
      description: 'Documentation for Pointsman, the open-source decision service.',
      logo: { light: './src/assets/lockup.svg', dark: './src/assets/lockup-on-dark.svg', replacesTitle: true },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/geolonia/pointsman' }],
      customCss: ['./src/styles/custom.css'],
      sidebar,
      // A link back to the landing page in the header.
      components: { SocialIcons: './src/components/SocialIcons.astro' },
    }),
  ],
});

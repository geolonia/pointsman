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
      customCss: [
        // IBM Plex, served from this site: no request to a font service.
        '@fontsource/ibm-plex-sans/latin-400.css',
        '@fontsource/ibm-plex-sans/latin-500.css',
        '@fontsource/ibm-plex-sans/latin-600.css',
        '@fontsource/ibm-plex-mono/latin-400.css',
        '@fontsource/ibm-plex-mono/latin-600.css',
        './src/styles/custom.css',
      ],
      sidebar,
      // A Home link in the header, and a credit in the footer.
      components: {
        SocialIcons: './src/components/SocialIcons.astro',
        Footer: './src/components/Footer.astro',
      },
    }),
  ],
});

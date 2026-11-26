// Starlight route middleware (astro.config.mjs `routeMiddleware`): each
// page's <head> links its Markdown version, so that AI tools find it without
// a button. scripts/page-markdown.mjs writes the files after the build and
// fails it when a page's link has no file.

import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { SITE, markdownPath } from '../pages.mjs';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  // The 404 page has no Markdown version.
  if (route.entry.id === '404' || !context.url.pathname.endsWith('/')) return;
  route.head.push({
    tag: 'link',
    attrs: { rel: 'alternate', type: 'text/markdown', href: new URL(markdownPath(context.url.pathname), SITE).href },
  });
});

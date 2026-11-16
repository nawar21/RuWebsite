// @ts-check
import { defineConfig } from 'astro/config';

// Two hosts build this repo:
// - Cloudflare Pages (sets CF_PAGES=1) serves the main domain, https://rurobotics.online/.
// - GitHub Pages serves a copy at https://nawar21.github.io/RuWebsite/.
// `site` drives the canonical, Open Graph and JSON-LD URLs. SITE_URL and BASE_PATH override
// either one; Lighthouse CI builds with BASE_PATH=/ so its static server finds every asset.
const onCloudflare = process.env.CF_PAGES === '1';

export default defineConfig({
  site: process.env.SITE_URL ?? (onCloudflare ? 'https://rurobotics.online' : 'https://nawar21.github.io'),
  base: process.env.BASE_PATH ?? (onCloudflare ? '/' : '/RuWebsite'),
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'auto' },
});

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
  // Every page gets a Content Security Policy <meta> tag. Astro hashes its own scripts and
  // styles; everything else may only load from this site. (frame-ancestors is a header: public/_headers.)
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "media-src 'self'",
        "connect-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      // The digital twin compiles MuJoCo's WebAssembly physics engine.
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
    },
  },
  // The digital twin's physics worker imports MuJoCo's ES-module WebAssembly loader, so workers build as ES modules.
  vite: { worker: { format: 'es' } },
});

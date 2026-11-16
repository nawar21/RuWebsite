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
      // three.js (inside model-viewer) instantiates a WebAssembly decoder on load.
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
      // model-viewer's shadow-DOM stylesheet. If you upgrade @google/model-viewer and the browser
      // console reports a blocked inline style, replace this with the hash it prints.
      styleDirective: { hashes: ['sha256-PXtZZkJMMyc18o/DN1ZEFOJ2qEGq95IQbVaJFMOXOb0='] },
    },
  },
});

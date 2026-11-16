// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages serves this repo at https://nawar21.github.io/RuWebsite/.
// Lighthouse CI builds with BASE_PATH=/ so its static server finds every asset.
export default defineConfig({
  site: 'https://nawar21.github.io',
  base: process.env.BASE_PATH ?? '/RuWebsite',
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'auto' },
});

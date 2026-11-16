import type { APIRoute } from 'astro';
import { asset } from '../lib/url';

// Indexable pages. Add new pages here; the 404 page stays out.
const PAGES = [
  { path: '', changefreq: 'monthly', priority: '1.0' },
  { path: 'privacy/', changefreq: 'yearly', priority: '0.3' },
  { path: 'terms/', changefreq: 'yearly', priority: '0.3' },
  { path: 'accessibility/', changefreq: 'yearly', priority: '0.3' },
];

export const GET: APIRoute = ({ site }) => {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = PAGES.map(
    (p) =>
      `  <url><loc>${new URL(asset(p.path), site).href}</loc><lastmod>${lastmod}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`,
  ).join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
};

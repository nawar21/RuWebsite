import type { APIRoute } from 'astro';
import { asset } from '../lib/url';

// Absolute sitemap URL for whichever host built this copy (rurobotics.online or GitHub Pages).
export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL(asset('sitemap.xml'), site).href}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

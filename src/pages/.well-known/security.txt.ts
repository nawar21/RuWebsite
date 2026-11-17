import type { APIRoute } from 'astro';
import { SITE } from '../../data/site';

// RFC 9116 security contact. The address comes from SITE.email; renew Expires before it passes.
const CANONICAL = 'https://rurobotics.online';

export const GET: APIRoute = () =>
  new Response(
    [
      '# RuRobotics security contact (RFC 9116)',
      '# If you find a security issue on this website, please tell us privately before publishing it.',
      `Contact: mailto:${SITE.email}`,
      'Expires: 2027-11-16T00:00:00.000Z',
      'Preferred-Languages: en, he, ar',
      `Canonical: ${CANONICAL}/.well-known/security.txt`,
      `Policy: ${CANONICAL}/privacy/#security`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );

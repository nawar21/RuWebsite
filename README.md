# RuWebsite

The RuRobotics marketing site, built with [Astro](https://astro.build). It lives at
<https://rurobotics.online/> (Cloudflare Pages), with a copy at <https://nawar21.github.io/RuWebsite/> (GitHub Pages).

## Run it

```bash
npm install
npm run dev        # http://localhost:4321/RuWebsite/
npm run build      # static site in dist/
npm run lhci       # Lighthouse audit (build with BASE_PATH=/ first)
```

## Where things live

| What | Where |
| --- | --- |
| Copy: team, customers, pricing, NYC facts, steps | `src/data/site.ts` |
| Page sections | `src/components/*.astro`, assembled in `src/pages/index.astro` |
| Head, SEO, Open Graph, JSON-LD | `src/layouts/Base.astro` |
| Styles | `src/styles/global.css` |
| Scroll motion (Lenis + GSAP) | `src/scripts/motion.ts` |
| Photos (auto-resized to WebP at build) | `src/assets/photos/` |
| Logos, favicons, video, 3D model | `public/` |
| Privacy, terms, accessibility, 404 | `src/pages/*.astro` (shell: `src/layouts/Page.astro`, `src/components/LegalPage.astro`) |
| robots.txt, sitemap.xml, security.txt | `src/pages/robots.txt.ts`, `src/pages/sitemap.xml.ts`, `src/pages/.well-known/security.txt.ts` |
| Footer legal links | `LEGAL` in `src/data/site.ts` |

## Privacy and security

- **No third-party requests.** Inter is self-hosted (`src/assets/fonts/`, SIL OFL); Apple devices use San Francisco and never download it. Keep it that way, because the privacy policy promises it.
- **Content Security Policy.** `security.csp` in `astro.config.mjs` writes a CSP `<meta>` into every page. Astro hashes its own scripts; anything else must come from this site. Don't add inline `style="..."` attributes or third-party scripts. If you upgrade `@google/model-viewer` and the console reports a blocked inline style, put the hash it prints into `styleDirective.hashes`.
- **Headers on Cloudflare.** `public/_headers` adds HSTS, `frame-ancestors 'none'`, a Permissions-Policy and long caching for `/_astro/*`.
- **security.txt** expires on 16 November 2027. Renew the `Expires` line in `src/pages/.well-known/security.txt.ts` before then.
- If you change what the site collects or who hosts it, update `src/pages/privacy.astro` and its dates.

## Tools

| Tool | What it does here |
| --- | --- |
| [Astro](https://github.com/withastro/astro) | Components, a single data file for content, and build-time image optimization (photos ship as resized WebP). |
| [GSAP + ScrollTrigger](https://github.com/greensock/GSAP) | Staggered reveals, hero push-in, the "How it works" loop that lights up the step being read, active nav link. |
| [Lenis](https://github.com/darkroomengineering/lenis) | Smooth scrolling and offset-aware anchor links, driven by the GSAP ticker. |
| [model-viewer](https://github.com/google/model-viewer) | The interactive, animated UR5e in the Digital twin section. Loaded only when the section nears the screen. |
| [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) | `.github/workflows/lighthouse.yml` audits every PR; accessibility or SEO below 95 fails the check. |

All motion is skipped for visitors who prefer reduced motion.

## The 3D robot

`public/models/ur5e.glb` is generated from the UR5e in
[MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie) (BSD-3-Clause, see
`public/models/LICENSE-ur5e.txt`). To rebuild it, for example after changing the motion keyframes:

```bash
pip install trimesh numpy scipy fast-simplification pygltflib
python scripts/build_ur5e_glb.py path/to/mujoco_menagerie/universal_robots_ur5e
```

## Deploying

Both hosts rebuild on every push to `main`. `astro.config.mjs` picks the URL and base path for each.

- **Cloudflare Pages** (project `rurobotics`, serves rurobotics.online): build command `npm run build`,
  output directory `dist`. Cloudflare sets `CF_PAGES=1`, so the build uses `https://rurobotics.online` and base `/`.
  Every branch also gets a preview at `<branch>.rurobotics.pages.dev`.
- **GitHub Pages**: `.github/workflows/deploy.yml` builds with base `/RuWebsite` and publishes `dist/`.
  It needs **Settings → Pages → Source** set to **GitHub Actions**.

`SITE_URL` and `BASE_PATH` override either default. Node is pinned to 24 in `.node-version`.

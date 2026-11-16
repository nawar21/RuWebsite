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

## Tools

| Tool | What it does here |
| --- | --- |
| [Astro](https://github.com/withastro/astro) | Components, a single data file for content, and build-time image optimization (photos ship as resized WebP). |
| [GSAP + ScrollTrigger](https://github.com/greensock/GSAP) | Staggered reveals, hero push-in, the "How it works" loop that lights up the step being read, active nav link. |
| [Lenis](https://github.com/darkroomengineering/lenis) | Smooth scrolling and offset-aware anchor links, driven by the GSAP ticker. |
| [three.js](https://github.com/mrdoob/three.js) | The Digital twin: a simulated palletizing cell where a UR5e meets ten scripted edge cases (`src/scripts/twin/`). Loaded only when the section nears the screen. |
| [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) | `.github/workflows/lighthouse.yml` audits every PR; accessibility or SEO below 95 fails the check. |

All motion is skipped for visitors who prefer reduced motion.

## The 3D robot

`public/models/ur5e.glb` is generated from the UR5e in
[MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie) (BSD-3-Clause, see
`public/models/LICENSE-ur5e.txt`). The twin poses its joints itself (`src/scripts/twin/kinematics.ts` has the
forward kinematics and IK), so the clip baked into the file is unused. To rebuild the model:

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

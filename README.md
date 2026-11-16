# RuWebsite

The RuRobotics marketing site, built with [Astro](https://astro.build) and deployed to GitHub Pages at
<https://nawar21.github.io/RuWebsite/>.

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

`.github/workflows/deploy.yml` builds and publishes on every push to `main`. It needs
**Settings → Pages → Source** set to **GitHub Actions** (the old site deployed straight from the branch root).

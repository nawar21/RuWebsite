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
- **Content Security Policy.** `security.csp` in `astro.config.mjs` writes a CSP `<meta>` into every page. Astro hashes its own scripts; anything else must come from this site. Don't add inline `style="..."` attributes or third-party scripts. `'wasm-unsafe-eval'` is there for the twin's MuJoCo WebAssembly. If a library ever injects a `<style>` and the console reports it blocked, put the hash the console prints into `styleDirective.hashes`.
- **Headers on Cloudflare.** `public/_headers` adds HSTS, `frame-ancestors 'none'`, a Permissions-Policy and long caching for `/_astro/*`.
- **security.txt** expires on 16 November 2027. Renew the `Expires` line in `src/pages/.well-known/security.txt.ts` before then.
- If you change what the site collects or who hosts it, update `src/pages/privacy.astro` and its dates.

## Tools

| Tool | What it does here |
| --- | --- |
| [Astro](https://github.com/withastro/astro) | Components, a single data file for content, and build-time image optimization (photos ship as resized WebP). |
| [GSAP + ScrollTrigger](https://github.com/greensock/GSAP) | Staggered reveals, hero push-in, the "How it works" loop that lights up the step being read, active nav link. |
| [Lenis](https://github.com/darkroomengineering/lenis) | Smooth scrolling and offset-aware anchor links, driven by the GSAP ticker. |
| [three.js](https://github.com/mrdoob/three.js) | Renders the Digital twin: a palletizing cell where a UR5e meets ten scripted edge cases (`src/scripts/twin/`). Loaded only when the section nears the screen. |
| [MuJoCo](https://github.com/google-deepmind/mujoco) (`@mujoco/mujoco`, WebAssembly) | The twin's physics at 500 Hz in a Web Worker (`physics.worker.ts`): the UR5e's servos and inertias from Menagerie, a weld-based vacuum grip, cartons with mass and friction, a friction-limited belt drive. `mjcf.ts` builds the model, `sim.ts` is the cell controller. |
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

## The UR5e clip

The looping clip under "The solution" (`public/assets/ur5e-line.mp4`, poster in `src/assets/renders/ur5e-line-poster.jpg`)
is a render, and the page says so. `scripts/ur5-clip/` rebuilds it:

- `scene.py` builds the cell in Blender (the UR5e from `public/models/ur5e.glb` on a pedestal, an infeed conveyor,
  a pallet on a lift table, a factory hall) and animates two pick-and-place cycles with the IK in `kin.py`.
  The camera is handheld: drift, jitter, a slow step and an autofocus hunt at the start.
- `audio.py` synthesizes the sound from the motion plan: hall tone, conveyor, servo whine that follows joint
  speed, the vacuum ejector and blow-off, a phone microphone's high-pass and AGC.
- `post.sh` adds the phone look: noise smeared by temporal noise reduction, exposure breathing, bloom,
  vignette, colour fringing, over-sharpening and two rounds of compression.

```bash
cd scripts/ur5-clip
BLENDER=/Applications/Blender.app/Contents/MacOS/Blender      # Blender 5.2; about 8 s a frame on an M5
$BLENDER -b --factory-startup -P scene.py -- anim 0 100 32    # out/frames/f_0001..0285.png + out/events.json
python3 audio.py out/events.json out/floor.wav                # needs numpy
./post.sh out/frames out/floor.wav ../../public/assets/ur5e-line.mp4
```

## Deploying

Both hosts rebuild on every push to `main`. `astro.config.mjs` picks the URL and base path for each.

- **Cloudflare Pages** (project `rurobotics`, serves rurobotics.online): build command `npm run build`,
  output directory `dist`. Cloudflare sets `CF_PAGES=1`, so the build uses `https://rurobotics.online` and base `/`.
  Every branch also gets a preview at `<branch>.rurobotics.pages.dev`.
- **GitHub Pages**: `.github/workflows/deploy.yml` builds with base `/RuWebsite` and publishes `dist/`.
  It needs **Settings → Pages → Source** set to **GitHub Actions**.

`SITE_URL` and `BASE_PATH` override either default. Node is pinned to 24 in `.node-version`.

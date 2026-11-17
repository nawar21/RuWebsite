// Scroll motion: Lenis smooth scrolling driven by the GSAP ticker, ScrollTrigger reveals,
// a scroll-linked "how it works" loop, and the active nav link. Everything is skipped
// when the visitor prefers reduced motion, and the page reads fine without this script.
import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const reveals = gsap.utils.toArray<HTMLElement>('.reveal');
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const navOffset = () => (document.querySelector<HTMLElement>('.nav')?.offsetHeight ?? 60) + 12;

if (reduce) {
  reveals.forEach((el) => el.classList.add('is-visible'));
} else {
  gsap.registerPlugin(ScrollTrigger);
  document.documentElement.classList.add('has-motion');

  // --- Lenis smooth scroll, ticking with GSAP so ScrollTrigger stays in sync
  const lenis = new Lenis({ autoRaf: false, anchors: { offset: -navOffset() }, allowNestedScroll: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  // --- Reveal on scroll, staggered per batch
  ScrollTrigger.batch(reveals, {
    start: 'top 92%',
    once: true,
    onEnter: (batch) =>
      gsap.to(batch, {
        opacity: 1,
        y: 0,
        duration: 0.9,
        ease: 'power3.out',
        stagger: 0.08,
        overwrite: true,
        onComplete() {
          batch.forEach((el) => el.classList.add('is-visible'));
          gsap.set(batch, { clearProps: 'opacity,transform' });
        },
      }),
  });

  // --- Hero photo: slow push-in as you scroll past it
  const heroImg = document.querySelector('[data-hero-media] img');
  if (heroImg) {
    gsap.fromTo(
      heroImg,
      { scale: 1 },
      {
        scale: 1.08,
        yPercent: 4,
        ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
      },
    );
  }

  // --- How it works: the step in the middle of the screen lights up its node on the loop
  const steps = gsap.utils.toArray<HTMLElement>('[data-step]');
  const nodes = gsap.utils.toArray<SVGGElement>('[data-loop-node]');
  const activate = (i: number) => {
    steps.forEach((s, j) => s.classList.toggle('is-active', j === i));
    nodes.forEach((n, j) => n.classList.toggle('is-active', j === i));
  };
  steps.forEach((step, i) => {
    ScrollTrigger.create({
      trigger: step,
      start: 'top 60%',
      end: 'bottom 40%',
      onToggle: (self) => self.isActive && activate(i),
    });
  });

  // --- Highlight the nav link for the section on screen
  const links = gsap.utils.toArray<HTMLAnchorElement>('[data-nav]');
  // On phones the link row scrolls sideways: keep the active link centered in it.
  const revealInNav = (link: HTMLElement) => {
    const row = link.closest('nav');
    if (!row || row.scrollWidth <= row.clientWidth) return;
    const r = link.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    row.scrollTo({ left: row.scrollLeft + r.left - box.left - (box.width - r.width) / 2, behavior: 'smooth' });
  };
  links.forEach((link) => {
    const section = document.getElementById(link.dataset.nav!);
    if (!section) return;
    ScrollTrigger.create({
      trigger: section,
      start: 'top 50%',
      end: 'bottom 50%',
      onToggle: (self) => {
        if (!self.isActive) return link.removeAttribute('aria-current');
        links.forEach((l) => l.removeAttribute('aria-current'));
        link.setAttribute('aria-current', 'true');
        revealInNav(link);
      },
    });
  });

  // Images and the 3D viewer change the page height after load.
  window.addEventListener('load', () => ScrollTrigger.refresh());
}

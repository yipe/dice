/// <reference types="vite/client" />
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { ShowChrome } from "../src/chrome";
import { FORMULA_HTML, FORMULA_NARROW_HTML } from "./formula";
import { CAPTIONS as C1, EP1_DURATION, Ep1Dice } from "../src/episodes/Ep1Dice";
import { CAPTIONS as C2, EP2_DURATION, Ep2Pmf } from "../src/episodes/Ep2Pmf";
import { CAPTIONS as C3, EP3_DURATION, Ep3Attack } from "../src/episodes/Ep3Attack";
import { CAPTIONS as C4, EP4_DURATION, Ep4Damage } from "../src/episodes/Ep4Damage";
import { CAPTIONS as C5, EP5_DURATION, Ep5Dpr } from "../src/episodes/Ep5Dpr";
import { CAPTIONS as C6, EP6_DURATION, Ep6Advantage } from "../src/episodes/Ep6Advantage";
import { CAPTIONS as C6B, EP6B_DURATION, Ep6bConvolve } from "../src/episodes/Ep6bConvolve";
import { CAPTIONS as C7, EP7_DURATION, Ep7Five } from "../src/episodes/Ep7Five";
import { CAPTIONS as C8, EP8_DURATION, Ep8Vex } from "../src/episodes/Ep8Vex";
import { CAPTIONS as C9, EP9_DURATION, Ep9Sneak } from "../src/episodes/Ep9Sneak";
import { CAPTIONS as C0, EP0_DURATION, Ep0Prologue } from "../src/episodes/Ep0Prologue";
import { CAPTIONS as C10, EP10_DURATION, Ep10Stun } from "../src/episodes/Ep10Stun";
import { CAPTIONS as C11, EP11_DURATION, Ep11StunFirst } from "../src/episodes/Ep11StunFirst";
import { CAPTIONS as C12, EP12_DURATION, Ep12Compare } from "../src/episodes/Ep12Compare";
import { CAPTIONS as C13, EP13_DURATION, Ep13Finale } from "../src/episodes/Ep13Finale";
// the exact snippets check-snippets.mjs runs and verifies
const CODE = import.meta.glob("../snippets/part*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const code = (n: number | string) => CODE[`../snippets/part${String(n).padStart(2, "0")}.ts`];

type Caption = { from: number; to: number; text: React.ReactNode };
type Part = { label?: string; title: string; lede: string; component: React.FC; duration: number; captions: Caption[]; code: string };

// On the page, captions and the footer live outside the video, so crop the bands they occupy.
const CROP = { top: 150, bottom: 50 };
const STAGE_H = 1080 - CROP.top - CROP.bottom;

const bare = (C: React.FC): React.FC => () => (
  <ShowChrome.Provider value={false}>
    <div style={{ position: "absolute", left: 0, top: -CROP.top, width: 1920, height: 1080, lineHeight: "normal", fontSize: 16 }}>
      <C />
    </div>
  </ShowChrome.Provider>
);

const PARTS: Part[] = [
  { label: "Prologue", title: "One Turn, Lots of Dice", lede: "So… how many possible dice roll combinations do you think one turn can have? Dozens? Hundreds? Thousands? MILLIONS? Let's find out.", component: bare(Ep0Prologue), duration: EP0_DURATION, captions: C0, code: code(0) },
  { title: "Buckets and Odds", lede: "To model damage, we first need a picture of chance. We'll start with a single die and build up to the damage of a crit.", component: bare(Ep1Dice), duration: EP1_DURATION, captions: C1, code: code(1) },
  { title: "Probability", lede: "Counting worked for two dice, but a whole turn has septillions of possible rolls, far too many to count one by one. So instead of counting, we track chances: how likely each result is, from 0% to 100%. Chances can be multiplied and added, and that is all the math the rest of this page needs.", component: bare(Ep2Pmf), duration: EP2_DURATION, captions: C2, code: code(2) },
  { title: "One Attack, Three Outcomes", lede: "Our monk-rogue swings with +7 to hit against Armor Class 15. Which rolls of the d20 hit, and which miss?", component: bare(Ep3Attack), duration: EP3_DURATION, captions: C3, code: code(3) },
  { title: "Turning Hits into Damage", lede: "Now we connect the two: the attack roll from Part 3, and the damage buckets from Parts 1 and 2.", component: bare(Ep4Damage), duration: EP4_DURATION, captions: C4, code: code(4) },
  { title: "The Average: Damage per Round", lede: "To compare builds, we need one number per attack: its average damage, or DPR. Then we change the target's AC and watch that number move.", component: bare(Ep5Dpr), duration: EP5_DURATION, captions: C5, code: code(5) },
  { title: "Advantage: Roll Twice, Keep the Higher", lede: "So far every attack has been a straight roll. But our monk-rogue will often roll with advantage, so let's see exactly how much it helps.", component: bare(Ep6Advantage), duration: EP6_DURATION, captions: C6, code: code(6) },
  { title: "Combining Attacks: Convolution", lede: "Five attacks are coming, but first: how do just two attacks combine into one chart? That one step, called convolution, is the heart of @yipe/dice.", component: bare(Ep6bConvolve), duration: EP6B_DURATION, captions: C6B, code: code("06b") },
  { title: "Multiple Attacks in a Turn", lede: "Now repeat that convolution for the whole turn. A Monk 5 / Rogue 1 swings five times: two shortswords, a scimitar, and two Unarmed Strikes from Flurry of Blows.", component: bare(Ep7Five), duration: EP7_DURATION, captions: C7, code: code(7) },
  { title: "Vex: Conditional Odds", lede: "Time to add weapon masteries back in, and with them, the attacks stop being independent: what one attack does changes the next one's odds.", component: bare(Ep8Vex), duration: EP8_DURATION, captions: C8, code: code(8) },
  { title: "Sneak Attack: First Hit", lede: "Some features fire only once, on the first hit of a certain kind. Sneak Attack is one. So which attack does it land on, and how often does it land at all?", component: bare(Ep9Sneak), duration: EP9_DURATION, captions: C9, code: code(9) },
  { title: "Stunning Strike: Branching on a Save", lede: "Then there's the monk's Stunning Strike, where one roll splits the turn in two: the target either fails its save or passes it, and each branch plays out differently.", component: bare(Ep10Stun), duration: EP10_DURATION, captions: C10, code: code(10) },
  { title: "Order Matters: Stun First", lede: "Does the order of attacks matter? Same five attacks, shuffled.", component: bare(Ep11StunFirst), duration: EP11_DURATION, captions: C11, code: code(11) },
  { title: "Comparing Turns", lede: "Four ways to play the same turn, side by side. Then we look at how much a single turn can swing.", component: bare(Ep12Compare), duration: EP12_DURATION, captions: C12, code: code(12) },
  { label: "Finale", title: "Folding It All into One Number", lede: "We started with a tree of paths far too big to count. Now we have every tool we need to fold it into one number.", component: bare(Ep13Finale), duration: EP13_DURATION, captions: C13, code: code(13) },
];

// Terms a reader can hover (or focus, or tap) for a short definition.
// Math terms a reader can hover (or focus, or tap) for a short definition. Keys are lowercase; matching ignores case.
const TERMS: Record<string, string> = {
  pmf: "Probability mass function: a list of every possible result, each paired with its chance. The chances always add up to 100%. Every dice expression in @yipe/dice becomes one.",
  bucket: "A bucket collects every outcome that gives the same result. Its size is how likely that result is: the ways to land in it, out of all the equally likely ways.",
  buckets: "A bucket collects every outcome that gives the same result. Its size is how likely that result is: the ways to land in it, out of all the equally likely ways.",
  distribution: "Every possible result and how likely each one is, usually drawn as bars. A PMF is one.",
  "equally likely": "Every outcome has the same chance, like each face of a fair die.",
  mean: "The average result: multiply each result by its chance, then add them all up. For 2d8\u00a0+\u00a04 it is 13.",
  "expected value": "Another name for the mean: what you would average if you rolled forever.",
  "balance point": "Where the chart would balance on a fingertip. It always sits at the mean.",
  weighted: "Counted in proportion to its chance: a 60% outcome counts twelve times as much as a 5% one.",
  dpr: "Damage per round: the mean of your damage over a whole turn, with misses counted as 0.",
  provenance: "Where a bucket's chance came from: which outcomes (miss, hit or crit) poured into it, and how much each.",
  convolution: "Combining two independent rolls into the chances of their total: multiply the chances of every pair, then add them up by total. In @yipe/dice it is convolve.",
  independent: "Two rolls are independent when neither can change the other's chances. Then their averages simply add.",
  "first hit": "In probability this is called first success: which try succeeds first, and how often none do. Sneak Attack rides on the first weapon hit: 65% on the first shortsword, 22.75% on the second, 7.96% on the scimitar, and 4.29% of turns never hit. In @yipe/dice it is onFirstHit.",
  "conditional odds": "The chance of something, given that something else already happened. On its own, the second shortsword hits 65% of the time. Given that the first one hit, it has advantage and hits 87.75%.",
};
let termId = 0;
const Term: React.FC<{ word: string }> = ({ word }) => {
  const id = useMemo(() => `term-${++termId}`, []);
  const key = word.toLowerCase();
  return (
    <span className="term" tabIndex={0} aria-describedby={id}>
      {word}
      <span className="tip" role="tooltip" id={id}><b>{key === "pmf" || key === "dpr" ? key.toUpperCase() : key}</b> {TERMS[key]}</span>
    </span>
  );
};
// longest first, so "expected value" wins over shorter overlaps
const TERM_RE = new RegExp(`\\b(${Object.keys(TERMS).sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");
/** Wraps the first use of each known term in a string with its definition popover. */
const withTerms = (text: React.ReactNode): React.ReactNode => {
  if (typeof text !== "string") return text;
  const seen = new Set<string>();
  return text.split(TERM_RE).map((part, i) => {
    if (i % 2 === 0 || seen.has(part.toLowerCase())) return part;
    seen.add(part.toLowerCase());
    return <Term key={i} word={part} />;
  });
};

/** Minimal TypeScript colouring: comments, strings, keywords. */
const highlight = (src: string) =>
  src.split(/(\/\/[^\n]*|`[^`]*`|"[^"]*"|\b(?:import|from|const|export)\b)/g).map((tok, i) =>
    tok.startsWith("//") ? <span key={i} className="tc">{tok}</span>
    : /^[`"]/.test(tok) ? <span key={i} className="ts">{tok}</span>
    : /^(import|from|const|export)$/.test(tok) ? <span key={i} className="tk">{tok}</span>
    : tok
  );


const PX_PER_FRAME = 5;
const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const PartSection: React.FC<{ part: Part; index: number }> = ({ part, index }) => {
  const scrollyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const ledeRef = useRef<HTMLDivElement>(null);
  const [hdr, setHdr] = useState(0);

  // the sticky title's height: the pinned stage sits just below it
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHdr(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the intro text fades as it scrolls up under the sticky title
  useEffect(() => {
    const fade = () => {
      const h = headerRef.current, l = ledeRef.current;
      if (!h || !l) return;
      // fully visible until it reaches the title, then fades with how much of it has slid underneath
      const text = (l.firstElementChild ?? l).getBoundingClientRect();
      const left = (text.bottom - h.getBoundingClientRect().bottom) / Math.max(1, text.height);
      l.style.opacity = String(Math.min(1, Math.max(0, left)));
    };
    fade();
    window.addEventListener("scroll", fade, { passive: true });
    return () => window.removeEventListener("scroll", fade);
  }, []);
  const playerRef = useRef<PlayerRef>(null);
  const [near, setNear] = useState(false);
  const [frame, setFrame] = useState(reducedMotion ? part.duration - 1 : 0);
  const frameRef = useRef(frame);

  // mount the player only around the viewport
  useEffect(() => {
    const el = scrollyRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // scroll position -> frame, eased so a flick of the wheel still reads as motion
  useEffect(() => {
    if (!near || reducedMotion) return;
    let raf = 0;
    let current = frameRef.current;
    const tick = () => {
      const el = scrollyRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const travel = r.height - window.innerHeight;
        const p = travel > 0 ? Math.min(1, Math.max(0, -r.top / travel)) : 0;
        const target = p * (part.duration - 1);
        current += (target - current) * 0.22;
        if (Math.abs(target - current) < 0.3) current = target;
        const f = Math.round(current);
        if (f !== frameRef.current) {
          frameRef.current = f;
          setFrame(f);
          playerRef.current?.seekTo(f);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [near, part.duration]);

  const active = part.captions.find((c) => frame >= c.from && frame < c.to) ?? part.captions[part.captions.length - 1];
  const activeIndex = part.captions.indexOf(active);

  const stage = near ? (
    <Player
      ref={playerRef}
      component={part.component}
      durationInFrames={part.duration}
      fps={30}
      compositionWidth={1920}
      compositionHeight={STAGE_H}
      initialFrame={frameRef.current}
      style={{ width: "100%", height: "100%" }}
      controls={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
    />
  ) : null;

  return (
    <section className="part" id={`part-${index + 1}`} aria-labelledby={`part-${index + 1}-title`} style={{ "--hdr": `${hdr}px` } as React.CSSProperties}>
      <header className="intro" ref={headerRef}>
        <p className="eyebrow">{part.label ?? `Part ${PARTS.slice(0, index).filter((p) => !p.label).length + 1} of ${PARTS.filter((p) => !p.label).length}`}</p>
        <h2 id={`part-${index + 1}-title`}>{withTerms(part.title)}</h2>
      </header>
      <div className="part-lede" ref={ledeRef}>
        <p className="lede">{withTerms(part.lede)}</p>
      </div>
      {reducedMotion ? (
        <div className="still" ref={scrollyRef}>
          <div className="stage">{stage}</div>
          <ol className="steps">{part.captions.map((c, i) => <li key={i}>{withTerms(c.text)}</li>)}</ol>
        </div>
      ) : (
        <div className="scrolly" ref={scrollyRef} style={{ height: `calc(${part.duration * PX_PER_FRAME}px + 100svh)` }}>
          <div className="sticky">
            <p className="caption" aria-live="polite" key={activeIndex}>{withTerms(active.text)}</p>
            <div className="stage">{stage}</div>
            <div className="meter" aria-hidden="true">
              {part.captions.map((c, i) => (
                <span key={i} className={i < activeIndex ? "done" : i === activeIndex ? "on" : ""} style={{ flexGrow: c.to - c.from }} />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

// the Prologue sets up the problem before the formula and spreadsheet jokes; the numbered parts come after them
const App: React.FC = () => useMemo(() => <>{PARTS.slice(1).map((p, i) => <PartSection key={i} part={p} index={i + 1} />)}</>, []);

const prologueMount = document.getElementById("prologue");
if (prologueMount) createRoot(prologueMount).render(<PartSection part={PARTS[0]} index={0} />);
const mount = document.getElementById("parts");
if (mount) createRoot(mount).render(<App />);
// the whole turn's code lives in the "Your turn" section after the finale
const outroCode = document.getElementById("outro-code");
// phones get the same code broken onto shorter lines (also checked by check-snippets.mjs), so it fits without scrolling
const NARROW_CODE = CODE["../snippets/part13-narrow.ts"];
// React renders asynchronously, so the code box fits itself once it is actually on the page
const OutroCode: React.FC = () => {
  useLayoutEffect(() => fitAll(), []);
  return (
    <>
      <figcaption>The @yipe/dice code</figcaption>
      <pre className="wide"><code>{highlight(code(13).trim())}</code></pre>
      <pre className="narrow"><code>{highlight(NARROW_CODE.trim())}</code></pre>
    </>
  );
};
if (outroCode) createRoot(outroCode).render(<OutroCode />);
const formula = document.getElementById("formula");
if (formula) formula.innerHTML = `<div class="wide">${FORMULA_HTML}</div><div class="narrow">${FORMULA_NARROW_HTML}</div>`;
// shrink the formula and the outro code until they fit their box, so phones never scroll them sideways
const fit = (box: HTMLElement | null, base: () => number) => {
  if (!box) return;
  box.style.fontSize = "";
  const size = base();
  // text width is not exactly linear in font size, so step down until it fits
  for (let px = size, i = 0; box.scrollWidth > box.clientWidth && i < 6 && px > 8; i++) {
    px = Math.max(8, Math.floor(((px * box.clientWidth) / box.scrollWidth) * 10) / 10 - (i ? 0.2 : 0));
    box.style.fontSize = `${px}px`;
  }
};
const fitAll = () => {
  fit(formula, () => parseFloat(getComputedStyle(formula!).fontSize));
  document.querySelectorAll<HTMLElement>("#outro-code pre").forEach((pre) => pre.offsetParent && fit(pre, () => parseFloat(getComputedStyle(pre).fontSize)));
};
addEventListener("resize", fitAll);
requestAnimationFrame(() => requestAnimationFrame(fitAll));
document.fonts?.ready.then(fitAll);
// keep each term's popover on screen: it centres under its word, then shifts sideways if that would cross an edge
const placeTip = (e: Event) => {
  const term = (e.target as Element | null)?.closest?.(".term") as HTMLElement | null;
  const tip = term?.querySelector<HTMLElement>(".tip");
  if (!term || !tip) return;
  // the page's sections clip sideways overflow, so stay inside the section as well as the screen
  const box = term.closest("#parts, #prologue, .hero, .joke, .outro")?.getBoundingClientRect();
  const lo = Math.max(8, (box?.left ?? 0) + 4), hi = Math.min(innerWidth - 8, (box?.right ?? innerWidth) - 4);
  const r = term.getBoundingClientRect(), w = tip.offsetWidth;
  const left = r.left + r.width / 2 - w / 2;
  const dx = Math.max(lo - left, 0) + Math.min(hi - (left + w), 0);
  tip.style.setProperty("--tip-dx", `${Math.round(dx)}px`);
};
addEventListener("pointerover", placeTip, { passive: true });
addEventListener("focusin", placeTip);
// stamp "Just kidding" over the formula once most of it is on screen
const formulaWrap = document.getElementById("formula-wrap");
const jokeTrack = document.getElementById("joke-track");
if (formulaWrap && jokeTrack) {
  // the formula is pinned while its track scrolls by: stamp once the reader has scrolled 15vh past the pin point,
  // and lift it again when they scroll back above that point, so it replays like the other scroll effects
  const check = () => formulaWrap.classList.toggle("stamped", -jokeTrack.getBoundingClientRect().top >= innerHeight * 0.15);
  addEventListener("scroll", check, { passive: true });
  check();
}

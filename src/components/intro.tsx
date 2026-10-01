"use client";

import { useEffect, useState } from "react";

import { ArrivexMark, ArrivexWordmark } from "@/components/brand";

export const INTRO_FLAG = "arrivex:intro";

/** Brief (~1s) opening sequence shown once after a successful sign-in. */
export function Intro() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (sessionStorage.getItem(INTRO_FLAG) !== "1") return;
    sessionStorage.removeItem(INTRO_FLAG);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setShow(true);
    const t = setTimeout(() => setShow(false), reduced ? 350 : 1100);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="intro-overlay fixed inset-0 z-[100] flex flex-col items-center justify-center bg-ink text-accent-ink" role="status" aria-label="Opening Arrivex">
      <div className="intro-mark"><ArrivexMark size={64} /></div>
      <ArrivexWordmark className="intro-word mt-5 text-2xl" />
      <p className="intro-tag mt-2 text-sm opacity-70">Inspect every arrival.</p>
    </div>
  );
}

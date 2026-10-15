// Site-wide constants and links.
export const SITE_NAME = "Options Lab";
export const AUTHOR_URL = "https://alejandrorodriguez.dev/";

// The tool is a section of Market Hub: an underlying here links to the same company in the
// portal and in Fundamentals Lab.
const site = (v: string | undefined, fallback: string) => (v ?? fallback).replace(/\/$/, "");
export const HUB_URL = site(import.meta.env.PUBLIC_HUB_URL, "https://themarkethub.app");
export const FUNDAMENTALS_URL = site(import.meta.env.PUBLIC_FUNDAMENTALS_URL, "https://fundamentals.themarkethub.app");
export const RADAR_URL = site(import.meta.env.PUBLIC_RADAR_URL, "https://radar.themarkethub.app");
export const PEERS_URL = site(import.meta.env.PUBLIC_PEERS_URL, "https://peers.themarkethub.app");
export const PLAYGROUND_URL = site(import.meta.env.PUBLIC_PLAYGROUND_URL, "https://playground.themarkethub.app");
export const hubQuoteUrl = (ticker: string) => `${HUB_URL}/quote/?t=${encodeURIComponent(ticker)}`;
export const fundamentalsUrl = (ticker: string) => `${FUNDAMENTALS_URL}/stock/?t=${encodeURIComponent(ticker)}`;

// Every internal link goes through here, so the site works under a sub-path too.
export function link(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${path}`;
}

// The API lives on the same origin in production; in development it is another port.
export const API = (import.meta.env.PUBLIC_API_URL ?? "").replace(/\/$/, "");

// A chain by its address: /?t=AAPL&e=2026-11-20.
export const chainUrl = (ticker?: string | null, expiry?: string | null) => {
  const q = new URLSearchParams();
  if (ticker) q.set("t", ticker);
  if (expiry) q.set("e", expiry);
  const s = q.toString();
  return s ? `${link("/")}?${s}` : link("/");
};
export const strategyUrl = (ticker?: string | null) => (ticker ? `${link("/strategy/")}?t=${encodeURIComponent(ticker)}` : link("/strategy/"));

// GET or send JSON to the API. A failed answer throws its own words (the API never puts a
// provider's error in them).
export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    signal: init?.signal,
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let detail = "Something went wrong. Try again in a minute.";
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

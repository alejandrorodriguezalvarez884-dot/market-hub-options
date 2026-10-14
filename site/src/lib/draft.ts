// The strategy being built, kept in this browser between the chain and the builder (and across
// visits). Only a convenience: the strategies a user keeps are saved through the API.
import type { Leg } from "./types";

const KEY = "optionslab.draft";
export type Draft = { ticker: string; legs: Leg[]; id?: string; name?: string };

export function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEY);
    const d = raw ? (JSON.parse(raw) as Draft) : null;
    return d && typeof d.ticker === "string" && Array.isArray(d.legs) ? d : null;
  } catch {
    return null;
  }
}

export function writeDraft(d: Draft | null): void {
  try {
    if (d) localStorage.setItem(KEY, JSON.stringify(d));
    else localStorage.removeItem(KEY);
  } catch {}
}

// A leg from the chain joins the draft of the same ticker, or starts a new one.
export function addToDraft(ticker: string, leg: Leg): void {
  const d = readDraft();
  const legs = d && d.ticker === ticker ? d.legs : [];
  writeDraft({ ticker, legs: [...legs, leg].slice(-8), id: d?.ticker === ticker ? d.id : undefined, name: d?.ticker === ticker ? d.name : undefined });
}

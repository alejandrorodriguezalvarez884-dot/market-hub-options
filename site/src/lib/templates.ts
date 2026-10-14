// The usual shapes of a strategy, laid on the strikes of one expiration around the price. A starting
// point the visitor then changes: the list is alphabetical within each group, and none comes first.
import type { Leg } from "./types";

export type Ctx = { spot: number; strikes: number[]; expiry: string; later: string | null };
export type Template = { key: string; label: string; group: string; legs: (c: Ctx) => Leg[] | null };

function around(c: Ctx) {
  const s = c.strikes;
  const atm = s.reduce((best, k, i) => (Math.abs(k - c.spot) < Math.abs(s[best] - c.spot) ? i : best), 0);
  const at = (n: number) => s[Math.min(Math.max(atm + n, 0), s.length - 1)];
  return { at };
}

const call = (side: Leg["side"], strike: number, expiry: string, qty = 1): Leg => ({ kind: "call", side, qty, strike, expiry, price: null });
const put = (side: Leg["side"], strike: number, expiry: string, qty = 1): Leg => ({ kind: "put", side, qty, strike, expiry, price: null });
const shares = (side: Leg["side"] = "long"): Leg => ({ kind: "stock", side, qty: 100, price: null });

export const TEMPLATES: Template[] = [
  { key: "long-call", label: "Long call", group: "One option", legs: (c) => [call("long", around(c).at(0), c.expiry)] },
  { key: "long-put", label: "Long put", group: "One option", legs: (c) => [put("long", around(c).at(0), c.expiry)] },
  { key: "short-call", label: "Short call", group: "One option", legs: (c) => [call("short", around(c).at(2), c.expiry)] },
  { key: "short-put", label: "Short put", group: "One option", legs: (c) => [put("short", around(c).at(-2), c.expiry)] },

  { key: "collar", label: "Collar", group: "With shares", legs: (c) => [shares(), put("long", around(c).at(-2), c.expiry), call("short", around(c).at(2), c.expiry)] },
  { key: "covered-call", label: "Covered call", group: "With shares", legs: (c) => [shares(), call("short", around(c).at(2), c.expiry)] },
  { key: "protective-put", label: "Protective put", group: "With shares", legs: (c) => [shares(), put("long", around(c).at(-2), c.expiry)] },

  { key: "bear-call", label: "Bear call spread", group: "Spreads", legs: (c) => [call("short", around(c).at(1), c.expiry), call("long", around(c).at(4), c.expiry)] },
  { key: "bear-put", label: "Bear put spread", group: "Spreads", legs: (c) => [put("long", around(c).at(0), c.expiry), put("short", around(c).at(-3), c.expiry)] },
  { key: "bull-call", label: "Bull call spread", group: "Spreads", legs: (c) => [call("long", around(c).at(0), c.expiry), call("short", around(c).at(3), c.expiry)] },
  { key: "bull-put", label: "Bull put spread", group: "Spreads", legs: (c) => [put("short", around(c).at(-1), c.expiry), put("long", around(c).at(-4), c.expiry)] },
  { key: "calendar", label: "Calendar call spread", group: "Spreads", legs: (c) => (c.later ? [call("short", around(c).at(0), c.expiry), call("long", around(c).at(0), c.later)] : null) },

  { key: "long-straddle", label: "Long straddle", group: "Volatility", legs: (c) => [call("long", around(c).at(0), c.expiry), put("long", around(c).at(0), c.expiry)] },
  { key: "long-strangle", label: "Long strangle", group: "Volatility", legs: (c) => [call("long", around(c).at(2), c.expiry), put("long", around(c).at(-2), c.expiry)] },
  { key: "short-straddle", label: "Short straddle", group: "Volatility", legs: (c) => [call("short", around(c).at(0), c.expiry), put("short", around(c).at(0), c.expiry)] },
  { key: "short-strangle", label: "Short strangle", group: "Volatility", legs: (c) => [call("short", around(c).at(2), c.expiry), put("short", around(c).at(-2), c.expiry)] },

  { key: "butterfly", label: "Long call butterfly", group: "Ranges", legs: (c) => { const a = around(c); return [call("long", a.at(-2), c.expiry), call("short", a.at(0), c.expiry, 2), call("long", a.at(2), c.expiry)]; } },
  { key: "iron-butterfly", label: "Iron butterfly", group: "Ranges", legs: (c) => { const a = around(c); return [put("long", a.at(-3), c.expiry), put("short", a.at(0), c.expiry), call("short", a.at(0), c.expiry), call("long", a.at(3), c.expiry)]; } },
  { key: "iron-condor", label: "Iron condor", group: "Ranges", legs: (c) => { const a = around(c); return [put("long", a.at(-5), c.expiry), put("short", a.at(-2), c.expiry), call("short", a.at(2), c.expiry), call("long", a.at(5), c.expiry)]; } },
];

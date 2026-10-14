// The chain page: an underlying, its expirations, one expiration's chain read in detail, and every
// expiration side by side. Everything shown comes from the API; nothing is computed here but the
// layout.
import { C, mirrorBars, xyChart } from "./chart";
import { addToDraft } from "./draft";
import { add, h, stat, toneOf } from "./dom";
import { count, day, num, price, signed, signedPct, strike, usd, vol } from "./format";
import { searchBox } from "./search";
import { api, chainUrl, fundamentalsUrl, hubQuoteUrl, strategyUrl } from "./site";
import type { Chain, Contract, Kind, Terms, Underlying } from "./types";

const $ = (id: string) => document.getElementById(id)!;
const NEAR = 12;

let ticker = "";
let under: Underlying | null = null;
let chain: Chain | null = null;
let terms: Terms | null = null;
let selected: { strike: number; kind: Kind } | null = null;
let range: "near" | "all" = "near";
let flow: "oi" | "volume" = "oi";
let asking = 0;

const skeleton = (cls: string) => h("div", `skeleton ${cls}`);
const sections = ["summary", "charts", "table-wrap", "terms-wrap"];

function message(where: HTMLElement, text: string) {
  where.replaceChildren(h("p", "py-6 text-[14px] text-muted", text));
}

function setUrl(push: boolean) {
  const url = chainUrl(ticker, chain?.expiry ?? null);
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  document.title = ticker ? `${ticker} options — Options Lab — Market Hub` : "Options Lab — Market Hub";
  const builder = document.querySelector<HTMLAnchorElement>("[data-strategy-link]");
  if (builder) builder.href = strategyUrl(ticker);
}

function show(on: boolean) {
  for (const id of sections) $(id).hidden = !on;
  $("empty").hidden = on;
}

// --- The underlying ------------------------------------------------------------------------

function nyTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

function renderHead(u: Underlying) {
  const head = $("head");
  const title = add(h("div", "min-w-0"),
    add(h("div", "flex flex-wrap items-baseline gap-x-3 gap-y-1"),
      h("h2", "text-2xl font-medium tracking-tight text-ink-strong", u.name),
      h("span", "chip", u.ticker)),
    add(h("div", "mt-1 flex flex-wrap gap-x-4 text-[13px]"),
      Object.assign(h("a", "link", "Price page"), { href: hubQuoteUrl(u.ticker) }),
      u.kind === "EQUITY" ? Object.assign(h("a", "link", "Fundamentals"), { href: fundamentalsUrl(u.ticker) }) : null));
  const quote = add(h("div", "text-left sm:text-right"),
    h("div", "num text-3xl text-ink-strong", price(u.spot)),
    add(h("div", "mt-0.5 text-[13px]"),
      h("span", `num ${toneOf(u.change) === "up" ? "text-up" : toneOf(u.change) === "down" ? "text-down" : "text-muted"}`,
        `${signed(u.change)} (${signedPct(u.change_pct, 2)})`),
      u.quote_time ? h("span", "ml-2 text-muted", nyTime(u.quote_time)) : null));
  const stats = add(h("div", "mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 lg:grid-cols-7"),
    Object.assign(stat("IV 30 days", "…"), { id: "iv30" }),
    stat("Realised vol 20d", vol(u.realised_vol["20"])),
    stat("Realised vol 60d", vol(u.realised_vol["60"])),
    stat("Realised vol 1y", vol(u.realised_vol["250"])),
    stat("Risk-free rate", vol(u.rate, 2)),
    stat("Dividend yield", vol(u.dividend_yield, 2)),
    stat("Next results", u.earnings_date ? day(u.earnings_date) : "—"));
  head.replaceChildren(add(h("div", "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"), title, quote), stats);
}

function renderExpiries(u: Underlying) {
  const box = $("expiries");
  box.replaceChildren(
    ...u.expirations.map((e) => {
      const b = h("button", "range-btn whitespace-nowrap");
      b.type = "button";
      b.dataset.expiry = e.date;
      add(b, h("span", "text-ink", day(e.date, !e.date.startsWith(String(new Date().getUTCFullYear())) ? false : true)), h("span", "num ml-1.5 text-[12px] text-faint", `${e.days}d`));
      b.addEventListener("click", () => selectExpiry(e.date, true));
      return b;
    }),
  );
}

function markExpiry(expiry: string) {
  for (const b of $("expiries").querySelectorAll<HTMLButtonElement>("button"))
    b.setAttribute("aria-pressed", String(b.dataset.expiry === expiry));
  // Bring the chosen one into the row's view, without scrolling the page.
  const row = $("expiries");
  const b = row.querySelector<HTMLElement>(`[data-expiry="${expiry}"]`);
  if (b && (b.offsetLeft < row.scrollLeft || b.offsetLeft + b.offsetWidth > row.scrollLeft + row.clientWidth))
    row.scrollLeft = b.offsetLeft - row.clientWidth / 3;
}

function defaultExpiry(u: Underlying): string {
  return (u.expirations.find((e) => e.days >= 25) ?? u.expirations[u.expirations.length - 1]).date;
}

// --- One expiration ------------------------------------------------------------------------

function renderSummary(c: Chain) {
  const s = c.summary;
  const box = $("summary");
  const grid = add(h("div", "grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4"),
    stat("Days to expiration", String(c.days), day(c.expiry)),
    stat("At-the-money IV", vol(s.atm_iv), s.atm_strike !== null ? `Strike ${strike(s.atm_strike)}` : undefined),
    stat("Expected move", s.straddle !== null ? `±${price(s.straddle)}` : "—", s.expected_move_pct !== null ? `±${vol(s.expected_move_pct)}` : undefined),
    stat("One-sigma range", s.one_sigma ? `${price(s.one_sigma[0])}–${price(s.one_sigma[1]).slice(1)}` : "—"),
    stat("25-delta skew", s.skew_25d !== null ? `${signed(s.skew_25d * 100, 1)} pts` : "—",
      s.iv_put_25d !== null && s.iv_call_25d !== null ? `Puts ${vol(s.iv_put_25d)} · calls ${vol(s.iv_call_25d)}` : undefined),
    stat("Put/call open interest", num(s.put_call_oi, 2), `${count(s.put_oi)} puts · ${count(s.call_oi)} calls`),
    stat("Put/call volume", num(s.put_call_volume, 2), `${count(s.put_volume)} puts · ${count(s.call_volume)} calls`),
    stat("Max pain", price(s.max_pain)));
  const note = c.earnings_before && under?.earnings_date
    ? h("p", "mt-5 text-[13px] text-warn", `Results are due on ${day(under.earnings_date)}, before this expiration.`)
    : null;
  box.replaceChildren(add(h("section", "sec"), add(h("header", "sec-head"), h("h3", "sec-title", `Expiration ${day(c.expiry)}`)), grid, note));
}

function visible(c: Chain) {
  const spot = c.spot;
  const rows = c.strikes;
  if (range === "all") return rows;
  const at = rows.reduce((best, r, i) => (Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot) ? i : best), 0);
  return rows.slice(Math.max(0, at - NEAR), at + NEAR + 1);
}

function renderCharts(c: Chain) {
  const rows = c.strikes.filter((r) => Math.abs(r.strike / c.spot - 1) <= 0.35);
  const use = rows.length >= 5 ? rows : c.strikes;
  const xs = use.map((r) => r.strike);
  const markers = [{ x: c.spot, label: `Price ${price(c.spot)}`, color: C.warn }];

  const smile = h("div");
  const flowBox = h("div");
  const flowTabs = h("div", "tabs");
  for (const [key, label] of [["oi", "Open interest"], ["volume", "Volume"]] as const) {
    const b = h("button", "tab-btn", label);
    b.type = "button";
    b.setAttribute("aria-selected", String(flow === key));
    b.addEventListener("click", () => {
      flow = key;
      renderCharts(c);
    });
    flowTabs.append(b);
  }
  $("charts").replaceChildren(
    add(h("section", "sec"), add(h("header", "sec-head"), h("h3", "sec-title", "Volatility smile"),
      h("span", "sec-note", "Implied volatility by strike")), smile),
    add(h("section", "sec"), add(h("header", "sec-head"), h("h3", "sec-title", flow === "oi" ? "Open interest by strike" : "Volume by strike"), flowTabs), flowBox),
  );
  xyChart(smile, {
    xs,
    lines: [
      // Each side where it is out of the money (and a little past the price, where they meet).
      { label: "Calls", values: use.map((r) => (r.strike >= c.spot * 0.97 ? r.call?.iv ?? null : null)), color: C.ink, dots: true },
      { label: "Puts", values: use.map((r) => (r.strike <= c.spot * 1.03 ? r.put?.iv ?? null : null)), color: C.muted, dots: true, dash: "4 3" },
    ],
    xFmt: (v) => strike(v),
    yFmt: (v) => vol(v, 0),
    markers,
    band: c.summary.one_sigma ? { x0: c.summary.one_sigma[0], x1: c.summary.one_sigma[1], label: "±1σ" } : undefined,
    height: 260,
    label: "Implied volatility of calls and puts by strike",
  });
  const pain = c.summary.max_pain;
  const up = use.map((r) => (flow === "oi" ? r.call?.oi : r.call?.volume) ?? 0);
  const down = use.map((r) => (flow === "oi" ? r.put?.oi : r.put?.volume) ?? 0);
  // Yahoo reports no open interest for some hours around the open.
  if (!up.some(Boolean) && !down.some(Boolean))
    return message(flowBox, flow === "oi" ? "No open interest is reported right now." : "No volume is reported right now.");
  mirrorBars(flowBox, {
    xs,
    up,
    down,
    upLabel: "Calls",
    downLabel: "Puts",
    xFmt: (v) => strike(v),
    yFmt: (v) => count(v),
    markers: [...markers, ...(pain !== null && flow === "oi" ? [{ x: pain, label: "Max pain", color: C.muted }] : [])],
    height: 260,
    label: "Calls and puts by strike",
  });
}

const CALL_COLS: [keyof Contract, string, (v: Contract) => string][] = [
  ["delta", "Δ", (x) => signed(x.delta)],
  ["iv", "IV", (x) => vol(x.iv)],
  ["oi", "OI", (x) => count(x.oi)],
  ["volume", "Vol", (x) => count(x.volume)],
  ["last", "Last", (x) => num(x.last)],
  ["bid", "Bid", (x) => num(x.bid)],
  ["ask", "Ask", (x) => num(x.ask)],
];
const PUT_COLS = [...CALL_COLS].reverse().map(([k, l, f]) => [k, l, f] as typeof CALL_COLS[number]);
// Puts read outwards from the strike too: Bid, Ask, Last, Vol, OI, IV, Δ.
PUT_COLS.splice(0, 3, CALL_COLS[5], CALL_COLS[6], CALL_COLS[4]);

function renderTable(c: Chain) {
  const wrap = $("table-wrap");
  const tabs = h("div", "tabs");
  for (const [key, label] of [["near", "Near the price"], ["all", "All strikes"]] as const) {
    const b = h("button", "tab-btn", label);
    b.type = "button";
    b.setAttribute("aria-selected", String(range === key));
    b.addEventListener("click", () => {
      range = key;
      renderTable(c);
    });
    tabs.append(b);
  }
  const table = h("table", "chain-table");
  const head = h("thead");
  const sides = add(h("tr"), add(h("th", "side", "Calls"), ), h("th", "", ""), h("th", "side", "Puts"));
  (sides.children[0] as HTMLTableCellElement).colSpan = CALL_COLS.length;
  (sides.children[2] as HTMLTableCellElement).colSpan = PUT_COLS.length;
  const cols = add(h("tr"), ...CALL_COLS.map(([, l]) => h("th", "", l)), h("th", "strike", "Strike"), ...PUT_COLS.map(([, l]) => h("th", "", l)));
  add(head, sides, cols);
  const body = h("tbody");
  let spotShown = false;
  const rows = visible(c);
  for (const r of rows) {
    if (!spotShown && r.strike > c.spot) {
      spotShown = true;
      const tr = h("tr", "spot-row");
      const td = h("td", "", `Price ${price(c.spot)}`);
      td.colSpan = CALL_COLS.length + PUT_COLS.length + 1;
      body.append(add(tr, td));
    }
    const tr = h("tr");
    const cell = (x: Contract | null, cols: typeof CALL_COLS, kind: Kind) =>
      cols.map(([key, , f]) => {
        const td = h("td", x ? "pick" : "", x ? f(x) : "");
        if (x?.itm) td.classList.add("itm");
        if (x && key === "delta") td.classList.add("text-muted");
        if (x) {
          td.dataset.kind = kind;
          td.dataset.strike = String(r.strike);
          if (selected && selected.kind === kind && selected.strike === r.strike) td.classList.add("on");
        }
        return td;
      });
    add(tr, ...cell(r.call, CALL_COLS, "call"), h("td", "strike", strike(r.strike)), ...cell(r.put, PUT_COLS, "put"));
    body.append(tr);
  }
  table.addEventListener("click", (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td.pick");
    if (!td) return;
    selected = { kind: td.dataset.kind as Kind, strike: Number(td.dataset.strike) };
    for (const on of table.querySelectorAll("td.on")) on.classList.remove("on");
    for (const x of table.querySelectorAll<HTMLElement>(`td[data-kind="${selected.kind}"][data-strike="${td.dataset.strike}"]`)) x.classList.add("on");
    renderDetail(c);
    if (window.innerWidth < 1280) $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  add(table, head, body);
  wrap.replaceChildren(
    add(h("section", "sec"),
      add(h("header", "sec-head"), h("h3", "sec-title", "Chain"), tabs),
      h("p", "-mt-1 mb-3 text-[13px] text-muted", "Choose a call or a put to read it in detail. Shaded: in the money."),
      add(h("div", "flex flex-col gap-8 xl:flex-row xl:items-start"),
        add(h("div", "min-w-0 flex-1 overflow-x-auto"), table),
        Object.assign(h("aside", "w-full flex-none xl:sticky xl:top-20 xl:w-[340px]"), { id: "detail" }))),
  );
  renderDetail(c);
}

// --- One contract --------------------------------------------------------------------------

function dl(title: string, rows: [string, string, string?][]): HTMLElement {
  const box = add(h("div", "mt-5"), h("div", "label mb-1.5", title));
  const list = h("dl", "divide-y divide-line border-y border-line");
  for (const [k, v, note] of rows)
    list.append(add(h("div", "flex items-baseline justify-between gap-4 py-1.5"),
      h("dt", "text-[13px] text-muted", k),
      add(h("dd", "text-right"), h("span", "num text-[13px] text-ink-strong", v), note ? h("span", "ml-1.5 text-[12px] text-faint", note) : null)));
  box.append(list);
  return box;
}

function renderDetail(c: Chain) {
  const box = $("detail");
  const row = selected && c.strikes.find((r) => r.strike === selected!.strike);
  const x = row ? row[selected!.kind] : null;
  if (!x) {
    box.replaceChildren(add(h("div", "border-t border-line-strong pt-3.5"),
      h("h3", "sec-title", "Contract"),
      h("p", "mt-2 text-[13px] text-muted", "Choose a call or a put in the chain: its price, value, odds and greeks show here.")));
    return;
  }
  const per = (v: number | null, d = 2) => (v === null ? undefined : `${usd(v * 100, true, d === 0 ? 0 : 2)} a contract`);
  const added = h("p", "mt-2 text-[13px] text-muted");
  added.hidden = true;
  const add_ = (side: "long" | "short") => {
    const b = h("button", "btn btn-ghost flex-1 py-1.5 text-[13px]", side === "long" ? "Add long to strategy" : "Add short to strategy");
    b.type = "button";
    b.addEventListener("click", () => {
      addToDraft(c.ticker, { kind: x.kind, side, qty: 1, strike: x.strike, expiry: c.expiry, price: null });
      added.hidden = false;
      added.replaceChildren(`${side === "long" ? "Long" : "Short"} ${strike(x.strike)} ${x.kind} added. `,
        Object.assign(h("a", "link", "Open the strategy"), { href: strategyUrl(c.ticker) }));
    });
    return b;
  };
  box.replaceChildren(add(h("div", "border-t border-line-strong pt-3.5"),
    add(h("div", "flex items-baseline justify-between gap-3"),
      h("h3", "text-[17px] font-semibold text-ink-strong", `${c.ticker} ${strike(x.strike)} ${x.kind}`),
      h("span", "text-[13px] text-muted", `${day(c.expiry)} · ${c.days}d`)),
    h("div", "num mt-0.5 text-[12px] text-faint", x.symbol),
    add(h("div", "mt-4 flex gap-2"), add_("long"), add_("short")),
    added,
    dl("Price", [
      ["Mark", price(x.mark), x.mark_source === "mid" ? "mid" : x.mark_source === "last" ? "last trade" : undefined],
      ["Bid × ask", `${num(x.bid)} × ${num(x.ask)}`],
      ["Spread", x.spread !== null ? price(x.spread) : "—", x.spread_pct !== null ? vol(x.spread_pct) : undefined],
      ["Last trade", price(x.last), x.last_trade ? nyTime(x.last_trade) : undefined],
      ["Volume", count(x.volume)],
      ["Open interest", count(x.oi)],
    ]),
    dl("Value", [
      ["Intrinsic value", price(x.intrinsic)],
      ["Time value", price(x.extrinsic)],
      ["Breakeven at expiration", price(x.breakeven)],
      ["Move to breakeven", signedPct(x.to_breakeven)],
      ["Strike against price", signedPct(x.moneyness)],
    ]),
    dl("Volatility and odds", [
      ["Implied volatility", vol(x.iv)],
      ["Ends in the money", vol(x.prob_itm, 0)],
      ["Touches the strike", vol(x.prob_touch, 0)],
    ]),
    dl("Greeks", [
      ["Delta", signed(x.delta, 3), x.delta !== null ? `${signed(x.delta * 100, 0)} shares` : undefined],
      ["Gamma", num(x.gamma, 4), "per $1"],
      ["Theta", signed(x.theta, 3), per(x.theta) ? `${per(x.theta)} a day` : undefined],
      ["Vega", signed(x.vega, 3), per(x.vega) ? `${per(x.vega)} per vol pt` : undefined],
      ["Rho", signed(x.rho, 3), "per 1% rate"],
    ])));
}

// --- Every expiration ----------------------------------------------------------------------

async function loadTerms(t: string) {
  const wrap = $("terms-wrap");
  wrap.replaceChildren(add(h("section", "sec"), h("h3", "sec-title mb-4", "All expirations"), skeleton("h-56 w-full")));
  try {
    terms = await api<Terms>(`/api/terms/${encodeURIComponent(t)}`);
  } catch (err) {
    if (t === ticker) message(wrap, (err as Error).message);
    return;
  }
  if (t !== ticker) return;
  const iv30 = document.getElementById("iv30");
  if (iv30) iv30.replaceWith(Object.assign(stat("IV 30 days", vol(terms.iv30)), { id: "iv30" }));
  const chart = h("div");
  const table = h("table", "data-table");
  add(table, add(h("thead"), add(h("tr"), ...["Expiration", "Days", "ATM IV", "Expected move", "Put/call OI", "25Δ skew", "Max pain"].map((l) => h("th", "", l)))));
  const body = h("tbody");
  for (const r of terms.terms) {
    const tr = h("tr", "row-link");
    add(tr,
      add(h("td"), h("span", "", day(r.expiry)), r.earnings_before && under?.earnings_date && terms.terms.find((x) => x.earnings_before)?.expiry === r.expiry
        ? h("span", "ml-2 text-[12px] text-warn", "first after results") : null),
      h("td", "", String(r.days)),
      h("td", "", vol(r.atm_iv)),
      h("td", "", r.expected_move_pct !== null ? `±${vol(r.expected_move_pct)}` : "—"),
      h("td", "", num(r.call_oi ? r.put_oi / r.call_oi : null, 2)),
      h("td", "", r.skew_25d !== null ? `${signed(r.skew_25d * 100, 1)} pts` : "—"),
      h("td", "", price(r.max_pain)));
    tr.addEventListener("click", () => {
      selectExpiry(r.expiry, true);
      $("summary").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    body.append(tr);
  }
  table.append(body);
  wrap.replaceChildren(add(h("section", "sec"),
    add(h("header", "sec-head"), h("h3", "sec-title", "All expirations"), h("span", "sec-note", "At-the-money implied volatility by days to expiration")),
    chart,
    add(h("div", "mt-6 overflow-x-auto"), table)));
  const rows = terms.terms.filter((r) => r.atm_iv !== null);
  xyChart(chart, {
    xs: rows.map((r) => r.days),
    lines: [{ label: "ATM IV", values: rows.map((r) => r.atm_iv), color: C.ink, dots: true }],
    xFmt: (v) => `${Math.round(v)}d`,
    yFmt: (v) => vol(v, 0),
    height: 220,
    label: "At-the-money implied volatility by expiration",
  });
}

// --- Flow ----------------------------------------------------------------------------------

async function selectExpiry(expiry: string, push: boolean) {
  if (!under) return;
  const ask = ++asking;
  markExpiry(expiry);
  if (chain?.expiry !== expiry) selected = null;
  $("summary").replaceChildren(add(h("section", "sec"), skeleton("h-5 w-48"), add(h("div", "mt-4 grid grid-cols-2 gap-6 sm:grid-cols-4"), ...Array.from({ length: 8 }, () => skeleton("h-12")))));
  $("charts").replaceChildren(skeleton("h-64"), skeleton("h-64"));
  $("table-wrap").replaceChildren(skeleton("h-96 w-full"));
  try {
    const c = await api<Chain>(`/api/chain/${encodeURIComponent(ticker)}?expiry=${expiry}`);
    if (ask !== asking) return;
    chain = c;
  } catch (err) {
    if (ask !== asking) return;
    message($("summary"), (err as Error).message);
    $("charts").replaceChildren();
    $("table-wrap").replaceChildren();
    return;
  }
  setUrl(push);
  renderSummary(chain);
  renderCharts(chain);
  renderTable(chain);
}

async function open(t: string, expiry: string | null, push: boolean) {
  ticker = t.toUpperCase();
  under = null;
  chain = null;
  terms = null;
  selected = null;
  const ask = ++asking;
  show(true);
  $("head").replaceChildren(skeleton("h-8 w-64"), add(h("div", "mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4 lg:grid-cols-7"), ...Array.from({ length: 7 }, () => skeleton("h-12"))));
  $("expiries").replaceChildren();
  for (const id of ["summary", "charts", "table-wrap", "terms-wrap"]) $(id).replaceChildren();
  try {
    const u = await api<Underlying>(`/api/underlying/${encodeURIComponent(ticker)}`);
    if (ask !== asking) return;
    under = u;
  } catch (err) {
    if (ask !== asking) return;
    message($("head"), (err as Error).message);
    setUrl(push);
    return;
  }
  renderHead(under);
  renderExpiries(under);
  const chosen = expiry && under.expirations.some((e) => e.date === expiry) ? expiry : defaultExpiry(under);
  loadTerms(ticker);
  await selectExpiry(chosen, push);
}

export function start() {
  const box = searchBox(document.querySelector<HTMLFormElement>("#find")!, (t) => open(t, null, true));
  const fromUrl = () => {
    const q = new URLSearchParams(location.search);
    const t = q.get("t");
    if (t) {
      box.set(t.toUpperCase());
      open(t, q.get("e"), false);
    } else show(false);
  };
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-example]"))
    a.addEventListener("click", (e) => {
      e.preventDefault();
      box.set(a.dataset.example!);
      open(a.dataset.example!, null, true);
    });
  window.addEventListener("popstate", () => {
    const q = new URLSearchParams(location.search);
    const t = q.get("t");
    if (t && t.toUpperCase() === ticker && under && q.get("e")) selectExpiry(q.get("e")!, false);
    else fromUrl();
  });
  fromUrl();
}

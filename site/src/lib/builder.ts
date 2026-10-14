// The strategy page: legs on one underlying, read as a whole by the API (payoff, breakevens, most
// and least, greeks, the chance of a profit), and kept by the user if they want.
import { C, xyChart } from "./chart";
import { readDraft, writeDraft } from "./draft";
import { add, h, stat } from "./dom";
import { day, num, price, signed, strike, usd, vol } from "./format";
import { searchBox } from "./search";
import { api, chainUrl, strategyUrl } from "./site";
import { TEMPLATES } from "./templates";
import type { Analysis, Chain, Leg, SavedStrategy, Underlying } from "./types";

const $ = (id: string) => document.getElementById(id)!;

let ticker = "";
let under: Underlying | null = null;
let legs: Leg[] = [];
let editing: { id?: string; name?: string } = {};
let analysis: Analysis | null = null;
let daysAhead: number | null = null; // the "value on" slider, in days from today
let ivShift = 0;
let asking = 0;
let timer = 0;
const chains = new Map<string, Promise<Chain>>();

function chainOf(expiry: string): Promise<Chain> {
  const key = `${ticker}|${expiry}`;
  if (!chains.has(key)) {
    const p = api<Chain>(`/api/chain/${encodeURIComponent(ticker)}?expiry=${expiry}`);
    p.catch(() => chains.delete(key));
    chains.set(key, p);
  }
  return chains.get(key)!;
}

function save() {
  writeDraft(ticker ? { ticker, legs, id: editing.id, name: editing.name } : null);
}

function option(value: string, label: string, selected = false) {
  const o = h("option", "", label);
  o.value = value;
  o.selected = selected;
  return o;
}

function select(cls: string, opts: HTMLOptionElement[], onChange: (v: string) => void) {
  const s = h("select", `field ${cls}`);
  add(s, ...opts);
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

// --- The underlying and the templates ------------------------------------------------------

function renderHead(u: Underlying) {
  $("head").replaceChildren(add(h("div", "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2"),
    add(h("div", "flex flex-wrap items-baseline gap-x-3"),
      h("h2", "text-2xl font-medium tracking-tight text-ink-strong", u.name),
      h("span", "chip", u.ticker),
      Object.assign(h("a", "link text-[13px]", "Chain"), { href: chainUrl(u.ticker) })),
    h("div", "num text-2xl text-ink-strong", price(u.spot))));
}

function renderStart(u: Underlying) {
  const exp = select("w-auto", u.expirations.map((e) => option(e.date, `${day(e.date)} · ${e.days}d`, e.date === (u.expirations.find((x) => x.days >= 25) ?? u.expirations[0]).date)), () => {});
  const groups = [...new Set(TEMPLATES.map((t) => t.group))];
  const tpl = h("select", "field w-auto");
  tpl.append(option("", "Choose a shape…"));
  for (const g of groups) {
    const og = h("optgroup");
    og.label = g;
    for (const t of TEMPLATES.filter((x) => x.group === g)) og.append(option(t.key, t.label));
    tpl.append(og);
  }
  const apply = h("button", "btn btn-primary py-1.5", "Use");
  apply.type = "button";
  const problem = h("p", "mt-2 text-[13px] text-down");
  problem.hidden = true;
  apply.addEventListener("click", async () => {
    const t = TEMPLATES.find((x) => x.key === tpl.value);
    if (!t) return;
    problem.hidden = true;
    try {
      const c = await chainOf(exp.value);
      const near = u.expirations.find((e) => e.date === exp.value)!;
      const later = u.expirations.find((e) => e.days >= near.days + 20)?.date ?? null;
      const made = t.legs({ spot: c.spot, strikes: c.strikes.map((s) => s.strike), expiry: exp.value, later });
      if (!made) throw new Error("There is no later expiration to pair this one with.");
      legs = made;
      editing = {};
      changed();
    } catch (err) {
      problem.hidden = false;
      problem.textContent = (err as Error).message;
    }
  });
  const clear = h("button", "btn btn-ghost py-1.5", "Clear");
  clear.type = "button";
  clear.addEventListener("click", () => {
    legs = [];
    editing = {};
    changed();
  });
  $("start").replaceChildren(add(h("section", "sec"),
    add(h("header", "sec-head"), h("h3", "sec-title", "Start from a shape")),
    add(h("div", "flex flex-wrap items-center gap-2"), tpl, h("span", "text-[13px] text-muted", "on"), exp, apply, clear),
    problem));
}

// --- The legs ------------------------------------------------------------------------------

async function renderLegs() {
  const u = under!;
  const box = $("legs");
  const table = h("table", "legs-table");
  add(table, add(h("thead"), add(h("tr"), ...["Side", "Qty", "Type", "Expiration", "Strike", "Price", "Mark", "IV", ""].map((l) => h("th", "", l)))));
  const body = h("tbody");
  const priced = analysis && analysis.legs.length === legs.length ? analysis.legs : null;
  for (const [i, leg] of legs.entries()) {
    const tr = h("tr");
    const side = select("", [option("long", "Long", leg.side === "long"), option("short", "Short", leg.side === "short")], (v) => {
      leg.side = v as Leg["side"];
      changed();
    });
    const qty = Object.assign(h("input", "field w-20 num"), { type: "number", min: "1", max: "10000", step: "1", value: String(leg.qty) });
    qty.addEventListener("change", () => {
      leg.qty = Math.max(1, Math.min(10000, Math.round(Number(qty.value) || 1)));
      changed();
    });
    const kind = select("", [option("call", "Call", leg.kind === "call"), option("put", "Put", leg.kind === "put"), option("stock", "Shares", leg.kind === "stock")], async (v) => {
      const was = leg.kind;
      leg.kind = v as Leg["kind"];
      if (leg.kind === "stock") {
        delete leg.strike;
        delete leg.expiry;
        if (was !== "stock") leg.qty = 100;
      } else if (was === "stock") {
        leg.qty = 1;
        leg.expiry = u.expirations.find((e) => e.days >= 25)?.date ?? u.expirations[0].date;
        const c = await chainOf(leg.expiry);
        leg.strike = c.summary.atm_strike ?? c.strikes[0].strike;
      }
      leg.price = null;
      changed();
    });
    const cells: (HTMLElement | null)[] = [side, qty, kind];
    if (leg.kind === "stock") cells.push(h("span", "text-[13px] text-faint", "—"), h("span", "text-[13px] text-faint", "—"));
    else {
      const exp = select("", u.expirations.map((e) => option(e.date, `${day(e.date)} · ${e.days}d`, e.date === leg.expiry)), async (v) => {
        leg.expiry = v;
        const c = await chainOf(v);
        const ks = c.strikes.map((s) => s.strike);
        if (!ks.includes(leg.strike!)) leg.strike = ks.reduce((b, k) => (Math.abs(k - leg.strike!) < Math.abs(b - leg.strike!) ? k : b), ks[0]);
        leg.price = null;
        changed();
      });
      const ks = select("num", [option(String(leg.strike), strike(leg.strike), true)], (v) => {
        leg.strike = Number(v);
        leg.price = null;
        changed();
      });
      chainOf(leg.expiry!).then((c) => {
        ks.replaceChildren(...c.strikes.filter((s) => s[leg.kind as "call" | "put"]).map((s) => option(String(s.strike), strike(s.strike), s.strike === leg.strike)));
      }).catch(() => {});
      cells.push(exp, ks);
    }
    const p = Object.assign(h("input", "field w-24 num"), { type: "number", min: "0", step: "0.01", placeholder: priced ? num(priced[i].mark) : "Today", value: leg.price ?? "" });
    p.title = "What was paid or received per share. Empty: today's price.";
    p.addEventListener("change", () => {
      leg.price = p.value === "" ? null : Math.max(0, Number(p.value));
      changed();
    });
    const remove = h("button", "px-2 text-lg leading-none text-muted hover:text-ink-strong", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove this leg");
    remove.addEventListener("click", () => {
      legs.splice(i, 1);
      changed();
    });
    cells.push(p, h("span", "num text-[13px] text-ink", priced ? price(priced[i].mark) : "—"), h("span", "num text-[13px] text-muted", priced ? vol(priced[i].iv) : "—"), remove);
    for (const c of cells) tr.append(add(h("td"), c));
    body.append(tr);
  }
  table.append(body);
  const more = h("button", "btn btn-ghost py-1.5 text-[13px]", "+ Add a leg");
  more.type = "button";
  more.disabled = legs.length >= 8;
  more.addEventListener("click", async () => {
    const last = legs.findLast((l) => l.kind !== "stock");
    const expiry = last?.expiry ?? u.expirations.find((e) => e.days >= 25)?.date ?? u.expirations[0].date;
    const c = await chainOf(expiry);
    legs.push({ kind: "call", side: "long", qty: 1, expiry, strike: c.summary.atm_strike ?? c.strikes[0].strike, price: null });
    changed();
  });
  box.replaceChildren(add(h("section", "sec"),
    add(h("header", "sec-head"), h("h3", "sec-title", editing.name ? `Legs · ${editing.name}` : "Legs"), more),
    legs.length ? add(h("div", "overflow-x-auto"), table) : h("p", "py-4 text-[14px] text-muted", "No legs yet. Start from a shape, add a leg, or add contracts from the chain.")));
}

// --- The reading ---------------------------------------------------------------------------

function changed() {
  save();
  renderLegs();
  window.clearTimeout(timer);
  timer = window.setTimeout(readIt, 200);
}

function dateAt(a: Analysis, ahead: number): string {
  const d = new Date(`${a.horizon}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (a.days - ahead));
  return d.toISOString().slice(0, 10);
}

async function readIt() {
  const ask = ++asking;
  if (!legs.length) {
    analysis = null;
    $("result").replaceChildren();
    renderSave();
    return;
  }
  const at = analysis && daysAhead !== null && daysAhead > 0 && daysAhead < analysis.days ? dateAt(analysis, daysAhead) : null;
  $("result").classList.add("opacity-60");
  try {
    const a = await api<Analysis>("/api/strategy", { method: "POST", body: { ticker, legs, at, iv_shift: ivShift } });
    if (ask !== asking) return;
    const first = !analysis || analysis.horizon !== a.horizon;
    analysis = a;
    if (first) {
      daysAhead = a.days > 1 ? Math.round(a.days / 2) : null;
      if (daysAhead !== null) return void readIt();
    }
    renderResult(a);
    renderLegs();
  } catch (err) {
    if (ask !== asking) return;
    analysis = null;
    $("result").replaceChildren(h("p", "sec py-4 text-[14px] text-down", (err as Error).message));
  } finally {
    if (ask === asking) $("result").classList.remove("opacity-60");
    renderSave();
  }
}

function money(v: number | null, unbounded: string) {
  return v === null ? unbounded : usd(v, true);
}

function renderResult(a: Analysis) {
  const debit = a.cost >= 0;
  const facts = add(h("div", "grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4"),
    stat(debit ? "Net debit" : "Net credit", usd(Math.abs(a.cost)), "Paid or received to open"),
    stat("Max profit", money(a.max_profit, "Unlimited"), undefined, a.max_profit === null || a.max_profit > 0 ? "up" : ""),
    stat("Max loss", money(a.max_loss, "Unlimited"), undefined, a.max_loss === null || a.max_loss < 0 ? "down" : ""),
    stat("Chance of profit", vol(a.pop, 0), `At ${day(a.horizon)}`),
    stat("Breakevens", a.breakevens.length ? a.breakevens.map((b) => price(b)).join(" · ") : "None"),
    stat("Reward / risk", a.reward_risk !== null ? `${num(a.reward_risk, 2)} : 1` : "—"),
    stat("Value today", usd(a.value, true), `P&L since opened ${usd(a.pnl_now, true)}`, a.pnl_now > 0 ? "up" : a.pnl_now < 0 ? "down" : ""),
    stat("Implied volatility", vol(a.sigma), a.iv_shift ? `${signed(a.iv_shift * 100, 0)} pts on today's` : undefined));
  const g = a.greeks;
  const greeks = add(h("div", "grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-5"),
    stat("Delta", signed(g.delta, 1), "Shares the position moves like"),
    stat("Gamma", signed(g.gamma, 2), "Delta per $1"),
    stat("Theta", usd(g.theta, true, 2), "A day"),
    stat("Vega", usd(g.vega, true, 2), "Per volatility point"),
    stat("Rho", usd(g.rho, true, 2), "Per 1% rate"));

  const chart = h("div");
  const slider = h("div", "flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px]");
  if (a.days > 1 && daysAhead !== null) {
    const r = Object.assign(h("input", "w-48 accent-[#f2f0ea]"), { type: "range", min: "1", max: String(a.days - 1), step: "1", value: String(daysAhead) });
    const label = h("span", "num text-ink-strong", day(dateAt(a, daysAhead)));
    r.addEventListener("input", () => (label.textContent = day(dateAt(a, Number(r.value)))));
    r.addEventListener("change", () => {
      daysAhead = Number(r.value);
      readIt();
    });
    slider.append(add(h("label", "flex items-center gap-3"), h("span", "text-muted", "Value on"), r, label));
  }
  const v = Object.assign(h("input", "w-40 accent-[#f2f0ea]"), { type: "range", min: "-30", max: "30", step: "1", value: String(Math.round(ivShift * 100)) });
  const vLabel = h("span", "num text-ink-strong", `${signed(ivShift * 100, 0)} pts`);
  v.addEventListener("input", () => (vLabel.textContent = `${signed(Number(v.value), 0)} pts`));
  v.addEventListener("change", () => {
    ivShift = Number(v.value) / 100;
    readIt();
  });
  slider.append(add(h("label", "flex items-center gap-3"), h("span", "text-muted", "Volatility"), v, vLabel));

  const legsTable = h("table", "data-table");
  add(legsTable, add(h("thead"), add(h("tr"), ...["Leg", "Contract", "Opened at", "Mark", "IV", "Shares"].map((l) => h("th", "", l)))));
  const body = h("tbody");
  for (const l of a.legs)
    body.append(add(h("tr"),
      h("td", "", l.kind === "stock" ? `${l.side === "long" ? "Long" : "Short"} ${l.qty} shares` : `${l.side === "long" ? "Long" : "Short"} ${l.qty} ${strike(l.strike)} ${l.kind} · ${day(l.expiry, true)}`),
      h("td", "text-muted", l.kind === "stock" ? l.symbol : l.symbol),
      h("td", "", price(l.entry)), h("td", "", price(l.mark)), h("td", "", vol(l.iv)), h("td", "", signed(l.shares, 0))));
  legsTable.append(body);

  $("result").replaceChildren(
    add(h("section", "sec"),
      add(h("header", "sec-head"), h("h3", "sec-title", "Profit and loss"), h("span", "sec-note", `By the price of ${a.ticker}`)),
      slider,
      add(h("div", "mt-4"), chart),
      add(h("div", "mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted"),
        add(h("span", "flex items-center gap-1.5"), Object.assign(h("span", "inline-block h-0.5 w-4"), { style: `background:${C.ink}` }), `At expiration (${day(a.horizon)})`),
        a.target ? add(h("span", "flex items-center gap-1.5"), Object.assign(h("span", "inline-block h-0.5 w-4"), { style: `background:${C.warn}` }), `On ${day(a.target)}`) : null,
        add(h("span", "flex items-center gap-1.5"), Object.assign(h("span", "inline-block h-0.5 w-4"), { style: `background:${C.muted}` }), "Today"))),
    add(h("section", "sec mt-10"), add(h("header", "sec-head"), h("h3", "sec-title", "The position")), facts),
    add(h("section", "sec mt-10"), add(h("header", "sec-head"), h("h3", "sec-title", "Greeks"), h("span", "sec-note", "The whole position, today")), greeks),
    add(h("section", "sec mt-10"), add(h("header", "sec-head"), h("h3", "sec-title", "Legs priced")), add(h("div", "overflow-x-auto"), legsTable),
      a.notes.length ? add(h("ul", "mt-3 space-y-1 text-[13px] text-muted"), ...a.notes.map((n) => h("li", "", n))) : null),
  );
  const c = a.curves;
  xyChart(chart, {
    xs: c.prices,
    lines: [
      { label: "Today", values: c.now, color: C.muted, dash: "4 3" },
      ...(c.target ? [{ label: `On ${day(a.target, true)}`, values: c.target, color: C.warn, width: 1.4 }] : []),
      { label: `At ${day(a.horizon, true)}`, values: c.expiry, color: C.ink, width: 2 },
    ],
    shade: c.target ? 2 : 1,
    zero: true,
    xFmt: (x) => price(x),
    yFmt: (y) => usd(y, true),
    markers: [{ x: a.spot, label: "Price", color: C.warn }, ...a.breakevens.map((b) => ({ x: b, label: "", color: C.faint }))],
    band: a.one_sigma ? { x0: a.one_sigma[0], x1: a.one_sigma[1], label: "±1σ" } : undefined,
    height: 340,
    label: "Profit and loss of the strategy by the price of the underlying",
  });
}

// --- Keeping it ----------------------------------------------------------------------------

function renderSave(said = "") {
  const box = $("save");
  if (!legs.length || !analysis) return void box.replaceChildren();
  const name = Object.assign(h("input", "field w-64"), { type: "text", maxLength: 80, placeholder: "A name for it", value: editing.name ?? "" });
  const status = h("span", "text-[13px] text-muted", said);
  const send = async (asNew: boolean) => {
    const n = name.value.trim();
    if (!n) return void (status.textContent = "Give it a name.");
    // What is kept is the strategy as opened: legs without a price take today's.
    const body = { name: n, ticker, legs: legs.map((l, i) => ({ ...l, price: l.price ?? analysis!.legs[i].entry })) };
    try {
      const s = asNew || !editing.id
        ? await api<SavedStrategy>("/api/strategies", { method: "POST", body })
        : await api<SavedStrategy>(`/api/strategies/${editing.id}`, { method: "PUT", body });
      legs = s.legs.map((l) => ({ ...l }));
      editing = { id: s.id, name: s.name };
      save();
      renderLegs();
      renderSave("Saved.");
      loadSaved();
    } catch (err) {
      status.textContent = (err as Error).message;
    }
  };
  const primary = h("button", "btn btn-primary py-1.5", editing.id ? "Save changes" : "Save");
  primary.type = "button";
  primary.addEventListener("click", () => send(false));
  const copy = h("button", "btn btn-ghost py-1.5", "Save as new");
  copy.type = "button";
  copy.addEventListener("click", () => send(true));
  box.replaceChildren(add(h("section", "sec"),
    add(h("header", "sec-head"), h("h3", "sec-title", "Keep this strategy")),
    add(h("div", "flex flex-wrap items-center gap-2"), name, primary, editing.id ? copy : null, status),
    h("p", "mt-2 text-[13px] text-muted", "Legs without a price are kept at today's, so the strategy can be followed from here.")));
}

async function loadSaved() {
  const box = $("saved");
  let list: SavedStrategy[];
  try {
    list = (await api<{ strategies: SavedStrategy[] }>("/api/strategies")).strategies;
  } catch (err) {
    box.replaceChildren(add(h("section", "sec"), h("h3", "sec-title", "Your strategies"), h("p", "mt-2 text-[13px] text-muted", (err as Error).message)));
    return;
  }
  const rows = list.map((s) => {
    const open = h("button", "link text-left", s.name);
    open.type = "button";
    open.addEventListener("click", () => {
      legs = s.legs.map((l) => ({ ...l }));
      editing = { id: s.id, name: s.name };
      analysis = null;
      if (s.ticker !== ticker) {
        writeDraft({ ticker: s.ticker, legs, id: s.id, name: s.name });
        return void location.assign(strategyUrl(s.ticker));
      }
      changed();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    const del = h("button", "text-[13px] text-muted hover:text-down", "Delete");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete “${s.name}”?`)) return;
      try {
        await api(`/api/strategies/${s.id}`, { method: "DELETE" });
        if (editing.id === s.id) editing = {};
        save();
        loadSaved();
        renderSave();
      } catch (err) {
        alert((err as Error).message);
      }
    });
    const summary = s.legs.map((l) => (l.kind === "stock" ? `${l.side === "long" ? "+" : "−"}${l.qty} sh` : `${l.side === "long" ? "+" : "−"}${l.qty} ${strike(l.strike)}${l.kind === "call" ? "C" : "P"} ${day(l.expiry, true)}`)).join(", ");
    return add(h("li", "flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"),
      add(h("div", "min-w-0"), add(h("div", "flex items-baseline gap-2"), open, h("span", "chip", s.ticker)), h("div", "num mt-0.5 truncate text-[12px] text-muted", summary)),
      add(h("div", "flex flex-none items-baseline gap-4"), h("span", "text-[12px] text-faint", `Saved ${day(s.updated_utc)}`), del));
  });
  box.replaceChildren(add(h("section", "sec"),
    add(h("header", "sec-head"), h("h3", "sec-title", "Your strategies"), h("span", "sec-note", `${list.length} of 50`)),
    list.length ? add(h("ul", "divide-y divide-line"), ...rows) : h("p", "py-2 text-[13px] text-muted", "None kept yet.")));
}

// --- Flow ----------------------------------------------------------------------------------

async function open(t: string, push: boolean) {
  ticker = t.toUpperCase();
  if (push) history.pushState(null, "", strategyUrl(ticker));
  document.title = `${ticker} strategy — Options Lab — Market Hub`;
  under = null;
  analysis = null;
  daysAhead = null;
  ivShift = 0;
  const d = readDraft();
  if (d && d.ticker === ticker) {
    legs = d.legs;
    editing = { id: d.id, name: d.name };
  } else {
    legs = [];
    editing = {};
  }
  $("empty").hidden = true;
  for (const id of ["start", "legs", "result", "save"]) $(id).replaceChildren();
  $("head").replaceChildren(h("div", "skeleton h-8 w-64"));
  try {
    under = await api<Underlying>(`/api/underlying/${encodeURIComponent(ticker)}`);
  } catch (err) {
    $("head").replaceChildren(h("p", "py-4 text-[14px] text-muted", (err as Error).message));
    return;
  }
  if (t.toUpperCase() !== ticker) return;
  renderHead(under);
  renderStart(under);
  changed();
}

export function start() {
  const box = searchBox(document.querySelector<HTMLFormElement>("#find")!, (t) => open(t, true));
  const fromUrl = () => {
    const t = new URLSearchParams(location.search).get("t") ?? readDraft()?.ticker;
    if (t) {
      box.set(t.toUpperCase());
      open(t, false);
    } else $("empty").hidden = false;
  };
  window.addEventListener("popstate", fromUrl);
  fromUrl();
  loadSaved();
}

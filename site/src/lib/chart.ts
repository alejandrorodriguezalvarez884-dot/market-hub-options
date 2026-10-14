// Charts drawn as SVG: lines over a shared x axis (payoffs, the smile, the term structure) and bars
// that face each other (calls above, puts below). Both read their size from the box they are put
// in and draw again when it changes. Green and red are kept for gains and losses.
import { add, h, svg } from "./dom";

export const C = {
  ink: "#f2f0ea",
  text: "#c9c7c1",
  muted: "#8c8b86",
  faint: "#5f5f5b",
  line: "#222528",
  lineStrong: "#3a3e42",
  up: "#35c98f",
  down: "#ff6b57",
  warn: "#e0b341",
  page: "#0b0c0d",
};

export type Line = { label: string; values: (number | null)[]; color: string; width?: number; dash?: string; dots?: boolean };
export type Marker = { x: number; label: string; color?: string; dash?: string };
export type XY = {
  xs: number[];
  lines: Line[];
  xFmt: (v: number) => string;
  yFmt: (v: number) => string;
  markers?: Marker[];
  band?: { x0: number; x1: number; label: string };
  // Fill between this line and zero: green where it is above, red where it is below.
  shade?: number;
  height?: number;
  zero?: boolean;
  label?: string;
};

const ok = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function ticks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function frame(el: HTMLElement, height: number, label?: string) {
  el.replaceChildren();
  el.classList.add("relative", "select-none");
  const tip = h("div", "chart-tip");
  tip.hidden = true;
  const root = svg("svg", { height, class: "block w-full overflow-visible" });
  if (label) {
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", label);
  }
  add(el, root, tip);
  return { root, tip };
}

function onResize(el: HTMLElement, draw: () => void) {
  let width = el.clientWidth;
  draw();
  new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - width) < 1) return;
    width = el.clientWidth;
    draw();
  }).observe(el);
}

function text(parent: SVGElement, x: number, y: number, value: string, anchor = "middle", color = C.muted) {
  const t = svg("text", { x, y, "text-anchor": anchor, fill: color, "font-size": 11, "font-family": "IBM Plex Mono, monospace" });
  t.textContent = value;
  parent.append(t);
  return t;
}

function tipRows(tip: HTMLElement, title: string, rows: [string, string, string?][]) {
  tip.replaceChildren(h("div", "mb-1 font-medium text-ink-strong", title));
  for (const [label, value, color] of rows) {
    const row = h("div", "flex items-center justify-between gap-4");
    const name = h("span", "flex items-center gap-1.5 text-muted");
    if (color) {
      const dot = h("span", "inline-block h-2 w-2 rounded-full");
      dot.style.background = color;
      name.append(dot);
    }
    name.append(label);
    add(row, name, h("span", "num text-ink-strong", value));
    tip.append(row);
  }
}

function placeTip(el: HTMLElement, tip: HTMLElement, x: number) {
  tip.hidden = false;
  const half = tip.offsetWidth / 2 + 4;
  tip.style.left = `${Math.min(Math.max(x, half), el.clientWidth - half)}px`;
  tip.style.top = "0px";
  tip.style.transform = "translate(-50%, calc(-100% - 6px))";
}

export function xyChart(el: HTMLElement, spec: XY): void {
  const H = spec.height ?? 300;
  const { root, tip } = frame(el, H, spec.label);
  const M = { l: 60, r: 14, t: 12, b: 26 };
  const xs = spec.xs;
  const all = spec.lines.flatMap((l) => l.values.filter(ok));
  if (!xs.length || !all.length) {
    root.remove();
    el.append(h("p", "py-10 text-center text-[13px] text-muted", "Nothing to draw."));
    return;
  }
  let y0 = Math.min(...all, ...(spec.zero ? [0] : []));
  let y1 = Math.max(...all, ...(spec.zero ? [0] : []));
  const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.08;
  y0 -= pad;
  y1 += pad;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);

  function draw() {
    root.replaceChildren();
    const W = Math.max(el.clientWidth, 260);
    root.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const px = (x: number) => M.l + ((x - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
    const py = (y: number) => M.t + (1 - (y - y0) / (y1 - y0 || 1)) * (H - M.t - M.b);

    for (const t of ticks(y0, y1, 5)) {
      root.append(svg("line", { x1: M.l, x2: W - M.r, y1: py(t), y2: py(t), stroke: t === 0 && spec.zero ? C.lineStrong : C.line }));
      text(root, M.l - 8, py(t) + 4, spec.yFmt(t), "end");
    }
    for (const t of ticks(x0, x1, Math.max(3, Math.floor(W / 110)))) text(root, px(t), H - 8, spec.xFmt(t));

    if (spec.band) {
      const a = px(Math.max(spec.band.x0, x0)), b = px(Math.min(spec.band.x1, x1));
      if (b > a) {
        root.append(svg("rect", { x: a, y: M.t, width: b - a, height: H - M.t - M.b, fill: C.ink, "fill-opacity": 0.04 }));
        text(root, (a + b) / 2, M.t + 11, spec.band.label, "middle", C.faint);
      }
    }

    if (spec.shade !== undefined) {
      const line = spec.lines[spec.shade];
      const pts = xs.map((x, i) => [px(x), line.values[i]] as const).filter(([, v]) => ok(v)) as [number, number][];
      if (pts.length > 1) {
        const zero = py(0);
        const d = `M${pts[0][0]},${zero} ` + pts.map(([x, v]) => `L${x},${py(v)}`).join(" ") + ` L${pts[pts.length - 1][0]},${zero} Z`;
        const id = `clip-${Math.random().toString(36).slice(2)}`;
        const defs = svg("defs");
        const above = svg("clipPath", { id: `${id}-a` });
        above.append(svg("rect", { x: 0, y: 0, width: W, height: Math.max(zero, 0) }));
        const below = svg("clipPath", { id: `${id}-b` });
        below.append(svg("rect", { x: 0, y: zero, width: W, height: Math.max(H - zero, 0) }));
        add(defs, above, below);
        root.append(defs);
        root.append(svg("path", { d, fill: C.up, "fill-opacity": 0.12, "clip-path": `url(#${id}-a)` }));
        root.append(svg("path", { d, fill: C.down, "fill-opacity": 0.12, "clip-path": `url(#${id}-b)` }));
      }
    }

    for (const m of spec.markers ?? []) {
      if (m.x < x0 || m.x > x1) continue;
      root.append(svg("line", { x1: px(m.x), x2: px(m.x), y1: M.t, y2: H - M.b, stroke: m.color ?? C.muted, "stroke-dasharray": m.dash ?? "3 3" }));
      text(root, px(m.x) + 4, H - M.b - 6, m.label, "start", m.color ?? C.muted);
    }

    for (const line of spec.lines) {
      let d = "";
      let pen = false;
      line.values.forEach((v, i) => {
        if (!ok(v)) return void (pen = false);
        d += `${pen ? "L" : "M"}${px(xs[i]).toFixed(1)},${py(v).toFixed(1)} `;
        pen = true;
      });
      root.append(svg("path", { d, fill: "none", stroke: line.color, "stroke-width": line.width ?? 1.6, "stroke-dasharray": line.dash ?? "", "stroke-linejoin": "round" }));
      if (line.dots)
        line.values.forEach((v, i) => ok(v) && root.append(svg("circle", { cx: px(xs[i]), cy: py(v), r: 2.4, fill: line.color })));
    }

    const cross = svg("line", { y1: M.t, y2: H - M.b, stroke: C.faint, visibility: "hidden" });
    const dots = spec.lines.map((l) => svg("circle", { r: 3.5, fill: l.color, stroke: C.page, "stroke-width": 1.5, visibility: "hidden" }));
    add(root, cross, ...dots);
    const hit = svg("rect", { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: "transparent" });
    root.append(hit);
    const hide = () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    };
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("pointermove", (ev) => {
      const r = root.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / r.width) * W;
      let best = 0;
      xs.forEach((x, i) => Math.abs(px(x) - mx) < Math.abs(px(xs[best]) - mx) && (best = i));
      const x = px(xs[best]);
      cross.setAttribute("x1", String(x));
      cross.setAttribute("x2", String(x));
      cross.setAttribute("visibility", "visible");
      const rows: [string, string, string?][] = [];
      spec.lines.forEach((l, i) => {
        const v = l.values[best];
        if (!ok(v)) return void dots[i].setAttribute("visibility", "hidden");
        dots[i].setAttribute("cx", String(x));
        dots[i].setAttribute("cy", String(py(v)));
        dots[i].setAttribute("visibility", "visible");
        rows.push([l.label, spec.yFmt(v), l.color]);
      });
      if (!rows.length) return hide();
      tipRows(tip, spec.xFmt(xs[best]), rows);
      placeTip(el, tip, (x / W) * el.clientWidth);
    });
  }
  onResize(el, draw);
}

export type Bars = {
  xs: number[];
  up: number[];
  down: number[];
  upLabel: string;
  downLabel: string;
  xFmt: (v: number) => string;
  yFmt: (v: number) => string;
  markers?: Marker[];
  height?: number;
  label?: string;
};

// Calls rise from the middle line and puts hang from it, one pair per strike.
export function mirrorBars(el: HTMLElement, spec: Bars): void {
  const H = spec.height ?? 240;
  const { root, tip } = frame(el, H, spec.label);
  const M = { l: 60, r: 14, t: 10, b: 26 };
  const top = Math.max(...spec.up, 1), bottom = Math.max(...spec.down, 1);
  const x0 = Math.min(...spec.xs), x1 = Math.max(...spec.xs);

  function draw() {
    root.replaceChildren();
    const W = Math.max(el.clientWidth, 260);
    root.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const inner = H - M.t - M.b;
    const mid = M.t + inner * (top / (top + bottom));
    const px = (x: number) => M.l + ((x - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
    const bw = Math.max(1.5, Math.min(14, ((W - M.l - M.r) / Math.max(spec.xs.length, 1)) * 0.36));
    const scale = (inner) / (top + bottom);
    root.append(svg("line", { x1: M.l, x2: W - M.r, y1: mid, y2: mid, stroke: C.lineStrong }));
    text(root, M.l - 8, M.t + 10, spec.yFmt(top), "end");
    text(root, M.l - 8, H - M.b, spec.yFmt(bottom), "end");
    text(root, M.l - 8, mid - 4, spec.upLabel, "end", C.ink);
    text(root, M.l - 8, mid + 13, spec.downLabel, "end", C.muted);
    for (const t of ticks(x0, x1, Math.max(3, Math.floor(W / 110)))) text(root, px(t), H - 8, spec.xFmt(t));
    for (const m of spec.markers ?? []) {
      if (m.x < x0 || m.x > x1) continue;
      root.append(svg("line", { x1: px(m.x), x2: px(m.x), y1: M.t, y2: H - M.b, stroke: m.color ?? C.muted, "stroke-dasharray": m.dash ?? "3 3" }));
      text(root, px(m.x) + 4, M.t + 10, m.label, "start", m.color ?? C.muted);
    }
    spec.xs.forEach((x, i) => {
      const u = spec.up[i] * scale, d = spec.down[i] * scale;
      if (u > 0) root.append(svg("rect", { x: px(x) - bw / 2, y: mid - u, width: bw, height: u, fill: C.ink, "fill-opacity": 0.75 }));
      if (d > 0) root.append(svg("rect", { x: px(x) - bw / 2, y: mid, width: bw, height: d, fill: C.muted, "fill-opacity": 0.6 }));
    });
    const hit = svg("rect", { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: "transparent" });
    root.append(hit);
    hit.addEventListener("pointerleave", () => (tip.hidden = true));
    hit.addEventListener("pointermove", (ev) => {
      const r = root.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / r.width) * W;
      let best = 0;
      spec.xs.forEach((x, i) => Math.abs(px(x) - mx) < Math.abs(px(spec.xs[best]) - mx) && (best = i));
      tipRows(tip, spec.xFmt(spec.xs[best]), [
        [spec.upLabel, spec.yFmt(spec.up[best]), C.ink],
        [spec.downLabel, spec.yFmt(spec.down[best]), C.muted],
      ]);
      placeTip(el, tip, (px(spec.xs[best]) / W) * el.clientWidth);
    });
  }
  onResize(el, draw);
}

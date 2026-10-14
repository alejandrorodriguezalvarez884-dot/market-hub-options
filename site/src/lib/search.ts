// The ticker box: type a name or a symbol, pick from what Yahoo knows, or press Enter with a symbol.
import { add, h } from "./dom";
import { api } from "./site";

type Hit = { symbol: string; name: string; exchange: string; type: string };

export function searchBox(form: HTMLFormElement, onPick: (ticker: string) => void): { set: (ticker: string) => void } {
  const input = form.querySelector<HTMLInputElement>("input")!;
  const list = form.querySelector<HTMLUListElement>(".search-list")!;
  let hits: Hit[] = [];
  let active = -1;
  let timer = 0;
  let asked = "";

  const close = () => {
    list.hidden = true;
    active = -1;
  };
  const pick = (ticker: string) => {
    close();
    input.value = ticker.toUpperCase();
    input.blur();
    onPick(ticker.toUpperCase());
  };
  const paint = () => {
    list.replaceChildren(
      ...hits.map((hit, i) => {
        const li = h("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        add(li, add(h("span", "min-w-0 truncate"), h("span", "num mr-2 text-ink-strong", hit.symbol), h("span", "text-muted", hit.name)),
          h("span", "flex-none text-[12px] text-faint", hit.exchange));
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(hit.symbol);
        });
        return li;
      }),
    );
    list.hidden = !hits.length;
  };

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return void ((hits = []), close());
    timer = window.setTimeout(async () => {
      asked = q;
      try {
        const found = await api<{ results: Hit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
        if (asked !== q) return;
        hits = found.results;
        active = -1;
        paint();
      } catch {
        hits = [];
        close();
      }
    }, 220);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      paint();
    } else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => window.setTimeout(close, 120));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const chosen = active >= 0 ? hits[active]?.symbol : input.value.trim();
    if (chosen) pick(chosen);
  });
  return { set: (ticker: string) => void (input.value = ticker) };
}

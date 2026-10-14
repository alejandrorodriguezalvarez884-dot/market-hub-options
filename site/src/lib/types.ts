// The shapes the API returns (see src/optionslab/chain.py and strategy.py).
export type Kind = "call" | "put";
export type LegKind = Kind | "stock";
export type Side = "long" | "short";

export type Expiration = { date: string; days: number };
export type Underlying = {
  ticker: string;
  name: string;
  currency: string;
  kind: string;
  spot: number;
  change: number | null;
  change_pct: number | null;
  previous_close: number | null;
  market_state: string;
  quote_time: string | null;
  rate: number;
  rate_is_bill: boolean;
  dividend_yield: number;
  earnings_date: string | null;
  realised_vol: Record<"20" | "60" | "250", number | null>;
  expirations: Expiration[];
};

export type Contract = {
  symbol: string;
  kind: Kind;
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  last_trade: string | null;
  volume: number | null;
  oi: number | null;
  mark: number | null;
  mark_source: "mid" | "last" | null;
  spread: number | null;
  spread_pct: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  itm: boolean;
  intrinsic: number;
  extrinsic: number | null;
  breakeven: number | null;
  to_breakeven: number | null;
  prob_itm: number | null;
  prob_touch: number | null;
  moneyness: number;
};

export type ChainSummary = {
  atm_strike: number | null;
  atm_iv: number | null;
  straddle: number | null;
  expected_move_pct: number | null;
  one_sigma: [number, number] | null;
  call_oi: number;
  put_oi: number;
  call_volume: number;
  put_volume: number;
  put_call_oi: number | null;
  put_call_volume: number | null;
  max_pain: number | null;
  iv_put_25d: number | null;
  iv_call_25d: number | null;
  skew_25d: number | null;
};

export type Chain = {
  ticker: string;
  expiry: string;
  days: number;
  years: number;
  spot: number;
  rate: number;
  dividend_yield: number;
  earnings_before: boolean;
  summary: ChainSummary;
  strikes: { strike: number; call: Contract | null; put: Contract | null }[];
};

export type Term = {
  expiry: string;
  days: number;
  years: number;
  atm_iv: number | null;
  straddle: number | null;
  expected_move_pct: number | null;
  call_oi: number;
  put_oi: number;
  call_volume: number;
  put_volume: number;
  skew_25d: number | null;
  max_pain: number | null;
  earnings_before: boolean;
};
export type Terms = { ticker: string; spot: number; iv30: number | null; terms: Term[] };

export type Leg = { kind: LegKind; side: Side; qty: number; strike?: number; expiry?: string; price?: number | null };
export type PricedLeg = Leg & { symbol: string; entry: number; mark: number; mark_source: string; iv: number | null; shares: number };
export type Greeks = { delta: number; gamma: number; theta: number; vega: number; rho: number };
export type Analysis = {
  ticker: string;
  spot: number;
  rate: number;
  dividend_yield: number;
  horizon: string;
  days: number;
  target: string | null;
  sigma: number;
  iv_shift: number;
  legs: PricedLeg[];
  cost: number;
  value: number;
  pnl_now: number;
  max_profit: number | null;
  max_loss: number | null;
  reward_risk: number | null;
  breakevens: number[];
  pop: number;
  one_sigma: [number, number] | null;
  greeks: Greeks;
  curves: { prices: number[]; expiry: number[]; now: number[]; target: number[] | null };
  notes: string[];
};

export type SavedStrategy = { id: string; name: string; ticker: string; legs: Leg[]; created_utc: string; updated_utc: string };

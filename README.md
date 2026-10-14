# Options Lab

A section of [Market Hub](https://themarkethub.app)'s private area, at
https://options.themarkethub.app (sign-in through Market Hub).

- **Chain**: every call and put of an expiration, each with its implied volatility, greeks,
  breakeven, time value and the risk-neutral odds of ending in the money; the expiration as a
  whole (at-the-money volatility, the move the straddle prices in, skew, open interest, max pain);
  and every expiration side by side (the term structure).
- **Strategy**: legs of calls, puts and shares, bought or sold, read as one position: what it pays
  at expiration and what it would be worth before then, breakevens, most and least, greeks, and
  the chance of ending with a profit at the volatility the market prices in. Strategies can be
  kept, per user, in Market Hub's database.

It describes; it does not recommend. Nothing here sends orders or connects to a broker.

Prices come from Yahoo Finance (delayed); every figure is computed here with Black-Scholes-Merton.
FastAPI (`src/optionslab/`) + Astro (`site/`), one container on Cloud Run. `make` lists the targets.

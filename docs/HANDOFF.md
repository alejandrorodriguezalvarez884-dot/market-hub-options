# Handoff — Options Lab

Una sección de My Hub (el área privada de Market Hub) para leer opciones call y put con detalle y
construir estrategias con ellas. Repo `market-hub-options`, servicio de Cloud Run `options-lab`,
subdominio `options.themarkethub.app`, con el login del hub.

Decisiones del usuario (2026-10-14):
- **Servicio propio**, como las otras herramientas, con su repo y su subdominio.
- **Con probabilidad de beneficio** en las estrategias (la que implican los precios, no una
  previsión).
- **Las estrategias se guardan en Firestore**, por usuario.

## Qué hace

- **Chain** (`/`, `?t=AAPL&e=2026-11-20`): el subyacente (precio, IV a 30 días, volatilidad
  realizada a 20/60/250 sesiones, tipo libre de riesgo, rentabilidad por dividendo, próximos
  resultados), la fila de vencimientos, y para el vencimiento elegido: IV at-the-money, movimiento
  esperado (el straddle), rango de una sigma, skew 25-delta, put/call de OI y de volumen, max pain;
  la sonrisa de volatilidad; OI o volumen por strike; la cadena (calls | strike | puts) y la ficha
  de un contrato (marca, bid × ask, spread, valor intrínseco y temporal, breakeven, odds de acabar
  ITM y de tocar el strike, griegas por acción y por contrato). Abajo, todos los vencimientos
  (estructura temporal de la IV) en gráfico y tabla.
- **Strategy** (`/strategy/?t=AAPL`): hasta 8 patas (call, put, acciones; largo o corto), desde
  la cadena ("Add long/short to strategy"), desde una forma (18 plantillas) o a mano. El API
  devuelve el P&L al primer vencimiento, hoy y en una fecha intermedia (slider), con un
  desplazamiento de volatilidad (slider); breakevens, máximo y mínimo (o ilimitado), reward/risk,
  probabilidad de beneficio, griegas de la posición, y el valor de hoy frente al de apertura.
  Se guardan por usuario (hasta 50) y se reabren; las patas sin precio se guardan al de hoy, así
  una estrategia guardada se sigue desde ese día.
- **Method**: fuentes y fórmulas (no se explica nada de eso en las otras páginas).

El borrador de la estrategia que se está construyendo vive en `localStorage` del navegador
(`optionslab.draft`): solo una comodidad, lo guardado de verdad va por el API.

## Cómo está hecho

- `src/optionslab/pricing.py`: Black-Scholes-Merton (precio, griegas, IV por bisección,
  probabilidad ITM/touch, CDF y cuantiles lognormales). Europeo aunque las opciones de EE. UU.
  sean americanas: es la lectura habitual de una cadena.
- `market.py`: Yahoo vía `yfinance` detrás de una caché en memoria (cadena 5 min; histórico y
  tipo 6 h), una lectura por clave a la vez. El tipo es `^IRX` / 100 (si falla, 4 %).
- `chain.py`: marca = mid si hay bid/ask, si no el último precio (fuera de horario Yahoo da
  bid/ask 0 y, antes de la apertura, OI 0: la web lo dice en vez de dibujar barras vacías).
  IV at-the-money interpolada en la sonrisa OTM; IV 30 d interpolada en varianza total; la
  estructura temporal lee hasta 40 vencimientos en paralelo (8 hilos).
- `strategy.py`: horizonte = primer vencimiento; cada pata se valora con su IV (o la ATM si no
  tiene) + el desplazamiento. Breakevens y extremos sobre una rejilla de 1.200 precios hasta 3× el
  strike mayor; ilimitado según las calls/acciones netas. Probabilidad de beneficio: lognormal
  neutral al riesgo con la IV ATM del horizonte, sumada entre breakevens.
- `saved.py`: un documento por usuario en `option_strategies` del Firestore `market-hub` (el
  del portal) con `OPTIONSLAB_FIRESTORE=1`; en local, `data/strategies/`. Sin el hub (`HUB_URL`
  vacío) todo es de un usuario `local`.
- `api.py`: las escrituras exigen `Origin` del propio sitio (como el portal).
- Web: Astro + SVG propio (`site/src/lib/chart.ts`), sin librería de gráficos.

## Dónde estamos

**2026-10-14: hecho y probado en local, sin desplegar.** 49 tests en verde (`make test`),
`astro check` sin errores. Probado en el navegador con datos reales (AAPL y SPY, antes de la
apertura): cadena, ficha, gráficos, estrategia desde la cadena y desde plantilla (iron condor),
guardar, y la vista de móvil sin scroll horizontal.

Pendiente:
1. **Desplegar** (`make deploy`, que crea el servicio `options-lab` en el proyecto del portal y le
   da `roles/datastore.user`), mapear `options.themarkethub.app`
   (`gcloud beta run domain-mappings create --service options-lab --domain options.themarkethub.app --region europe-west1`)
   y el CNAME `options` → `ghs.googlehosted.com` en Cloudflare (sin proxy).
2. Cuando responda por HTTPS, desplegar el portal y las otras herramientas con el enlace
   `Options` de My Hub (ya commiteado en cada repo).
3. App de móvil (`market-hub-mobile`): añadir la herramienta a `src/lib/tools.ts` y a
   `tool_pages` del portal, si el usuario lo quiere.
4. Mirarlo con el mercado abierto (bid/ask y OI reales) y con un índice de vencimientos diarios
   (SPY, QQQ) por tiempos de la estructura temporal.

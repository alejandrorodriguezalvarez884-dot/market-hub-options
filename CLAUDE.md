# Instrucciones para agentes

Lee primero [docs/HANDOFF.md](docs/HANDOFF.md): estado, pendientes y siguientes pasos.

Reglas que no se negocian:
- **Nada de trading.** No se escribe código que envíe órdenes ni que se conecte a un broker, y
  no se usa ningún conector de broker (IBKR u otro), ni siquiera para descargar precios o cadenas
  de opciones. Los botones dicen "Add long / Add short to strategy", nunca "Buy" ni "Sell".
- **Describir, no recomendar.** La herramienta lee una cadena y la estrategia que el usuario
  construye. No elige contratos ni estrategias, no ordena las estrategias por lo buenas que sean,
  no dice cuál conviene y no predice nada. Las plantillas son formas de partida, en orden
  alfabético dentro de su grupo, sin ninguna destacada.
- **Las probabilidades son las que implican los precios** (mundo neutral al riesgo, volatilidad
  implícita), no una previsión. Así se dicen en el pie y en Method. Decisión del usuario
  (2026-10-14): la probabilidad de beneficio entra.
- **Los números los calcula el código.** `pricing.py` (Black-Scholes-Merton), `chain.py` y
  `strategy.py`, igual para todos los tickers. Ninguna IA escribe texto en la web.
- **No gasta en ninguna API**, y así debe seguir: cadenas, precios y el tipo del T-bill salen de
  Yahoo Finance, sin clave. Antes de meter una API de pago se le pide permiso.
- **Nada programado y nada en GitHub Actions.** Todo se lanza a mano desde el `Makefile`. Una
  cadena se lee de Yahoo cuando alguien la pide y se guarda 5 minutos en memoria.
- **Claves solo en `.env` o en el entorno.** Nunca en el repo, en logs ni en commits, y nunca
  el cuerpo de un error de un proveedor en lo que ve el visitante.
- **Lo que se guarda de un usuario son solo sus estrategias** (colección `option_strategies` del
  Firestore del portal, un documento por usuario con el id de la sesión del hub). El portal
  (`market-hub-landing`, `DELETE /api/me`) borra ese documento al borrar la cuenta: si cambia la
  colección o la clave, se cambia allí también.

Convenciones:
- Hablar con el usuario en español. Código, comentarios y textos de la web en inglés.
- Python 3.12 con `uv`. Tests con `make test`; web con `make check`.
- Cada cambio en una fórmula (precio, griegas, volatilidad implícita, odds, pagos de una
  estrategia) lleva su test en `tests/`. El Yahoo falso de `tests/conftest.py` pone precios con la
  fórmula a una volatilidad conocida, para poder comprobar lo que se lee de vuelta.
- La web no explica cómo se calcula cada cifra: eso va en la página Method y en `docs/HANDOFF.md`.
- La web es una sección de My Hub: `site/src/styles/global.css` es el del portal
  (`market-hub-landing`) con lo propio al final, y `HubNav.astro` es copia de la navegación de
  `App.astro` del portal. Un cambio en cualquiera de los dos se trae aquí.
- Al terminar una tarea relevante, actualizar "Dónde estamos" en `docs/HANDOFF.md`.

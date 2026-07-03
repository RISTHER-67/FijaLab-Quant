<div align="center">

# ◉ FIJALAB ✕ QUANT

### Terminal de análisis de apuestas de fútbol con estética de _quant trading_

Un bot analista que investiga un partido con IA + búsqueda web y emite picks con
**probabilidades, valor esperado (EV), simulación Monte Carlo y tracking real de resultados** —
todo en un dashboard oscuro estilo mesa de trading.

<br>

![Node](https://img.shields.io/badge/Node.js-≥22.5-00FF87?style=for-the-badge&logo=node.js&logoColor=black)
![Express](https://img.shields.io/badge/Express-4.x-1C1C1C?style=for-the-badge&logo=express)
![SQLite](https://img.shields.io/badge/SQLite-nativo-00D9FF?style=for-the-badge&logo=sqlite&logoColor=black)
![IA](https://img.shields.io/badge/IA-multi--proveedor-B266FF?style=for-the-badge)
![Licencia](https://img.shields.io/badge/uso-educativo-FFB300?style=for-the-badge)

<br>

`POISSON` · `VALUE` · `SELF-CHECK` · `MONTE CARLO` · `EQUITY CURVE`

</div>

---

> [!WARNING]
> **La fija no existe.** Esto es análisis estadístico, **no** asesoría financiera. Ningún pick está garantizado:
> siempre se muestra la probabilidad. **+18 · Juega responsablemente · Nunca apuestes dinero que no puedas perder.**

---

## ⚡ ¿Qué hace?

Escribes **local · visitante · torneo · perfil de riesgo** y pulsas **▶ ANALIZAR**. A partir de ahí:

1. 🔎 La IA **busca en la web** forma reciente, promedios de goles y córners, remates, **cuotas 1X2 del mercado**, alineaciones y bajas.
2. 🧮 Responde en **JSON estricto** con probabilidades, xG y 4 picks (ganador · goles · córners · libre) + una combinada.
3. 🛡️ El **servidor recalcula el EV** con su propia regla (`valor = cuota mercado > cuota justa`), asigna _stakes_ (1–2 % de banca según perfil) y **detecta patas contradictorias** en la combinada.
4. 🎲 Corre una **simulación Monte Carlo real de 5 000 partidos** (Poisson con los xG del análisis): over/under 2.5, ambos marcan, marcador más probable y un **self-check** que contrasta el 1X2 simulado contra el del modelo.
5. 📊 Guarda todo en **SQLite**. Marcas cada pick 🟢 ganada / 🔴 perdida / 🟡 nula y obtienes **win rate, ROI, racha, profit en soles, equity curve y rendimiento por mercado**.

---

## 🖥️ El dashboard

| Panel | Qué muestra |
|---|---|
| **Señal principal** | Confianza gigante con glow + probabilidades 1X2 con cuotas + xG del modelo |
| **Bet Builder** | Multiplicador `X39.3` estilo cupón, patas, prob. estimada, stake y EV |
| **Score global** | _Gauge_ circular SVG animado 0–100 (promedio de confianzas) |
| **Confianza por pick** | Bar chart en canvas con gradiente verde/ámbar/rojo |
| **Matriz de robustez** | Tabla mercados × métricas con celdas coloreadas y flag `+EV` |
| **Monte Carlo** | Histograma de goles + %over/under, %ambos marcan, marcador moda |
| **Feed del analista** | Log con timestamps donde caen los picks como órdenes de trading |
| **Alertas** | Contradicciones detectadas entre patas de la combinada |
| **Ticker** | Estado LIVE, motor, win rate, ROI, banca, racha (scroll continuo) |

> 💡 _Añade aquí tu captura:_ `docs/screenshot.png` — arrastra una imagen del dashboard y enlázala:
> `![FIJALAB QUANT](docs/screenshot.png)`

---

## 🚀 Arranque en 30 segundos

```bash
git clone <tu-repo> fijalab-quant
cd fijalab-quant
npm install
npm start
# → http://localhost:4577
```

Sin configurar nada arranca en **MODO DEMO** (datos sintéticos verosímiles) para que pruebes
**toda** la interfaz sin gastar un centavo ni una API key.

---

## 🔌 Conectar una IA de verdad

Copia `.env.example` → `.env`, pon **una sola** clave y reinicia. El sistema **auto-detecta** el proveedor.
La API key vive **solo en el backend** (variable de entorno) — nunca llega al navegador.

### ☁️ Proveedores en la nube (con búsqueda web en vivo)

| Proveedor | Variable | Modelo por defecto | Búsqueda web |
|---|---|---|---|
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` | ✅ nativa |
| **Google Gemini** | `GEMINI_API_KEY` | `gemini-2.5-flash` | ✅ Google Search |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | ✅ `web_search` |
| **Perplexity** | `PERPLEXITY_API_KEY` | `sonar-pro` | ✅ integrada |
| **OpenRouter** | `OPENROUTER_API_KEY` | `openai/gpt-4o` | ✅ plugin web |

Opcional: fuerza proveedor con `AI_PROVIDER=` y modelo con `AI_MODEL=`.

### 🏠 IA local con Ollama (gratis, sin internet)

```bash
# .env
OLLAMA_MODEL=qwen2.5:7b
```

> [!IMPORTANT]
> Los modelos locales **no tienen búsqueda web**, así que los datos son **estimados** (no cuotas ni
> alineaciones en vivo). La app lo marca solo con la advertencia `DATOS NO EN VIVO`. Ideal para **probar
> la interfaz**, hacer _reasoning_ offline o experimentar sin costo. Para picks con datos reales, usa un
> proveedor de nube de la tabla de arriba.

---

## 💻 ¿Qué modelo local elegir? (guía por hardware)

Con una **RTX 4050 de 6 GB de VRAM + 16 GB RAM + Ryzen 7 7000**, el cuello de botella es la VRAM.
La regla: un modelo **7–8B en cuantización Q4** ocupa ~4.5–5 GB y **entra completo en la GPU** (rápido).
Para esta tarea manda el **seguimiento de instrucciones y el JSON limpio**, no el tamaño bruto.

| Modelo (`ollama pull ...`) | Tamaño (Q4) | Encaje en 6 GB | Para este proyecto |
|---|---|---|---|
| 🥇 **`qwen2.5:7b`** | ~4.7 GB | ✅ completo | **Mejor opción.** Excelente en instrucciones + JSON estricto |
| 🥈 **`llama3.1:8b`** | ~4.9 GB | ✅ completo | Muy sólido, gran razonamiento general |
| 🥉 **`mistral:7b`** | ~4.4 GB | ✅ completo | El más rápido; JSON correcto |
| **`gemma2:9b`** | ~5.4 GB | ⚠️ justo (algo va a RAM) | Buena calidad pero más lento en 6 GB |
| **`qwen2.5:14b`** | ~9 GB | ❌ no entra | Se parte a RAM → lento, no recomendado aquí |

> **Recomendación directa:** empieza con **`qwen2.5:7b`**. Es el que mejor obedece el
> _"responde SOLO con JSON"_ que exige este bot, y vuela dentro de tus 6 GB de VRAM.
> Sobre "Gemma 4": la familia Gemma va por Gemma 2/3 — su `gemma2:9b` es capaz pero queda **apretado**
> en 6 GB; si quieres Gemma sin que se ralentice, tira de una variante ~4B. Aun así, para _structured
> output_ Qwen2.5 7B rinde mejor en tu equipo.

```bash
# Instalación local completa
# 1) instala Ollama desde https://ollama.com
ollama pull qwen2.5:7b     # descarga el modelo (~4.7 GB)
ollama serve               # deja Ollama corriendo
# 2) en .env:  OLLAMA_MODEL=qwen2.5:7b
npm start
```

---

## 🧬 Cómo funciona por dentro

```
 ▶ ANALIZAR
     │
     ▼
 ┌─────────────────────── CICLO DE EJECUCIÓN ───────────────────────┐
 │ 01 BUSCAR → 02 EXTRAER → 03 VALIDAR → 04 PONDERAR → 05 ARMAR → 06 EMITIR │
 └──────────────────────────────────────────────────────────────────┘
     │            │            │             │            │          │
   IA + web    parse JSON   esquema OK   EV/stake      combinada   SQLite
   (SSE en          (auto-repair)   server-side   sin contra-   + feed
   vivo)                                          dicciones
```

- **SSE (Server-Sent Events):** el frontend ve iluminarse cada paso del ciclo en tiempo real.
- **EV recalculado en el servidor:** no se confía en el `valor` que declare la IA; se computa
  `cuota_justa = 1 / (confianza/100)` y `valor = cuota_mercado > cuota_justa`.
- **Monte Carlo Poisson** corre en el navegador (5 000 sims) para no bloquear el backend.
- **Auto-reparación de JSON** para tolerar respuestas con comas colgantes o texto extra.

---

## 🗂️ Estructura

```
fijalab-quant/
├─ server.js        → Express: endpoints (SSE de análisis, historial, stats, settings)
├─ providers.js     → adaptadores de IA: OpenAI · Gemini · Anthropic · Perplexity · OpenRouter · Ollama
├─ analyst.js       → system prompt, validación, EV, stakes, Monte Carlo, modo demo
├─ db.js            → SQLite (node:sqlite): métricas, equity curve, rendimiento por mercado
├─ public/
│  ├─ index.html    → dashboard (grid 12 col, responsive)
│  ├─ styles.css    → tema quant: negro puro, neón, JetBrains Mono
│  └─ app.js        → pipeline en vivo, canvas charts, Monte Carlo, historial
├─ data/            → fijalab.db (se crea sola)
└─ .env.example     → plantilla de configuración
```

## 🛠️ Stack

- **Backend:** Node.js + Express, **SQLite nativo** (`node:sqlite`, cero dependencias que compilar)
- **Frontend:** HTML/CSS/JS **vanilla** — sin frameworks, sin build. Charts en `<canvas>` a mano.
- **IA:** capa de adaptadores agnóstica — `fetch` neutral, cualquier proveedor con una key
- **Tipografía:** JetBrains Mono · **Paleta:** verde `#00FF87` · rojo `#FF3B5C` · ámbar `#FFB300` · cyan `#00D9FF` · púrpura `#B266FF` · amarillo `#FFE600`

---

<div align="center">

**⚠ +18 · ANÁLISIS ESTADÍSTICO — NO ES ASESORÍA FINANCIERA · LA FIJA NO EXISTE · JUEGA RESPONSABLEMENTE**

_Nunca apuestes dinero que no puedas perder._

</div>

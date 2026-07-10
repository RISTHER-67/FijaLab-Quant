// providers.js — Adaptadores neutrales para la API de cualquier IA con búsqueda web.
// Todos usan fetch nativo; se selecciona con AI_PROVIDER o auto-detección por API key.

// Presupuesto de tokens de salida. El Bet Builder pide 10-16 picks => JSON grande;
// además en Gemini/Anthropic el "thinking" consume de este presupuesto, así que hay
// que dejar margen o el JSON se trunca a media respuesta.
const MAX_OUT = 16000;

function fail(provider, status, body) {
  let msg = body;
  try { msg = JSON.parse(body); msg = msg.error?.message || msg.message || body; } catch { /* texto plano */ }
  throw new Error(`[${provider}] HTTP ${status}: ${String(msg).slice(0, 300)}`);
}

// ---------- OpenAI (Responses API + web_search) ----------
async function callOpenAI(apiKey, model, system, user) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      instructions: system,
      input: user,
      tools: [{ type: 'web_search' }],
      temperature: 0.3,
      max_output_tokens: MAX_OUT
    })
  });
  if (!res.ok) fail('openai', res.status, await res.text());
  const json = await res.json();
  let text = '';
  let searches = 0;
  for (const item of json.output || []) {
    if (item.type === 'web_search_call') searches++;
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') text += c.text;
      }
    }
  }
  return { text, searches };
}

// ---------- Google Gemini (google_search grounding) ----------
async function callGemini(apiKey, model, system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      tools: [{ google_search: {} }],
      // thinkingBudget acota el razonamiento interno para que NO se coma todo el
      // presupuesto y el JSON salga completo (gemini-2.5-flash trunca si se pasa).
      generationConfig: {
        maxOutputTokens: MAX_OUT,
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: 3000 }
      }
    })
  });
  if (!res.ok) fail('gemini', res.status, await res.text());
  const json = await res.json();
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
  const searches = cand?.groundingMetadata?.webSearchQueries?.length || 0;
  return { text, searches };
}

// ---------- Anthropic (web_search server tool, HTTP crudo) ----------
function anthropicSearchTool(model) {
  const modern = /(sonnet-4-6|sonnet-5|opus-4-6|opus-4-7|opus-4-8|fable)/.test(model);
  return { type: modern ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 6 };
}

async function callAnthropic(apiKey, model, system, user) {
  const messages = [{ role: 'user', content: user }];
  let searches = 0;
  // El bucle maneja stop_reason 'pause_turn' de las herramientas de servidor
  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUT,
        temperature: 0.3,
        system,
        messages,
        tools: [anthropicSearchTool(model)]
      })
    });
    if (!res.ok) fail('anthropic', res.status, await res.text());
    const json = await res.json();
    searches += (json.content || []).filter(b => b.type === 'server_tool_use').length;
    if (json.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: json.content });
      continue;
    }
    const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return { text, searches };
  }
  throw new Error('[anthropic] Demasiadas continuaciones (pause_turn)');
}

// ---------- Perplexity (búsqueda integrada en modelos sonar) ----------
async function callPerplexity(apiKey, model, system, user) {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: MAX_OUT
    })
  });
  if (!res.ok) fail('perplexity', res.status, await res.text());
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  const searches = (json.citations || json.search_results || []).length;
  return { text, searches };
}

// ---------- OpenRouter (plugin web sobre cualquier modelo) ----------
async function callOpenRouter(apiKey, model, system, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'FIJALAB QUANT'
    },
    body: JSON.stringify({
      model,
      plugins: [{ id: 'web' }],
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: MAX_OUT
    })
  });
  if (!res.ok) fail('openrouter', res.status, await res.text());
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  const searches = (json.citations || []).length;
  return { text, searches };
}

// ---------- Groq (compound: búsqueda web integrada, inferencia ultrarrápida) ----------
// Modelos groq/compound y groq/compound-mini traen web search + code execution.
// Los modelos llama-* de Groq NO tienen búsqueda web (datos estimados).
async function callGroq(apiKey, model, system, user) {
  // Groq gratis = 30k tokens/min. El "requested" reserva max_completion_tokens, así que
  // lo capamos bajo (el JSON de salida es chico) para no chocar con el límite TPM.
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
      max_completion_tokens: Math.min(MAX_OUT, 3500)
    })
  });
  if (!res.ok) fail('groq', res.status, await res.text());
  const json = await res.json();
  const msg = json.choices?.[0]?.message || {};
  const text = msg.content || '';
  const tools = Array.isArray(msg.executed_tools) ? msg.executed_tools : [];
  const searches = tools.filter(t => /search/i.test(t.type || t.name || '')).length;
  return { text, searches };
}

// ---------- Ollama (IA local, endpoint compatible con OpenAI) ----------
// Sin API key. Corre en tu máquina. NO tiene búsqueda web => datos no en vivo.
async function callOllama(_apiKey, model, system, user) {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  let res;
  try {
    res = await fetch(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' }, // fuerza JSON válido en Ollama
        temperature: 0.3,
        max_tokens: MAX_OUT,
        stream: false
      })
    });
  } catch (e) {
    throw new Error(`[ollama] No se pudo conectar a ${host} — ¿está corriendo Ollama? (ollama serve). ${e.message}`);
  }
  if (!res.ok) fail('ollama', res.status, await res.text());
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  return { text, searches: 0 };
}

// ---------- Registro y detección ----------
export const PROVIDERS = {
  openai:     { label: 'OPENAI',     env: 'OPENAI_API_KEY',     defaultModel: 'gpt-4o',            call: callOpenAI },
  gemini:     { label: 'GEMINI',     env: 'GEMINI_API_KEY',     defaultModel: 'gemini-2.5-flash',  call: callGemini },
  anthropic:  { label: 'ANTHROPIC',  env: 'ANTHROPIC_API_KEY',  defaultModel: 'claude-sonnet-4-6', call: callAnthropic },
  groq:       { label: 'GROQ',       env: 'GROQ_API_KEY',       defaultModel: 'groq/compound-mini', call: callGroq },
  perplexity: { label: 'PERPLEXITY', env: 'PERPLEXITY_API_KEY', defaultModel: 'sonar-pro',         call: callPerplexity },
  openrouter: { label: 'OPENROUTER', env: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-4o',     call: callOpenRouter },
  ollama:     { label: 'OLLAMA·LOCAL', env: 'OLLAMA_MODEL',     defaultModel: 'qwen2.5:7b',        call: callOllama, local: true }
};

// Devuelve {name, label, model, apiKey, call, local} o null (=> modo demo)
export function detectProvider() {
  const forced = (process.env.AI_PROVIDER || '').toLowerCase().trim();
  if (forced === 'demo') return null;

  // Ollama es local (sin API key): se activa si se fuerza o si hay OLLAMA_MODEL
  if (forced === 'ollama' || (!forced && process.env.OLLAMA_MODEL)) {
    const p = PROVIDERS.ollama;
    return {
      name: 'ollama', label: p.label, call: p.call, local: true, apiKey: null,
      model: process.env.AI_MODEL || process.env.OLLAMA_MODEL || p.defaultModel
    };
  }

  if (forced && PROVIDERS[forced]) {
    const p = PROVIDERS[forced];
    const apiKey = process.env[p.env];
    if (!apiKey) throw new Error(`AI_PROVIDER=${forced} pero falta la variable ${p.env}`);
    return { name: forced, label: p.label, model: process.env.AI_MODEL || p.defaultModel, apiKey, call: p.call };
  }
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.local) continue; // ollama no se auto-detecta por key
    const apiKey = process.env[p.env];
    if (apiKey) return { name, label: p.label, model: process.env.AI_MODEL || p.defaultModel, apiKey, call: p.call };
  }
  return null; // modo demo
}

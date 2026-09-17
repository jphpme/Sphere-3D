# Orbit's Free Model Catalog

Status: **implemented** — one table now backs both endpoints, with
Qwen3-30B-A3B and GLM-4.7-Flash added as free tool-calling options. One
decision is left open on purpose (Gemma 4 and `tools`), recorded under
[Open decision](#open-decision-gemma-4-and-tools).

Last reviewed: 2026-09-17

## Why

Orbit reaches Workers AI through the `AI` binding: no API key, no vendor
SDK, and no per-request bill inside the free allocation. What it did not
have is a *current* model list. `functions/api/models.ts` carried its own
copy of the picker's list with a comment asking the next person to keep it
in sync with `MODEL_MAP` in the chat proxy — and the copy had outlived two
of its entries. `llama-3.1-70b` and `llama-3.1-8b` are no longer in
Cloudflare's catalog (their model pages 404), and
`@hf/nousresearch/hermes-2-pro-mistral-7b` was still listed as
tool-capable after it had left as well. Selecting any of them returned the
default model's answer, silently, because the proxy's fallback is
`MODEL_MAP[requested] ?? MODEL_MAP.default`.

Two things were missing rather than wrong. Nothing in the code said which
models may call tools — the routing decision that decides whether Orbit's
discovery tools and action cards work at all — and the free tier had since
gained two models that cost less per turn than the one we default to.

## What is actually free

| | Workers Free | Workers Paid |
|---|---|---|
| Included | **10,000 Neurons/day**, resets 00:00 UTC | 10,000/day, then $0.011 per 1,000 |
| Text-generation rate limit | 300 requests/minute | 300 requests/minute |

The allowance is **per account and shared**: Orbit chat, voice (Whisper
STT, MeloTTS) and the catalog embedding pipeline (`bge-base-en-v1.5` is
6,058 neurons per M input tokens) draw on the same 10,000. Past it the
proxy's existing quota gate turns the failure into a typed 503 —
`isWorkersAiQuotaError` in `_lib/workers-ai-error.ts` — which is what
flips the SPA's degraded-mode badge, so the catalog change does not need
a new failure path.

The models Cloudflare requires a paid billing method for are therefore
**absent from the table by decision, not by oversight**: `kimi-k2.6`,
`kimi-k2.7-code`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`,
`deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`. They are free-tier
*ineligible*, not merely expensive — a deployment without a billing
method cannot call them at all. ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[limits](https://developers.cloudflare.com/workers-ai/platform/limits/))

## The catalog

One table, `functions/api/_lib/ai-models.ts`, in catalog order
(alphabetical by friendly id — load-bearing, because `chatUI`
auto-persists the first id `/api/models` returns as the model for a fresh
install). Neuron figures are per million tokens, from the pricing table
above; the turns/day column is the allowance divided by a representative
Orbit turn of 4,000 input tokens (a system prompt, the dataset context,
up to 22 history messages) and 400 output tokens.

| Friendly id | Workers AI id | Ctx | Tools | Vision | Neurons/M in / out | ~Turns/day |
|---|---|---|---|---|---|---|
| `gemma-4-26b-a4b-it` *(default)* | `@cf/google/gemma-4-26b-a4b-it` | 256k | — | ✅ | 9,091 / 27,273 | ~210 |
| `glm-4.7-flash` **(new)** | `@cf/zai-org/glm-4.7-flash` | 131k | ✅ | — | 5,500 / 36,400 | ~270 |
| `llama-3.2-11b-vision` | `@cf/meta/llama-3.2-11b-vision-instruct` | 128k | — | ✅ legacy | 4,410 / 61,493 | ~240 |
| `llama-3.2-3b` | `@cf/meta/llama-3.2-3b-instruct` | 80k | — | — | 4,625 / 30,475 | ~325 |
| `llama-3.3-70b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24k | ✅ | — | 26,668 / 204,805 | ~55 |
| `llama-4-scout` | `@cf/meta/llama-4-scout-17b-16e-instruct` | 131k | ✅ | ✅ | 24,545 / 77,273 | ~80 |
| `qwen3-30b-a3b-fp8` **(new)** | `@cf/qwen/qwen3-30b-a3b-fp8` | 32k | ✅ | — | 4,625 / 30,475 | ~325 |

Dropped: `llama-3.1-70b`, `llama-3.1-8b` (retired upstream) and the
`hermes` entry in the tool set (an `@hf/` id, not a Workers AI model).

## The two additions

Both are free-tier eligible, both are documented as function-calling, and
both cost **less per turn than the default model** — which is the whole
argument against a shared 10,000/day allowance:

- **`qwen3-30b-a3b-fp8`** — mixture-of-experts, 30B total and 3B active,
  so it prices like a 3B model (4,625 / 30,475 neurons per M) while
  answering like a much larger one. The cheapest tool-capable model in
  the catalog, and the one to reach for on tool-driven turns.
- **`glm-4.7-flash`** — Zhipu's fast multilingual model, 131k window,
  a third of the default's input cost. Worth having for the class of turn
  that feeds it a lot of catalog context.

Nothing else changed about how a model is used: the proxy already
forwards `tools` and normalises whatever envelope comes back
(`extractModelText` / `extractModelToolCalls`), so a new tool-capable
entry is a table row plus the flag.

## The thinking-off flag

All three reasoning models in the catalog deliberate before answering
unless the request says not to. The proxy already handled this for Gemma 4
(`THINKING_DEFAULT_OFF_MODELS` → `chat_template_kwargs.enable_thinking =
false`, plus an explicit `reasoning_effort: null`, because absent is not
the same as off for the templates that read it). The same flag covers the
two new models, verified against each model's own chat template rather
than assumed:

- **GLM-4.7-Flash** emits `<think>` unless `enable_thinking` is defined and
  false (`zai-org/GLM-4.7-Flash` `chat_template.jinja`). Cloudflare's model
  page also documents a generic `reasoning_effort` knob; the chat template
  is what actually reads the flag.
- **Qwen3-30B-A3B** emits an empty `<think></think>` block when
  `enable_thinking` is false (`Qwen/Qwen3-30B-A3B` `tokenizer_config.json`).

## Open decision: Gemma 4 and tools

Cloudflare lists Gemma 4 as function-calling, and an earlier revision of
the proxy had it in `TOOL_CALLING_MODELS`. Commit `0b0562bc` (*"Route
Gemma chat without tools"*) removed it, and the test it left behind asserts
the consequence deliberately: with Gemma the request keeps `stream: true`
and `{ returnRawResponse: true }` and carries **no** `tools`.

The reason is not a capability gap but a **trade in the reply's shape**.
The tool path buffers: `toolStreamShim` calls Workers AI non-streaming and
wraps the finished reply in OpenAI-format SSE chunks, while the plain-text
path streams token by token. Gemma is the default model, so putting it in
the tool set converts every Orbit answer from a reply that types itself out
into one that lands in a lump — and buys tool-driven discovery (and its
action cards) on the default model, which the client-side local engine
otherwise supplies on its own.

**Recommendation:** leave it out until a turn's tools are worth the
streaming. The way to have both is to make the tool path stream — Workers
AI's own OpenAI-compatible endpoint returns tool-call deltas — which is a
change to `toolStreamShim`, not to this table. Flipping the flag without
that is one line in the catalog, and this section is the record of what it
costs.

## Non-goals

- **Desktop (Tauri).** `apiUrl: ''` there, so Orbit is off regardless of
  what the catalog offers. Pointing it at a deployment is a separate
  decision, not a model-list one.
- **Runtime catalog discovery.** The `AI` binding has no model-listing
  call; Cloudflare's model-search API wants an account token. A tested
  static table is the honest form, and the drift it used to suffer is now
  a compile-time one — one table, two consumers, both under test.
- **Voice and embedding models.** They share the allowance and are
  untouched here.
- **A picker UI change.** The select still shows bare ids; nothing about
  the new entries needs a label the list cannot carry.

## Verification

- `functions/api/_lib/ai-models.test.ts` — catalog invariants (unique ids,
  `@cf/` only, alphabetical so `models[0]` is the default), the capability
  sets against the specs they derive from, the retired entries staying
  retired, and the four `applyModelInputDefaults` shapes.
- `functions/api/models.test.ts` — the endpoint publishes exactly
  `modelIds()`, in order, and still reports a missing binding as 503.
- `functions/api/chat/completions.test.ts` — unchanged, and green: the
  rewiring did not move the routing.
- **Still to smoke on a deployment:** a live turn against each new model,
  because the thinking-off flag and the tool-call envelope are verified
  against the templates and the docs here, not against the binding. That
  check is one request per model with `tools` set.

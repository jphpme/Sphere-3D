// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Workers AI model catalog behind Orbit's model picker.
 *
 * One table, because there used to be two: the proxy's friendly-name map
 * and the list `/api/models` handed the picker were kept in sync by a
 * comment, and drifted. The picker still offered two Llama 3.1 models
 * Cloudflare has retired — their catalog pages 404 — while the proxy
 * quietly answered every request for them with the default model.
 *
 * It also puts each model's *capabilities* beside its id, because that
 * is what the proxy actually routes on: whether `tools` may be
 * forwarded, whether the model takes OpenAI-style multipart content, and
 * whether its thinking flag has to be cleared before it will answer
 * rather than deliberate.
 *
 * Every entry is free-tier eligible: Workers AI's free allocation is
 * 10,000 Neurons/day per account, shared with voice and embeddings. The
 * models Cloudflare requires a paid billing method for (`kimi-k2.6`,
 * `kimi-k2.7-code`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`,
 * `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`) are deliberately
 * absent rather than offered and then refused. Per-model neuron costs
 * and the budget arithmetic are in docs/ORBIT_MODEL_CATALOG_PLAN.md.
 */

export interface AiModelSpec {
  /** Friendly id: what the client stores, sends, and shows in the picker. */
  readonly id: string
  /** Workers AI model id, passed straight to `env.AI.run()`. */
  readonly cfId: string
  /** `tools` is forwarded and the reply's tool_calls are normalised. */
  readonly tools?: true
  /** Accepts OpenAI multipart content (text + image_url) unchanged. */
  readonly nativeMultimodal?: true
  /** Needs the separate image field + Meta community license acceptance. */
  readonly legacyVision?: true
  /** Deliberates before answering unless the request clears the flag. */
  readonly thinkingOff?: true
}

/**
 * Every model the picker offers, in the order `/api/models` returns it.
 *
 * Alphabetical by `id`, and that is load-bearing rather than tidy:
 * `chatUI` auto-persists the first id it is handed as the model for a
 * fresh install, so the sort is what keeps that the default instead of
 * an accident of who was added last.
 */
export const AI_MODELS: readonly AiModelSpec[] = [
  {
    id: 'gemma-4-26b-a4b-it',
    cfId: '@cf/google/gemma-4-26b-a4b-it',
    // No `tools`, deliberately — 0b0562bc removed Gemma from the
    // tool-calling set so its replies keep arriving as a raw token
    // stream. The tool path buffers: `toolStreamShim` calls Workers AI
    // non-streaming and wraps the finished reply in SSE chunks. Gemma is
    // the default model, so this is the difference between an answer
    // that types itself out and one that lands in a lump. It is a UX
    // choice, not a capability gap — Cloudflare lists Gemma 4 as
    // function-calling, and the flag is one line from being added back.
    // docs/ORBIT_MODEL_CATALOG_PLAN.md records both sides.
    nativeMultimodal: true,
    thinkingOff: true,
  },
  {
    id: 'glm-4.7-flash',
    cfId: '@cf/zai-org/glm-4.7-flash',
    // Zhipu's fast multilingual model: 131k window, function calling,
    // and 5,500/36,400 neurons per M tokens — cheaper per turn than the
    // default at the same class of answer, which matters against a
    // shared 10,000/day.
    tools: true,
    thinkingOff: true,
  },
  {
    id: 'llama-3.2-11b-vision',
    cfId: '@cf/meta/llama-3.2-11b-vision-instruct',
    legacyVision: true,
  },
  {
    id: 'llama-3.2-3b',
    cfId: '@cf/meta/llama-3.2-3b-instruct',
  },
  {
    id: 'llama-3.3-70b',
    cfId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    tools: true,
  },
  {
    id: 'llama-4-scout',
    cfId: '@cf/meta/llama-4-scout-17b-16e-instruct',
    tools: true,
    nativeMultimodal: true,
  },
  {
    id: 'qwen3-30b-a3b-fp8',
    cfId: '@cf/qwen/qwen3-30b-a3b-fp8',
    // Mixture-of-experts (30B total, 3B active) with function calling
    // and a 32k window: at 4,625/30,475 neurons per M tokens it is the
    // cheapest tool-capable model on the free tier — a third of the
    // default's input cost for a tool-driven turn.
    tools: true,
    thinkingOff: true,
  },
]

/** Friendly id a fresh install starts on. */
export const DEFAULT_MODEL_ID = 'gemma-4-26b-a4b-it'

function specFor(friendlyId: string): AiModelSpec {
  const spec = AI_MODELS.find(m => m.id === friendlyId)
  if (!spec) throw new Error('No AI model catalog entry for ' + friendlyId)
  return spec
}

/** Workers AI id the proxy falls back to for an unknown friendly name. */
export const DEFAULT_CF_MODEL_ID = specFor(DEFAULT_MODEL_ID).cfId

/**
 * Friendly name to Workers AI id, plus the `default` alias the proxy's
 * fallback reads (`MODEL_MAP[requested] ?? MODEL_MAP.default`). A
 * retired or misspelled name is absent here on purpose: the proxy's
 * fallback then answers with the default model rather than the picker
 * offering something that cannot reply.
 */
export const MODEL_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([
    ...AI_MODELS.map(m => [m.id, m.cfId] as const),
    ['default', DEFAULT_CF_MODEL_ID] as const,
  ]),
)

/** The ids `/api/models` publishes, in picker order. */
export function modelIds(): string[] {
  return AI_MODELS.map(m => m.id)
}

function cfIdsWhere(has: (m: AiModelSpec) => boolean): Set<string> {
  return new Set(AI_MODELS.filter(has).map(m => m.cfId))
}

/** `tools` is forwarded and the reply routed through `toolStreamShim`
 *  so its tool_calls become OpenAI-format SSE chunks. */
export const TOOL_CALLING_MODELS = cfIdsWhere(m => m.tools === true)

/** Natively multimodal — OpenAI multipart content passes through as-is,
 *  without the image extraction the legacy vision model needs. */
export const NATIVE_MULTIMODAL_MODELS = cfIdsWhere(m => m.nativeMultimodal === true)

/** Vision models needing the separate-image-field API + Meta community
 *  license acceptance (kept for operators who select one explicitly). */
export const LEGACY_VISION_MODELS = cfIdsWhere(m => m.legacyVision === true)

/** Reasoning models that think out loud by default. */
export const THINKING_DEFAULT_OFF_MODELS = cfIdsWhere(m => m.thinkingOff === true)

const SPEC_BY_CF_ID = new Map(AI_MODELS.map(m => [m.cfId, m] as const))

/**
 * Switch thinking off for models that deliberate by default, and clear
 * the reasoning-effort knob explicitly (absent is not the same as off
 * for the templates that read it). Called from every path that builds a
 * Workers AI request body so no route to these models can miss it.
 *
 * One flag covers all three: Gemma 4, Qwen3 and GLM-4.7-Flash each read
 * `enable_thinking` in their own chat template — GLM's emits `<think>`
 * unless the flag is defined and false, Qwen3's emits an empty thinking
 * block.
 */
export function applyModelInputDefaults(model: string, inputs: Record<string, unknown>): void {
  if (!SPEC_BY_CF_ID.get(model)?.thinkingOff) return

  const existing = inputs.chat_template_kwargs
  inputs.chat_template_kwargs = {
    ...(existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}),
    enable_thinking: false,
  }
  inputs.reasoning_effort ??= null
}

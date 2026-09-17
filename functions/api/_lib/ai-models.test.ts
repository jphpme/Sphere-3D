// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The catalog is one table behind two endpoints, so these tests are
 * mostly about drift: a picker offering a model the proxy has retired, a
 * capability set disagreeing with the specs it is derived from, and the
 * thinking-off patch that keeps a reasoning model answering instead of
 * deliberating out loud.
 */

import { describe, expect, it } from 'vitest'
import {
  AI_MODELS,
  DEFAULT_CF_MODEL_ID,
  DEFAULT_MODEL_ID,
  LEGACY_VISION_MODELS,
  MODEL_MAP,
  NATIVE_MULTIMODAL_MODELS,
  THINKING_DEFAULT_OFF_MODELS,
  TOOL_CALLING_MODELS,
  applyModelInputDefaults,
  modelIds,
} from './ai-models'

describe('AI model catalog', () => {
  it('gives every entry a unique friendly id and a Workers AI id', () => {
    const ids = modelIds()
    expect(new Set(ids).size).toBe(ids.length)
    const cfIds = AI_MODELS.map(m => m.cfId)
    expect(new Set(cfIds).size).toBe(cfIds.length)
    for (const cfId of cfIds) expect(cfId.startsWith('@cf/')).toBe(true)
  })

  it('stays alphabetical, so a fresh install persists the default model', () => {
    const ids = modelIds()
    expect(ids).toEqual([...ids].sort())
    expect(ids[0]).toBe(DEFAULT_MODEL_ID)
    expect(MODEL_MAP[DEFAULT_MODEL_ID]).toBe(DEFAULT_CF_MODEL_ID)
  })

  it('maps every friendly id and the proxy fallback alias', () => {
    for (const spec of AI_MODELS) expect(MODEL_MAP[spec.id]).toBe(spec.cfId)
    expect(MODEL_MAP['default']).toBe(DEFAULT_CF_MODEL_ID)
  })

  it('does not offer a model Cloudflare has retired', () => {
    // The picker offered both of these while their catalog pages 404'd,
    // and the proxy answered every request for them with the default.
    expect(MODEL_MAP['llama-3.1-70b']).toBeUndefined()
    expect(MODEL_MAP['llama-3.1-8b']).toBeUndefined()
    // An @hf/… id is not a Workers AI model at all: hermes-2-pro-mistral-7b
    // stayed listed as tool-capable after it left the catalog.
    expect(modelIds().some(id => id.includes('hermes'))).toBe(false)
  })

  it('derives every capability set from the specs', () => {
    const flagged = (flag: 'tools' | 'nativeMultimodal' | 'legacyVision' | 'thinkingOff') =>
      new Set(AI_MODELS.filter(m => m[flag] === true).map(m => m.cfId))
    expect(TOOL_CALLING_MODELS).toEqual(flagged('tools'))
    expect(NATIVE_MULTIMODAL_MODELS).toEqual(flagged('nativeMultimodal'))
    expect(LEGACY_VISION_MODELS).toEqual(flagged('legacyVision'))
    expect(THINKING_DEFAULT_OFF_MODELS).toEqual(flagged('thinkingOff'))
  })

  it('offers tool calling on the models Cloudflare documents it for', () => {
    expect([...TOOL_CALLING_MODELS].sort()).toEqual([
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/qwen/qwen3-30b-a3b-fp8',
      '@cf/zai-org/glm-4.7-flash',
    ])
    // Gemma 4 is absent on purpose: it is the default model and the tool
    // path buffers the reply, so tool calling there would cost the
    // token-by-token answer. docs/ORBIT_MODEL_CATALOG_PLAN.md has both
    // sides; the flag is one line to add.
    expect(TOOL_CALLING_MODELS.has('@cf/google/gemma-4-26b-a4b-it')).toBe(false)
  })
})

describe('applyModelInputDefaults', () => {
  it('clears the thinking flag and the reasoning knob for reasoning models', () => {
    const reasoning = [
      '@cf/google/gemma-4-26b-a4b-it',
      '@cf/qwen/qwen3-30b-a3b-fp8',
      '@cf/zai-org/glm-4.7-flash',
    ]
    for (const model of reasoning) {
      const inputs: Record<string, unknown> = {}
      applyModelInputDefaults(model, inputs)
      expect(inputs.chat_template_kwargs).toEqual({ enable_thinking: false })
      expect(inputs.reasoning_effort).toBeNull()
    }
  })

  it('leaves a model that answers directly alone', () => {
    const inputs: Record<string, unknown> = { messages: [] }
    applyModelInputDefaults('@cf/meta/llama-3.2-3b-instruct', inputs)
    expect(inputs).toEqual({ messages: [] })
  })

  it('merges rather than replaces caller-supplied template kwargs', () => {
    const inputs: Record<string, unknown> = { chat_template_kwargs: { foo: 'bar' } }
    applyModelInputDefaults('@cf/qwen/qwen3-30b-a3b-fp8', inputs)
    expect(inputs.chat_template_kwargs).toEqual({ foo: 'bar', enable_thinking: false })
  })

  it('does not overwrite an explicit reasoning effort', () => {
    const inputs: Record<string, unknown> = { reasoning_effort: 'high' }
    applyModelInputDefaults('@cf/google/gemma-4-26b-a4b-it', inputs)
    expect(inputs.reasoning_effort).toBe('high')
  })
})

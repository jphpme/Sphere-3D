/**
 * POST /api/v1/publish/tours/draft
 *
 * Phase 3pt/E — mint a fresh draft tour row + write an empty
 * `{"tourTasks":[]}` blob at the canonical R2 draft key. Used
 * by the publisher portal's "New tour" button: instead of
 * requiring the caller to first upload a tour file and then
 * POST to /tours with the ref, this endpoint does both in one
 * atomic call. Returns the new `tour` row so the dock can
 * navigate to `/?tourEdit=<id>` immediately.
 *
 * Authorization: same as `POST /api/v1/publish/tours` — any
 * authenticated publisher (the middleware short-circuits
 * unauthenticated requests).
 *
 * Body is optional; pass `{ "title": "..." }` to override the
 * auto-derived placeholder. The validator on the parent
 * `POST /tours` route requires a non-empty title; this
 * endpoint generates one server-side so the publisher can
 * skip the input entirely.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { createDraftTour } from '../../_lib/tour-mutations'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  let body: { title?: string } = {}
  const text = await context.request.text()
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as { title?: string }
      }
    } catch {
      return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
    }
  }
  const result = await createDraftTour(context.env, publisher, { title: body.title })
  return new Response(JSON.stringify({ tour: result.tour }), {
    status: 201,
    headers: {
      'Content-Type': CONTENT_TYPE,
      Location: `/api/v1/publish/tours/${result.tour.id}`,
    },
  })
}

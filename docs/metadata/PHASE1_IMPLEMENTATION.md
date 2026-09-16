# Phase 1: Pure STAC Projection

**Status:** In progress; internal projection only
**Last reviewed:** 2026-09-16
**Revisit when:** Phase 1 contracts change or Phase 2 begins public exposure.

This implements the five numbered steps in [the metadata plan](README.md#phase-1-pure-projection), one DCO-signed commit per step.

| Step | Scope | Status |
|---|---|---|
| 1 | STAC core 1.1 TypeScript contracts | Implemented |
| 2 | Canonical D1 read model and separate node context | Pending |
| 3 | Deterministic resource and mapping builders | Pending |
| 4 | Local Terraviz extension schema and validation | Pending |
| 5 | Table-driven eligibility and mapping coverage | Pending |

No STAC routes, schema URLs, discovery links, native public fields, profile
publication storage/UI, or frame/revision history are introduced. Identity-only
root projection must work without private profile data or approval state.

The types deliberately cover the generated subset of STAC core 1.1, not an
arbitrary third-party STAC parser. Geometry is WGS 84 Polygon/MultiPolygon or
explicitly null; a null geometry cannot carry a fabricated bbox. An Item has
either one represented instant or a complete represented interval.
# Phase 1: Pure STAC Projection

**Status:** In progress; internal projection only
**Last reviewed:** 2026-09-16
**Revisit when:** Phase 1 contracts change or Phase 2 begins public exposure.

This implements the five numbered steps in [the metadata plan](README.md#phase-1-pure-projection), one DCO-signed commit per step.

| Step | Scope | Status |
|---|---|---|
| 1 | STAC core 1.1 TypeScript contracts | Implemented |
| 2 | Canonical D1 read model and separate node context | Implemented |
| 3 | Deterministic resource and mapping builders | Implemented |
| 4 | Local Terraviz extension schema and validation | Pending |
| 5 | Table-driven eligibility and mapping coverage | Pending |

No STAC routes, schema URLs, discovery links, native public fields, profile
publication storage/UI, or frame/revision history are introduced. Identity-only
root projection must work without private profile data or approval state.

The types deliberately cover the generated subset of STAC core 1.1, not an
arbitrary third-party STAC parser. Geometry is WGS 84 Polygon/MultiPolygon or
explicitly null; a null geometry cannot carry a fabricated bbox. An Item has
either one represented instant or a complete represented interval.

The read model reuses canonical public visibility filters and decoration reads,
and reads media intrinsics and renditions in 80-ID batches. Delivered and source
digests remain distinct. Node identity is read once, independently of datasets;
missing identity is explicit. Approved profile selections, custom values and
vocabulary references are optional caller-supplied inputs, never private draft
reads. The reader is not an atomic D1 snapshot: Phase 2 must provide a consistent
read session and authoritative access/freshness rechecks before exposing output.

Builders return structured exclusion/omission reasons. Asset resolution is an
injected trust boundary: the caller attests to an anonymous, stable URL for the
exact source reference, MIME type and (when supplied) delivered bytes/host.
No builder fetches assets or treats URL syntax as proof of reachability. HLS
bundle digests and source-upload digests are not emitted as file checksums.
The reader joins workflow ownership; sequences and recurring outputs remain
withheld without the immutable identities deferred to Phase 3.

Optional policy fixtures explicitly assert `policyCurrent`; that assertion is
not an authorization or cache implementation. Selected profile fields use the
Phase 0 two-actor review contract. Custom values require registration, matching
scope/owner, aggregate bounds, and a pinned local schema validator; unavailable
optional fields are omitted, essential or invalid fields withhold the resource.
Vocabulary projections retain owner and revision but exclude review evidence.
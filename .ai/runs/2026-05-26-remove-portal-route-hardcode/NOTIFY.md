# Notify — 2026-05-26-remove-portal-route-hardcode

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-05-26T12:05:00Z — checkpoint 1 (steps 1.1..3.1)
- Steps covered: 1.1 (d3d184e0f), 2.1 (d724249c4), 3.1 (cbfb88f80)
- Typecheck: PASS; api.test.ts 11/11: PASS
- Note: PortalShell.test.tsx does not exist in fork/main (base branch) — no regression

## 2026-05-26T11:30:00Z — run started
- Brief: Remove hardcoded portal URL regex from `packages/ui/src/backend/utils/api.ts`, replace with configurable `skipAuthRedirectPatterns` registry; portal module registers its own pattern at module scope in `PortalShell.tsx`
- External skill URLs: none
- Source spec: `.ai/specs/2026-05-26-remove-portal-route-hardcode-api-ts.md`
- Run classification: Spec-implementation run (linked spec, 3 phases, multi-file)

# Vercel Security Incident — Defense-in-Depth Response

**Date:** 2026-04-21
**Disclosed by:** Vercel security advisory (email)
**Affected scope (per Vercel):** Subset of customers with confirmed credential compromise. **This account was NOT in the confirmed-affected subset.**
**Response posture:** Defense-in-depth fleet-wide rotation. Active rotation work compressed into a single ~1-hour session.

## What Vercel disclosed

Vercel reported unauthorized access to certain internal systems. A limited subset of customers had credentials confirmed compromised; that subset received direct outreach. Investigation into broader data exfiltration is ongoing. Vercel recommended all customers — regardless of confirmed scope — audit activity logs, rotate environment variables, and migrate to their "sensitive environment variables" feature for newly-set values.

## Why we rotated anyway

*"We do not have reason to believe your credentials are compromised"* ≠ *"We have confirmed your credentials are not compromised."* With investigation ongoing and the cost of rotation low (~1 hour active work, ~75 min observation), defense-in-depth was the cheap-and-correct response.

## Scope assessment + cross-cutting concern identified

The only Vercel-deployed asset in the fleet is **Travel Optimizer**. Six AI-security tooling packages (mcp-audit, mcp-audit-action, agent-capability-inventory, prompt-eval, prompt-genesis, agent-firewall) and four other agent deployments (Brain, Trader, Security Agent, Portfolio, AI Security Agent) live on Railway / Cloudflare Workers / npm — no Vercel surface.

But before rotating only Travel Optimizer's secrets, we audited cross-portfolio environment-variable usage and identified `ANTHROPIC_API_KEY` as a **single shared key across the entire fleet** — Travel Optimizer (Vercel), Brain (Railway), Security Agent (Railway), AI Security Agent (Railway), Trader (Cloudflare Workers), Portfolio (Cloudflare Workers).

**Empirical confirmation:** local `.env` fingerprints on Brain and Security Agent matched. Trader / Portfolio / AI Security Agent / Travel Optimizer not individually fingerprint-verified, but rotated under conservative-default assumption. All five propagation targets returned green smoke tests post-rotation, confirming the assumption was correct.

The shared-key surface meant a Vercel-localized rotation would have left the master key exposed wherever it lived. Fleet-wide rotation was the only correct response.

## Tier-1 rotation: COMPLETE (cross-cutting risk)

| Credential | Scope | Status |
|------------|-------|--------|
| `ANTHROPIC_API_KEY` | Fleet-wide (Vercel + 3× Railway + 2× Cloudflare Workers + local .env on Brain + Security Agent) | ✅ Rotated, propagated, smoke-tested, old key deleted |

Sequencing followed the **disable-wait-delete** protocol:

1. New key generated in Anthropic console
2. Propagated to all six deployment surfaces + two local .env files
3. Smoke-tested each surface (Travel Optimizer redeploy + `/api/optimize`, Brain web chat, Security Agent status, AI Security Agent `/health`, Trader/Portfolio Worker invocations) — all green
4. Old key **disabled** (not deleted) in Anthropic console
5. ~5-minute observation window — verified Brain web chat returned a normal response on the new key, no surfaces reported missing-key errors
6. Old key **deleted**

Rotation order chosen to minimize live-service breakage risk: highest-traffic surfaces (Vercel/Travel Optimizer) updated first, lowest-traffic surfaces (local dev .env) updated last, old key revoked only after every deployment confirmed working with the new key.

## Tier-2 rotation: PARTIALLY COMPLETE

The following Travel-Optimizer-only credentials live exclusively on Vercel:

| Credential | Status |
|------------|--------|
| `AMADEUS_API_KEY` + `AMADEUS_API_SECRET` (paired) | ✅ Rotated at developers.amadeus.com, both Sensitive-flagged on Vercel |
| `CRON_SECRET` | ✅ Regenerated via `openssl rand -hex 32`, Sensitive-flagged on Vercel |
| `SUPABASE_SERVICE_ROLE_KEY` | ⏸ Sensitive-flagged on Vercel; **value rotation deferred** to scheduled followup (see below) |
| `DATABASE_URL` (Supabase DB password) | ⏸ Sensitive-flagged on Vercel; **value rotation deferred** to scheduled followup |

**Operational note on the Sensitive-flag-without-value-rotation pattern (Supabase):** Supabase's legacy JWT key rotation requires a multi-step standby→rotate→revoke flow with a ~75-minute grace period for in-flight JWTs to expire. This was out of scope for the active session. However, **Sensitive-flagging the env var on Vercel is independent of value rotation** — it closes the plaintext-readable exposure surface on Vercel side immediately, even before the upstream value is rotated. This is the right intermediate state: maximum protection on the Vercel surface, value-rotation followup scheduled.

## Sensitive-flag adoption: 6 of 6

All six target Vercel env vars migrated to Vercel's Sensitive-env feature per the bulletin recommendation. Includes `VITE_SUPABASE_ANON_KEY` (public-by-design, RLS-enforced) — flagged for consistency even though the value itself is not secret. Closes the plaintext-readable exposure surface uniformly.

`SUPABASE_URL` / `VITE_SUPABASE_URL` left plaintext — they are public hostnames with no secrecy expectation. Marking them Sensitive would create operational friction without security benefit.

## Activity audit: CLEAN

Full 30-day Vercel account activity log reviewed:

- **One entry total**: CLI token creation on 2026-04-13, attributable (keep-alive deploy to prevent project archival)
- **Zero suspicious logins, env-var reads, unexpected deployments, or token creations**
- **Zero unexpected collaborators** on Travel Optimizer project (single-member: Arthur only)

## Bonus finding surfaced during response: 2FA gap closed

While auditing Vercel account security, identified that the account had been protected only by OAuth-via-Google (single-factor from Vercel's perspective — Google's 2FA is upstream, not Vercel-native). **Closed during the same response window** by enabling **passkey 2FA at the Vercel-native account level** plus **team-level 2FA enforcement**. Future Vercel-account compromise now requires breaching both Google AND a Vercel-native passkey.

## Lessons + scheduled improvements

1. **Single shared `ANTHROPIC_API_KEY` across the fleet is a credential-hygiene gap.** Rotation surfaced it; rotation closes the immediate exposure but doesn't fix the architecture. Migration to **Anthropic workspace API keys** (per-project, separate quotas, isolated blast radius) scheduled for the week of 2026-04-27. Future blast radius reduction: one project compromise → one key rotation, not six.

2. **Supabase JWT rotation procedure documented as a runbook** (scheduled for next session, paired with `DATABASE_URL` password reset):
   1. Supabase Dashboard → Project Settings → JWT Keys → Create standby key → Rotate keys
   2. Copy new `anon` + `service_role` from Project Settings → API
   3. Update `SUPABASE_SERVICE_ROLE_KEY` + `VITE_SUPABASE_ANON_KEY` on Vercel (Sensitive)
   4. Redeploy Travel Optimizer
   5. Wait ≥1h 15min for JWT grace period (in-flight JWTs to expire)
   6. Revoke old key from "Previously used" tab
   7. Pair the same session with: Project Settings → Database → Reset database password → update `DATABASE_URL` on Vercel → redeploy

   Documenting the procedure now (not just executing it) means the runbook exists for future Supabase-key rotations, scheduled or incident-driven.

3. **Cross-platform credential audit is now part of the operational runbook.** Pattern: enumerate which tools require which env vars (one grep per repo), identify cross-cutting concerns by fingerprint match across local .env files, rotate at the highest blast-radius scope first, smoke-test each surface, disable-wait-delete on the old credential.

4. **Sensitive-flagging is independent of value rotation** and should be applied immediately to all secrets where the platform supports it, even when the upstream credential rotation is scheduled-not-immediate. This was a useful pattern surfaced during the Supabase deferral.

## Timeline

| Time (PT) | Event |
|-----------|-------|
| 2026-04-21 ~afternoon | Vercel security advisory email received |
| 2026-04-21 ~15:30 | Rotation session began (new Anthropic key generated at console) |
| 2026-04-21 ~16:15 | Anthropic propagation complete across 5 services + smoke tests green |
| 2026-04-21 ~16:20 | Old Anthropic key DISABLED; ~5-min observation window opens |
| 2026-04-21 ~16:30 | Old Anthropic key DELETED (Brain web chat verified normal response on new key) |
| 2026-04-21 ~16:45 | Amadeus pair + `CRON_SECRET` rotated |
| 2026-04-21 ~17:00 | All 6 target Vercel env vars migrated to Sensitive |
| 2026-04-21 ~17:10 | Travel Optimizer redeployed + Ready |
| 2026-04-21 ~17:15 | Vercel 2FA gap closed; activity audit complete (clean); response session closed |

**Total active response work:** ~1h 45min from rotation start to session close.
**Total elapsed from advisory to response complete:** within same business day.

## What's outstanding

- **Supabase legacy JWT rotation** (`SUPABASE_SERVICE_ROLE_KEY` + `VITE_SUPABASE_ANON_KEY`) — Sensitive-flagged now, value rotation scheduled per documented runbook
- **`DATABASE_URL` password reset** — paired with the Supabase JWT rotation session
- **Migration to Anthropic workspace API keys** — scheduled week of 2026-04-27
- **Sensitive-flag adoption review on remaining Vercel projects** — none currently exist beyond Travel Optimizer, but the runbook is now in place for any future Vercel deployments

---

*Operational record published as proof of credential-hygiene practice across an AI-security tooling portfolio. No secret values, fingerprints, or internal IPs disclosed. Public artifact under MIT license.*

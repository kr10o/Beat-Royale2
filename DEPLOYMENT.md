# Deployment record — 2026-10-31

## Current: Battle + Ranked beta

- URL: https://beat-battle-royale.com/?ranked=1
- Worker: beat-royale-studio
- Deployment: e0ad617249924d67839ac7f7e8328f60
- Durable Objects: BeatRoyaleLobby (v1), RankedArena (v2), SQLite.
- D1: beat-royale-ranked / 4c8e960b-bc23-4bba-88ee-831ff27ba81e; schema 0001 applied.
- Consent Worker deployment: 14de3f925ed34b22ac4c4666f0f08f77.
- Original custom domain and privacy route retained. No DNS reassignment needed.
- Google Client ID configured; GOOGLE_CLIENT_SECRET and shared GEMINI_API_KEY are absent. Google login is visibly disabled pending setup. No real model-call or Google sign-in verification is claimed.

## Verification

- Production build and TypeScript checks passed.
- 12 unit/security tests passed, including complete 50-minute battle timing and catch-up, vote eligibility, audio equivalence, judge schema and privacy cookie isolation.
- Isolated Worker integration passed: ranked pairing, frozen beats, success/failure provider fixtures, concurrent/replayed judging, zero-sum Elo, D1 outbox projection, public leaderboard, cooldown, OAuth PKCE/state/session/replay checks.
- Accelerated classic battle passed through real Durable Object WebSockets and alarms, including readiness, listening gate, voting, elimination lock and winner.
- Local original multiplayer suite passed, including exactly 50 concurrent producers and rejection of the 51st.
- Public original multiplayer suite passed; QA sessions closed.
- Public browser: ranked profile created, survives refresh through privacy layer, honest empty leaderboard; no captured warnings/errors. No test results/ratings inserted into production.
- Screenshot: artifacts/ranked-live.jpg.

## Prior release / rollback

Studio alpha deployment: 31d605f0693947858eab9db8a042c5af. Complete pre-ranked sources are backed up as backups/beat-royale-studio-before-ranked.js and backups/beat-royale-consent-before-ranked.js. Cloudflare deployment history also retains the prior asset version. Roll back application code/assets using deployment history; do not delete the new Durable Object namespace or D1 data. Preserve the privacy route. The older beat-royale-daw origin remains available as an additional legacy fallback.

See README.md for Google setup and remaining beta limitations.

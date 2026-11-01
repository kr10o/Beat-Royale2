# Beat Battle Royale — Battle + Ranked beta

Vue 3, TypeScript, Web Audio and Cloudflare Durable Objects. Live: https://beat-battle-royale.com/ . The original HTML prototypes remain at the repository root.

## Studio and classic battle

- Six-track, 16-step sequencer; tempo, volume, pan, mute/solo; same original Foundry v1 samples verified by SHA-256.
- Guest producer/spectator sessions, 50 producers and up to 200 spectators per room. Followers reconstruct audio locally from authoritative project state.
- Revision checks, duplicate-edit handling, reconnect snapshots, WebSocket hibernation and SQLite persistence.
- All 50 producers must be connected and ready. One preparation minute is followed by 49 one-minute voting rounds: first elimination at minute 2, winner at minute 50.
- Anonymous frozen A/B clips, random sides, balanced candidate exposure, no self-votes, one assignment per enrolled voter per round, a minimum eight-second voting gate. The UI requires listening to both four-second clips. The server cannot prove that a human actually listened.
- Each round eliminates the lowest smoothed vote ratio. Ties use prior cumulative ratio, then an immutable random priority assigned at match start. With no votes, this priority decides. Eliminated players may spectate/vote but cannot edit their battle entry.
- The electorate is frozen at match start; later arrivals can spectate. Durable alarms advance deadlines and recover missed rounds without duplicate eliminations.

## Ranked 1v1

Open `/?ranked=1`. Create a guest profile, optionally enter a Google Gemini key, then find an opponent. At least one participant must declare judging access. Both produce in the studio and lock a valid Foundry beat within five minutes. Once both are locked, either participant can request judgment within ten minutes.

The server renders two anonymous eight-second stereo WAV clips from the canonical sample pack, randomizes A/B order and sends them to `gemini-3.8-flash`. Groove 30%, musicality 25%, creativity 20%, mix 25%; weighted scores rounded to two decimals. Equal scores are draws. Elo starts at 1000 with K=32 and zero-sum changes. No synthetic fallback results are generated. Failed or invalid judgments do not change ratings. At most three judging attempts per match; the same two profiles cannot pair again for 24 hours.

The public season-1 leaderboard shows completed matches only, visible in Ranked and the studio lobby. RankedArena SQLite commits Elo/results atomically; an idempotent outbox projects results to D1. The arena remains authoritative if D1 is temporarily unavailable. Public views exclude keys, session tokens, Google identifiers and locked project data.

A supplied key stays only in request/client memory; it is cleared from the UI when submitted and never persisted or broadcast. Google API usage belongs to the key's project. Only the Google provider is supported in this season so every contestant uses the same model. AI judgments are subjective, not deterministic.

## Google sign-in configuration

The supplied OAuth Web Client ID is configured in `wrangler.jsonc`. To activate sign-in:

1. In that Google OAuth client's authorized redirect URIs add exactly `https://beat-battle-royale.com/api/ranked/auth/callback`.
2. In Cloudflare Worker `beat-royale-studio` → Settings → Variables and Secrets, add encrypted secret `GOOGLE_CLIENT_SECRET`.
3. To provide judging to Google-linked players without their own key, add encrypted secret `GEMINI_API_KEY` with access to Gemini 3.8 Flash. This uses the operator's Google API quota/billing, limited by the app to three attempts per verified profile per UTC day.
4. Deploy the secret changes and test a real sign-in and judged match. Do not put secrets in source files, Git or chat. A client ID alone does not activate Google sign-in or grant model access.

OAuth uses a server-side authorization-code exchange, PKCE, one-use expiring state bound to the session and only the `openid` scope. It stores a hash of Google's subject identifier; it does not request/store email. The button is disabled until ID and secret exist. API key mode remains available. Local `.dev.vars` is ignored; create it with empty GOOGLE_CLIENT_SECRET and GEMINI_API_KEY placeholders when generating types.

## Development and tests

Node 24 recommended.

```sh
npm ci
npm run types
npm run check
npm test
npm run dev
```

Open http://127.0.0.1:8787 . Different guests need separate browser profiles; tabs share their session. Audio requires a user gesture. With the local server running, `npm run test:integration` covers multiplayer isolation, sync, reconnect and concurrent admission of exactly 50 producers.

`npm run test:ranked` bundles the Worker and runs an isolated Miniflare instance. It tests successful/failed judgments using a local provider fixture, concurrent/replayed requests, immutable beat submissions, Elo, D1 projection, public leaderboard, cooldown, OAuth PKCE/state/session/replay, and an accelerated classic match through real WebSockets and alarms. Fixtures are test-only and never deployed. These tests make no real Google calls. `npm test` additionally verifies all 49 eliminations, missed-deadline catch-up, sample PCM equivalence, audio rendering, score validation, judge request format and privacy routing.

## Deployment

`wrangler.jsonc` defines Worker `beat-royale-studio`, SQLite migrations v1 BeatRoyaleLobby/v2 RankedArena, D1 binding RANKED_DB and static assets. Apply D1 schema `migrations/0001_ranked.sql`, then build/check/test/deploy with authenticated Wrangler or the Cloudflare connector. `scripts/upload-assets.mjs` accepts only short-lived upload credentials through hidden stdin.

The custom domain points to `beat-royale-studio`; the separate `beat-battle-royale.com/*` route to `beat-royale-consent` MUST remain. `deploy/consent-worker.js` preserves only the requested room's essential cookie or `br_ranked` on an exact Ranked API allowlist, including OAuth redirects. Other cookie stripping, CSP and optional integration controls remain. Query strings are redacted from Worker logs to protect OAuth callback parameters. Backups are in ignored `backups/`; the original `beat-royale-daw` Worker is retained.

## Remaining limits

This is a competitive beta. Guest profiles do not establish one human identity, so queue cooldown and voting controls do not fully prevent sybil attacks/collusion. Sustained 50-player load, mobile/cross-browser audio and real Google OAuth/model access require further validation. Audio is musically synchronized, not guaranteed bit-identical across engines; background tabs may suspend audio. Samples currently use Workers Static Assets, not R2. Payments, permanent handle purchases, moderation and a permanent project library are not implemented.

Guest profile access is lost if its cookie is cleared/expires (30 days); Google-linked profiles can recover by signing in. Room sessions expire after roughly 24–25 inactive hours. Leaving removes the studio session/project; battle snapshots and ranked submissions/results remain for the match. Do not use the studio as archival storage.

## Sample license

The six synthetic Foundry v1 samples generated by `scripts/generate-samples.mjs` are offered under CC0-1.0. Self-hosted Fontsource fonts retain OFL-1.1 notices in their packages.

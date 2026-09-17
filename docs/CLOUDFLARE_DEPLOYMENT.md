# Cloudflare Deployment

AYNI can be deployed as a Cloudflare Pages project at `vr.ayni.eu.com`.

## Pages Project

- Project name: `ayni-vr`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root
- Node version: use the version in local development, or Cloudflare Pages' current LTS Node setting.

## Custom Domain

Use `vr.ayni.eu.com` as the Pages custom domain.

If `ayni.eu.com` is managed in the same Cloudflare account, add the custom domain in:

`Workers & Pages` -> `ayni-vr` -> `Custom domains` -> `Set up a custom domain`

Cloudflare will create the required DNS record automatically.

If DNS is managed elsewhere, create this record manually:

```text
Type: CNAME
Name: vr
Target: ayni-vr.pages.dev
Proxy: enabled, if the zone is on Cloudflare
```

## Environment And Bindings

The Vite app reads build-time variables from the Pages environment. Add them under:

`Workers & Pages` -> `ayni-vr` -> `Settings` -> `Environment variables`

Useful variable:

```text
VITE_REALTIME_DASH_BASE_URL=https://<your-public-r2-or-cdn-host>/
```

Pages Functions bindings are configured in the Cloudflare dashboard, not only in `wrangler.toml`. If you use the catalog, analytics, R2 uploads, Vectorize search, or Workers AI features, mirror the binding names documented in `wrangler.toml` for both Production and Preview.

## Deploy Commands

## Automatic Deploys

Pushes to GitHub `main` deploy automatically through `.github/workflows/ci.yml`.
The workflow builds the app and uploads `dist/` to the Cloudflare Pages
project `ayni-vr` using Cloudflare's `production` branch, which is what
updates the `vr.ayni.eu.com` custom domain.

Required GitHub repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Optional GitHub repository variable, only if deliberately bypassing the
same-origin `/dash/*`, `/realtime/*`, and `/forecast/*` asset proxy:

```text
VITE_REALTIME_DASH_BASE_URL=https://pachamama-studios.stream/
```

If the variable is not set, the app uses same-origin relative URLs. Cloudflare
Pages Functions proxy those requests to `https://pachamama-studios.stream`,
preserve byte-range headers for DASH playback, and enforce the realtime free
tier.

Realtime gating requires these Pages settings:

```text
REALTIME_QUOTA_KV=<KV namespace binding>
REALTIME_FREE_WEEKLY_SECONDS=1200
REALTIME_QUOTA_SEGMENT_SECONDS=10
REALTIME_QUOTA_SIGNING_KEY=<random secret>
```

The in-app account button uses Cloudflare Access when these Pages variables
are present:

```text
ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com
ACCESS_AUD=<Access application audience tag>
ACCOUNT_LOGIN_URL=<optional explicit Access login URL>
```

Create a Cloudflare Access self-hosted application for `vr.ayni.eu.com` and
include at least these paths so the Functions receive
`Cf-Access-Jwt-Assertion` after sign-in:

```text
/api/v1/account/me
/dash/*
```

Keep `/api/v1/account/login` public; it is the small helper that redirects
the browser into the Access challenge.

With `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, logged-in users get a
cross-device realtime quota keyed by their Access identity. Signed-out users
still receive the weekly free allowance through the anonymous visitor cookie.

Create the KV namespace first:

```bash
npx wrangler kv namespace create REALTIME_QUOTA_KV
```

Then put the returned namespace ID in the `REALTIME_QUOTA_KV` block in
`wrangler.toml`, replacing the placeholder, before running
`wrangler pages deploy`. A Pages project whose repository carries a
`wrangler.toml` takes its whole binding set from that file — the dashboard
reports "Bindings for this project are being managed through wrangler.toml"
and offers no controls — so a binding that is not declared there is absent
from the deployment until it is added and redeployed.

Do not set `VITE_REALTIME_DASH_BASE_URL` for the public app if realtime access
must be controlled; it exposes the upstream DASH origin directly to browsers.

For a manual deploy from a local build:

```bash
npm install
npm run build
npx wrangler pages deploy dist --project-name ayni-vr --branch production
```

The `--branch production` is not decoration. A direct-upload project files the
deployment under `production` only when that is the branch it is told; without
the flag wrangler sends the local git branch and the deploy lands as a
**Preview** — visible at its own `*.pages.dev` URL, attached to no custom
domain, and easy to mistake for a successful production release.

For Git-connected Pages, set the same build command and output directory in the Cloudflare dashboard and deploy from the selected branch.

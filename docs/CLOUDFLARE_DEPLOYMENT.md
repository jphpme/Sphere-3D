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

Pushes to `main` deploy automatically through `.github/workflows/ci.yml`.
The workflow builds the app and uploads `dist/` to the Cloudflare Pages
project `ayni-vr`.

Required GitHub repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Optional GitHub repository variable:

```text
VITE_REALTIME_DASH_BASE_URL=https://pachamama-studios.stream/
```

If the variable is not set, the workflow uses
`https://pachamama-studios.stream/`.

For a manual deploy from a local build:

```bash
npm install
npm run build
npx wrangler pages deploy dist --project-name ayni-vr
```

For Git-connected Pages, set the same build command and output directory in the Cloudflare dashboard and deploy from the selected branch.

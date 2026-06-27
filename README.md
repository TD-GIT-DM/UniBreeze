# UniBreeze

Full-stack [Cloudflare Workers](https://developers.cloudflare.com/workers/) app — **Workers** (compute) + **D1** (SQL) + **R2** (object storage), with a static front-end served from `./public`.

**Pipeline:** local (Mac) → GitHub → Cloudflare (auto-deploy via Workers Builds on every push to `main`).

## Project layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Worker backend. `/api/*` routes; everything else serves static assets. |
| `public/index.html` | Front-end. |
| `wrangler.jsonc` | Worker config + D1/R2/assets bindings. |
| `schema.sql` | D1 database schema. |

## Bindings

- `env.DB` — D1 database (`unibreeze-db`)
- `env.BUCKET` — R2 bucket (`unibreeze-storage`)
- `env.ASSETS` — static assets

## One-time Cloudflare setup (Workers Builds)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Workers** → **Import a repository**.
2. Authorize the Cloudflare GitHub app and grant access to `TD-GIT-DM/UniBreeze`.
3. Select the `UniBreeze` repo. Cloudflare reads `wrangler.jsonc`.
   - Deploy command: `npx wrangler deploy` (default).
   - When prompted, let Cloudflare **create the D1 database and R2 bucket** from the bindings.
4. **Save and Deploy.** Every future push to `main` auto-deploys.

### Apply the database schema (once, after first deploy)

Either in the dashboard (D1 → `unibreeze-db` → Console, paste `schema.sql`), or locally:

```bash
npx wrangler d1 execute unibreeze-db --remote --file=./schema.sql
```

## Local development

```bash
npm install
npm run dev        # http://localhost:8787
```

## Manual deploy (optional)

```bash
npx wrangler deploy
```

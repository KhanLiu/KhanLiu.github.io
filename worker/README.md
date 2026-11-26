# Travel admin Worker

The public site is static GitHub Pages, so the admin editor uses a Cloudflare Worker for OAuth and repository writes. The Worker accepts GitHub OAuth sign-in only for `ADMIN_GITHUB_LOGIN`; a separate fine-grained GitHub token is kept in Cloudflare and limited to this repository's `Contents` permission. Neither credential is placed in the site or repository.

## One-time setup

1. The KV namespace has been created. `wrangler.toml` is configured with binding `TRAVEL_ADMIN_AUTHy` and namespace ID `e3f4d3dc07094d0a80a34415d3e01b5b`; keep this binding name unchanged unless you also rename it in `src/index.js`. To replace the namespace, create one with:

   ```powershell
   npx wrangler@latest login
   npx wrangler@latest kv namespace create TRAVEL_ADMIN_AUTH
   ```

   Replace the configured namespace ID in `wrangler.toml` with the returned ID.

2. In Cloudflare, choose or confirm your `workers.dev` subdomain. The Worker origin will be `https://khanliu-travel-admin.<your-workers-subdomain>.workers.dev`. Create a GitHub OAuth App with homepage `https://khanliu.github.io/admin/` and callback `<worker-origin>/auth/callback`. The callback must exactly match the Worker URL. Keep its client secret private.

3. Create a fine-grained personal access token for **only** `KhanLiu/KhanLiu.github.io`, with repository permission **Contents: Read and write**. Do not paste the token into chat or commit it.

4. Set the OAuth client ID in `wrangler.toml`, then set the two secrets and deploy:

   ```powershell
   npx wrangler@latest secret put GITHUB_CLIENT_SECRET
   npx wrangler@latest secret put GITHUB_WRITE_TOKEN
   npx wrangler@latest deploy
   ```

   Wrangler prompts for each secret value. Use the Cloudflare dashboard's Worker settings instead if preferred.

5. In `admin/index.html`, set the `travel-admin-api` meta value to the exact Worker origin, for example `https://khanliu-travel-admin.<your-workers-subdomain>.workers.dev`. Commit and push that change to deploy the Pages editor. The public map and admin editor both update automatically when the Worker writes `_data/trips.yml` to `main`.

The Worker OAuth callback is `https://<worker-origin>/auth/callback`. Only the configured GitHub login is accepted. OAuth requests only `read:user`; repository writes use the separate repository-scoped token. Browser sessions are random, expire after two hours, and are held in the configured KV namespace. API calls require the exact Pages origin and a bearer session token.

## Local checks

```powershell
npm test
```

The OAuth callback, secrets, KV namespace, and Worker URL must be configured before hosted sign-in and editing can work. Do not put secret values in `wrangler.toml`, source files, or GitHub Pages.

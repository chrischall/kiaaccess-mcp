# Deploying the Kia Access remote connector

Operator runbook for standing up `kiaaccess-mcp` as a hosted Cloudflare Worker —
a "remote connector" that anyone you share the URL with can add to claude.ai
(web, desktop, or mobile), each logging in with their own Kia Owners account.

Setup is one-time per operator and none of it can be done by an agent: it needs
your own Cloudflare account. After that, deploys are automatic — the
`deploy-connector` job in `.github/workflows/release-please.yml` deploys each
released tag, and **Actions → deploy-connector → Run workflow** deploys any ref
on demand.

If you only want to control your own car from your own machine, you do not need
any of this: run the stdio server (see the main README). The connector exists to
put the same tools on claude.ai mobile/web, where there is no local process.

---

## Read this first: why the hosted connector needs a token you create locally

Kia enforces MFA on password login, and **MFA cannot be completed inside a
Worker** — the passcode arrives by SMS/email minutes later, on a different
device, and Kia's OTP window is about two minutes. What makes a hosted
deployment possible at all is the *remember-me token* (`rmtoken`): a
`prof/authUser` call carrying it returns a fresh session id with **no MFA
challenge**, and the token is not rotated (see [KIA-API.md](./KIA-API.md) §4).

So every user of this connector must do the MFA bootstrap **once, locally**, on
the stdio server, and then paste the resulting token into the connector's login
page:

```
local stdio server                     hosted connector
──────────────────                     ────────────────
kia_start_login          ─┐
kia_send_otp              ├─ one time  
kia_verify_otp           ─┘
kia_export_refresh_token ───── rmtoken ──► /authorize login form
```

Consequently `kia_start_login`, `kia_send_otp`, `kia_verify_otp` and
`kia_export_refresh_token` are **not registered** on the Worker. They are not
hidden or gated — they do not exist there, so nothing a host or a prompt does
can invoke them.

> **Unverified:** the live capture never established whether Kia binds an
> `rmtoken` to the device id it was minted against. The Worker has no filesystem,
> so it derives a stable device id from the account email
> (`hostedDeviceId` in `src/kia-auth.ts`) rather than reusing the local server's.
> If Kia *does* bind them, the login page will say so on the spot — `login()`
> performs a real refresh plus a real `ownr/gvl` read before accepting anything,
> so a token that cannot work here fails at paste time rather than mysteriously
> later.

---

## Prerequisites

- A Cloudflare account (the free tier is fine).
- This repo checked out with dependencies installed (`npm install`).
- **No app-level Kia API credentials exist.** There is no operator-shared
  `client_id`/`client_secret`; each user authenticates with their own account
  through the connector's own login page. You never handle anyone's Kia
  credentials.

---

## Steps

### 1. Log in to Cloudflare

```sh
npx wrangler login
```

This opens a browser to authorize the CLI against your Cloudflare account.

### 2. Create the OAuth KV namespace

The connector stores each user's OAuth grant — and, encrypted inside it, their
Kia credentials and remember-me token — in a KV namespace bound as `OAUTH_KV`.

```sh
npx wrangler kv namespace create kiaaccess-connector-oauth
```

It prints something like:

```
{ "binding": "OAUTH_KV", "id": "abcd1234..." }
```

### 3. Paste the id into `wrangler.jsonc`

`wrangler.jsonc` ships with a placeholder that **must** be replaced before the
first deploy:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }],
```

becomes

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "abcd1234..." }],
```

Use a namespace dedicated to this connector. Sharing one with another
connector's `OAUTH_KV` would cross-wire their OAuth grants and tokens.

### 4. (Optional) Choose the command ceiling

`wrangler.jsonc` pins:

```jsonc
"vars": { "KIA_WRITE_MODE": "comfort" }
```

| value | registers |
| --- | --- |
| `none` | no vehicle commands — reads only |
| `comfort` | climate + charging. **The car cannot be unlocked.** (deployed default) |
| `all` | additionally door lock/unlock |

Anything unrecognized fails **closed** to `none`. The gate is structural —
tools outside the mode are never registered, so no host setting or injected
instruction can reach them.

`comfort` is the deployed default deliberately: this Worker is reachable from
any claude.ai session on any device, and a remote unlock is the one command
whose worst case is a physically unsecured car. Raising it to `all` is a
decision, not a default. `tests/worker.test.ts` asserts the pinned value, so
changing it is a visible edit.

To override without editing the file (a secret beats a `var` of the same name):

```sh
npx wrangler secret put KIA_WRITE_MODE
```

Under `nodejs_compat` these populate `process.env`, which is exactly where
`getKiaWriteMode()` reads them — same code path as the stdio server.

### 5. Check it locally, then deploy

```sh
npm run worker:typecheck   # tsc against src/worker.ts (the stdio tsconfig excludes it)
npm run worker:test        # the real Workers runtime (workerd via Miniflare)
npx wrangler deploy --dry-run   # confirms it bundles, shows the resolved bindings
npm run worker:dev         # optional: serve it locally
npm run worker:deploy      # the real thing
```

> `wrangler dev` and the Workers test pool also read this repo's `.env` — the
> **stdio** server's file — and merge it over `wrangler.jsonc`'s `vars`. If your
> `.env` sets `KIA_WRITE_MODE=all`, your local Worker will register door
> lock/unlock even though production will not. `wrangler deploy` does **not** do
> this (`--dry-run` prints the resolved bindings; check them). See
> `.dev.vars.example`.

On success the deploy prints:

```
https://kiaaccess-connector.<your-subdomain>.workers.dev
```

`wrangler.jsonc` also declares the custom-domain route
`connector.kiaaccess.nullnet.app`, so the connector is additionally served at:

```
https://connector.kiaaccess.nullnet.app
```

Use the custom domain as the stable URL you share. The zone must be in the
deploying Cloudflare account; if it isn't, remove the `routes` entry and use the
`*.workers.dev` URL.

### 6. Add it in claude.ai

1. claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Paste the URL with `/mcp` appended, e.g.
   `https://connector.kiaaccess.nullnet.app/mcp`.
3. Claude opens the connector's login page (served by the Worker at
   `/authorize`), which asks for three things:
   - **Kia Owners email**
   - **Kia Owners password**
   - **Kia remember-me token** — from `kia_export_refresh_token` on the user's
     own local stdio server, after completing the one-time MFA login there.
4. The page does not just accept the paste: it refreshes a real session from the
   token and reads the vehicle list. A wrong value comes back as an error on the
   form, not as a broken connector.

The connector is unlisted — it appears only for people you share the URL with.
Anyone with the URL who completes their own Kia login uses it under their own
account.

### 7. Verify

Ask Claude to run `kia_session_status` (no network call, reports masked config),
then `kia_list_vehicles`, then `kia_vehicle_status`. If those work, the deploy is
verified end-to-end. Every command tool is confirm-gated, so you can also run one
without `confirm: true` to see the dry-run preview without touching the car.

---

## CI deploys: the Cloudflare API token

`.github/workflows/deploy-connector.yml` (on demand) and the `deploy-connector`
job in `release-please.yml` (on each release) both call
`chrischall/workflows/.github/workflows/reusable-mcp-connector-deploy.yml`. They
need two repository secrets:

| secret | when it is needed |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | always |
| `CLOUDFLARE_ACCOUNT_ID` | when the token can reach more than one account — wrangler cannot disambiguate on its own |

Create the token at **Cloudflare dashboard → My Profile → API Tokens → Create
Token**. The *Edit Cloudflare Workers* template covers it; a hand-rolled token
needs these permissions:

| scope | permission | why |
| --- | --- | --- |
| Account → Workers Scripts | Edit | upload the Worker |
| Account → Workers KV Storage | Edit | bind (and read/write) `OAUTH_KV` |
| Account → Account Settings | Read | account lookup |
| Account → Workers Tail | Read | optional; `wrangler tail` |
| Zone → Workers Routes | Edit | **only** if you keep the `connector.kiaaccess.nullnet.app` custom-domain route |
| Zone → Zone | Read | same — resolves the zone for that route |

Scope the account permissions to the single account you deploy into, and the
zone permissions to the single zone hosting the custom domain. Nothing here
needs DNS write beyond the route, and nothing needs access to any other zone.

If either secret is absent the reusable workflow warns and skips — a missing
Cloudflare secret never fails a release.

---

## How auth and storage work

- **No operator-level Kia credentials.** Each user logs in with their own.
- The login form's three values become the OAuth *props* for that user, stored
  **encrypted at rest** in `OAUTH_KV` by `@cloudflare/workers-oauth-provider`,
  scoped to that user's grant.
- **All three are kept, including the password**, and the login page says so.
  This is not belt-and-braces: Kia's refresh call sends the full credential body
  (`userId` + `password`) *alongside* the `rmtoken` — the token alone cannot mint
  a session. A connector that stored only the token would stop working at the
  first session expiry.
- Sessions (`sid`) are minted per Worker session and held in memory only. The
  Worker uses `nullSessionIO`: nothing is written to a filesystem, because there
  isn't one.
- Failed logins are **never retried**. Kia increments `loginAttempt` on each
  rejection and eventually sets `enforceRecaptcha`, which would break
  server-side auth for that account permanently — so both the login page and the
  client surface a credential rejection immediately instead of trying again.

## What is deliberately absent

- **No cache Durable Object.** This connector is stateless: `wrangler.jsonc`
  declares only `MCP_OBJECT` (the connector's own per-session agent, with the
  `v1` `new_sqlite_classes` migration) and `OAUTH_KV`. Vehicle state is read live
  every time — a cached door-lock reading is a *wrong* door-lock reading.
- **No `remotes` entry in `server.json`.** The MCP registry listing advertises
  the stdio npm package only. The connector URL is shared directly, not
  published.
- **No per-request timeout.** A stuck upstream will hang the tool call until the
  Worker's own limits cut it off. Worth a follow-up (ofw-mcp's
  `OFW_REQUEST_TIMEOUT_MS` is the precedent).

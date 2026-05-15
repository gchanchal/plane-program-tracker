# WEB live dashboard — local edition

A self-contained portfolio dashboard for the WEB project, with a **Refresh** button that re-pulls live data from Plane every time you click it.

## Architecture

```
┌────────────────────────┐    ┌──────────────────┐    ┌────────────────────┐
│ Browser                │    │ server.py        │    │ api.plane.so       │
│ http://localhost:8765/ │◄──►│ (Python stdlib)  │◄──►│ /api/v1/...        │
│                        │    │                  │    │                    │
│  dashboard.html        │    │  /api/data       │    │  X-API-Key header  │
│   ↓ fetch /api/data    │    │   → data.json    │    │  60 req/min limit  │
│  [Refresh] button      │    │  /api/refresh    │    │  cursor pagination │
│   ↓ POST /api/refresh  │    │   → repulls all  │    │                    │
└────────────────────────┘    └──────────────────┘    └────────────────────┘
                                       │
                                       └─► data.json (cached on disk)
```

- **The HTML has no secrets and no API logic.** It just talks to `localhost`.
- **server.py holds the API key** (from env vars) and proxies calls to Plane.
- **data.json on disk** is the cache. Survives restarts. Re-written each refresh.
- **CORS isn't an issue** because the browser only ever talks to `localhost`.

## Setup

### 1. Find your workspace slug

Look at any URL in your Plane app — it's the segment after `app.plane.so/`:

```
https://app.plane.so/your-workspace-slug/projects/...
                     ^^^^^^^^^^^^^^^^^^^
```

### 2. Configure auth

The dashboard requires each user to sign in with their own Plane **Personal Access Token**. The server validates the PAT against Plane's `/users/me/` endpoint, checks the returned email is `@plane.so`, then uses *that user's* PAT for all their Plane API requests — so each person only sees data they have Plane access to.

```bash
cp .env.example .env
```

Edit `.env` and set:

- `PLANE_WORKSPACE_SLUG` — your workspace slug from step 1.
- `SESSION_SECRET` — a random string that signs the session cookie. Generate one with:
  ```bash
  python3 -c "import secrets; print(secrets.token_urlsafe(48))"
  ```
- `ALLOWED_EMAIL_DOMAINS` (default `plane.so`) — comma-separated allowlist of email domains. PATs whose owner's email isn't on this list are rejected.

Users get their PAT from https://app.plane.so/profile/settings → **Personal Access Tokens** → **Add personal access token**.

If `SESSION_SECRET` is empty, the server falls back to single-user mode using the optional `PLANE_API_KEY` from `.env` — handy for local dev without a login flow. Don't expose this mode to anyone else.

### 3. Run

**macOS / Linux:**
```bash
source .env
python3 server.py
```

**Windows PowerShell:**
```powershell
$env:PLANE_WORKSPACE_SLUG = "your-workspace-slug"
$env:SESSION_SECRET = "long-random-string"
python server.py
```

**Windows cmd.exe:**
```cmd
set PLANE_WORKSPACE_SLUG=your-workspace-slug
set SESSION_SECRET=long-random-string
python server.py
```

### 4. Open

http://localhost:8765/

You'll see a login page. Paste your Plane PAT to sign in. The session cookie lasts 12 h by default (`SESSION_TTL_SECONDS`).

On first load the dashboard says "No data yet — click Refresh". Click it. The server pulls the last 6 months of work items (~10 paginated API calls), writes `data.json`, and the dashboard renders.

Subsequent **Refresh** clicks repeat the pull — typically ~10-20 seconds depending on your network and how many items you have.

## What the refresh does

For each click of **Refresh**, `server.py` does:

1. `GET /workspaces/{slug}/members/` — pulls workspace member names so assignee initials work
2. `GET /workspaces/{slug}/projects/{id}/work-items/?per_page=100&cursor=...` — paginated, newest-first, stops once items age past your `WINDOW_DAYS` cutoff (default 183 = 6 months)
3. Aggregates everything (status counts, priority counts, type counts, weekly creation rate, top-6 Feature portfolios with descendant breakdowns)
4. Writes `data.json` next to `server.py`
5. The browser re-fetches `/api/data` and re-renders

## Configuration knobs (env vars)

| Variable | Default | Notes |
|---|---|---|
| `PLANE_WORKSPACE_SLUG` | (required) | from your Plane URL |
| `SESSION_SECRET` | (required for auth) | Random string; signs session cookies. Enables PAT login. |
| `PLANE_PROJECT_ID` | WEB project UUID | change to point elsewhere |
| `PORT` | `8765` | local server port |
| `WINDOW_DAYS` | `183` | how far back to fetch (6 months) |
| `PLANE_API_BASE` | `https://api.plane.so/api/v1` | change for self-hosted |
| `ALLOWED_EMAIL_DOMAINS` | `plane.so` | Comma-separated allowlist of email domains. |
| `SESSION_TTL_SECONDS` | `43200` | Session lifetime; default 12 h. |
| `PLANE_API_KEY` | (optional) | Fallback shared PAT used only when `SESSION_SECRET` is empty. |

## Files in this folder

```
web-dashboard-live/
├── dashboard.html      ← UI. No data, no secrets. ~40KB.
├── server.py           ← local server + Plane fetcher. Stdlib only.
├── .env.example        ← config template
├── data.json           ← written by server after first refresh (gitignore this)
└── README.md           ← you are here
```

## Common questions

**Does this work if I just open `dashboard.html` from my filesystem?**
No — the dashboard fetches `/api/data` over HTTP. You need `server.py` running to serve both the HTML and the API.

**Where does the API key live?**
In your shell environment when you `source .env`. It never touches the HTML file or `data.json`. If someone steals your dashboard.html, they get nothing.

**Can I share the dashboard with someone else?**
Two options:
- Share `dashboard.html` + their own `data.json`. They see a static snapshot, can't refresh.
- Have them run their own `server.py` with their own token. They see live data scoped to whatever they have access to in Plane.

**Plane returned a 401 / 403?**
Check that the token is still valid, hasn't expired, and that your account has access to the project. Plane API tokens inherit your user permissions.

**Plane returned a 429 (rate limit)?**
The API allows 60 requests/minute per key. A single refresh uses ~12 calls. If you click Refresh ~5 times in 60 seconds you may hit the limit. Wait a minute and try again.

**Refresh is slow.**
Each page = 1 API call = 100 items. WEB pulls roughly 10 pages for 6 months. Each call is bounded by Plane's response time (~1-2s typically). Total ~10-20s for a fresh pull. Cut `WINDOW_DAYS` for faster refreshes.

**The hierarchy table only shows the 6 Feature initiatives expanded.**
That's the default. Click the chevron on any other row to drill in. Use the **Structure** builder above the table to group items by State / Priority / Type / Assignee at either depth.

#!/usr/bin/env python3
"""
Local server for the WEB live dashboard.

Endpoints:
  GET  /                 -> serves dashboard.html
  GET  /api/data         -> returns last-cached data.json
  GET  /api/status       -> returns refresh status (in_progress, last_run, last_error)
  POST /api/refresh      -> fetches fresh work items from Plane, rewrites data.json

Config via environment variables (or .env, sourced before running):
  PLANE_API_KEY            (required) personal access token from Plane settings
  PLANE_WORKSPACE_SLUG     (required) the slug from your Plane URL: app.plane.so/<slug>/...
  PLANE_PROJECT_ID         (default: WEB project UUID)
  PLANE_API_BASE           (default: https://api.plane.so/api/v1)
  PORT                     (default: 8765)
  WINDOW_DAYS              (default: 183, i.e. last 6 months)

Stdlib only — no pip install needed. Python 3.8+.
"""
import base64
import hashlib
import hmac
import http.cookies
import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.request
import urllib.parse
import urllib.error
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ---- Config ----
# Bind host. Defaults to all interfaces so the server is reachable inside a
# container (Service/ingress/health probes connect via the pod IP, not
# loopback). For local-only dev, set HOST=localhost.
HOST = os.environ.get('HOST', '0.0.0.0')
PORT = int(os.environ.get('PORT', 8765))
PLANE_API_KEY = os.environ.get('PLANE_API_KEY', '').strip()
PLANE_WORKSPACE_SLUG = os.environ.get('PLANE_WORKSPACE_SLUG', '').strip()
PLANE_PROJECT_ID = os.environ.get('PLANE_PROJECT_ID', '02c3e1d5-d7e2-401d-a773-45ecba45d745').strip()
PLANE_API_BASE = os.environ.get('PLANE_API_BASE', 'https://api.plane.so/api/v1').rstrip('/')
# The Plane API base for the CURRENT request's session (set per request from the
# session's instance). The server is single-threaded (HTTPServer), so a module
# global is safe: every Plane call happens synchronously within one request after
# the base has been set. Defaults to the env/cloud base.
_active_api_base = PLANE_API_BASE


def derive_api_base(url: str) -> str:
    """Turn a pasted Plane URL into its REST API base.

    app.plane.so (cloud) → https://api.plane.so/api/v1
    self-hosted host     → https://<host>/api/v1
    """
    raw = (url or '').strip()
    if not raw:
        return PLANE_API_BASE
    if '://' not in raw:
        raw = 'https://' + raw
    try:
        p = urllib.parse.urlparse(raw)
        host = (p.netloc or '').split('@')[-1]
        scheme = p.scheme or 'https'
        if not host:
            return PLANE_API_BASE
        if host in ('app.plane.so', 'plane.so', 'www.plane.so', 'api.plane.so'):
            return 'https://api.plane.so/api/v1'
        return f'{scheme}://{host}/api/v1'
    except Exception:
        return PLANE_API_BASE
WINDOW_DAYS = int(os.environ.get('WINDOW_DAYS', 183))
HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / 'data'

# ---- Auth / session config ----
ALLOWED_EMAIL_DOMAINS = tuple(
    d.strip().lower()
    for d in os.environ.get('ALLOWED_EMAIL_DOMAINS', 'plane.so').split(',')
    if d.strip()
)
SESSION_SECRET = os.environ.get('SESSION_SECRET', '').strip()
SESSION_TTL_SECONDS = int(os.environ.get('SESSION_TTL_SECONDS', 604800))  # 7 days
SESSION_COOKIE = 'pt_session'


def safe_slug(slug: str) -> str:
    """Sanitise a workspace slug for use in API paths and as a folder name."""
    return re.sub(r'[^a-z0-9_-]', '', (slug or '').strip().lower())


def parse_workspace_slug(raw: str) -> str:
    """Accept a workspace slug or a pasted Plane URL and return the bare slug.

    Handles: "my-ws", "app.plane.so/my-ws/...", "https://app.plane.so/my-ws",
    and "my-ws.plane.so".
    """
    raw = (raw or '').strip()
    if not raw:
        return ''
    if '/' in raw or '://' in raw or '.' in raw:
        try:
            u = raw if '://' in raw else 'https://' + raw
            p = urllib.parse.urlparse(u)
            segs = [s for s in p.path.split('/') if s]
            if segs:
                return safe_slug(segs[0])
            host = p.netloc.split(':')[0]
            parts = host.split('.')
            if len(parts) >= 3 and parts[0] not in ('app', 'www', 'my'):
                return safe_slug(parts[0])
        except Exception:
            pass
    return safe_slug(raw)


def workspace_dir(slug: str) -> Path:
    return DATA_DIR / (safe_slug(slug) or '_default')


def data_path_for(project_id: str, slug: str) -> Path:
    return workspace_dir(slug) / f'{project_id}.json'


def history_path_for(project_id: str, slug: str) -> Path:
    return workspace_dir(slug) / f'{project_id}.history.jsonl'


def raw_path_for(project_id: str, slug: str) -> Path:
    # Raw Plane work items kept alongside the slim cache so a delta refresh can
    # merge changed items and re-aggregate losslessly. Not sent to the client.
    return workspace_dir(slug) / f'{project_id}.raw.json'


_PROJECT_ID_RE = re.compile(r'^[A-Za-z0-9_-]+$')


def cache_entry_for(slug: str, data_path: Path) -> dict:
    """Summarize one project's cache files for the Settings page (disk-only)."""
    pid = data_path.name[:-len('.json')]
    raw_p = raw_path_for(pid, slug)
    hist_p = history_path_for(pid, slug)
    entry = {
        'workspace_slug': slug,
        'project_id': pid,
        'data_bytes': data_path.stat().st_size,
        'raw_bytes': raw_p.stat().st_size if raw_p.exists() else 0,
        'history_bytes': hist_p.stat().st_size if hist_p.exists() else 0,
        'has_raw': raw_p.exists(),   # raw cache present ⇒ next refresh is a delta
    }
    try:
        d = json.loads(data_path.read_text())
        meta = d.get('_meta', {})
        items = d.get('items', [])
        entry['item_count'] = meta.get('item_count') if meta.get('item_count') is not None else len(items)
        entry['last_refreshed_at'] = meta.get('last_refreshed_at')
        entry['refresh_mode'] = meta.get('refresh_mode')
        entry['window_days'] = meta.get('window_days')
        entry['due_done'] = sum(1 for i in items if i.get('due_count') is not None)
        entry['due_total'] = sum(1 for i in items if i.get('end'))
    except Exception:
        pass
    return entry


def list_cache_entries(workspaces) -> list:
    """All cached project files across the given (authorized) workspaces."""
    out = []
    for ws in (workspaces or []):
        wdir = workspace_dir(ws)
        if not wdir.exists():
            continue
        for f in sorted(wdir.glob('*.json')):
            if f.name.endswith('.raw.json'):
                continue
            out.append(cache_entry_for(ws, f))
    return out


def merge_dashboards(datas: list) -> dict:
    """Combine several projects' cached dashboards into one.

    Items are concatenated (each tagged with its project_id/identifier/name);
    KPIs and the various counts are additive; users/states/labels are unioned.
    No Plane calls — this only stitches together already-cached data.
    """
    items = []
    kpi = defaultdict(int)
    group_counts, priority_counts, type_counts = Counter(), Counter(), Counter()
    weeks = defaultdict(int)
    users, user_colors = {}, {}
    states, labels, modules = {}, {}, {}
    portfolios = []
    today, cutoff, state_group_info = '', '', None
    project_ids = []
    last_refreshed = ''
    for d in datas:
        meta = d.get('_meta', {})
        pid = meta.get('project_id')
        ident = meta.get('project_identifier')
        pname = meta.get('project_name')
        if pid:
            project_ids.append(pid)
        for it in d.get('items', []):
            it = dict(it)
            it.setdefault('project_id', pid)
            it.setdefault('project_identifier', ident)
            it.setdefault('project_name', pname)
            items.append(it)
        for k, v in (d.get('kpi') or {}).items():
            if isinstance(v, (int, float)):
                kpi[k] += v
        group_counts.update(d.get('group_counts') or {})
        priority_counts.update(d.get('priority_counts') or {})
        type_counts.update(d.get('type_counts') or {})
        for w in (d.get('weeks') or []):
            weeks[w.get('week')] += w.get('count', 0)
        users.update(d.get('users') or {})
        user_colors.update(d.get('user_colors') or {})
        for s in (d.get('states_list') or []):
            states[s.get('id')] = s
        for l in (d.get('labels_list') or []):
            labels[l.get('id')] = l
        for m in (d.get('modules') or []):
            modules[m.get('id')] = m
        for pf in (d.get('portfolios') or []):
            pf = dict(pf)
            pf.setdefault('project_id', pid)
            pf.setdefault('project_identifier', ident)
            pf.setdefault('project_name', pname)
            portfolios.append(pf)
        today = max(today, d.get('today') or '')
        c = d.get('cutoff') or ''
        cutoff = c if not cutoff else min(cutoff, c)
        state_group_info = state_group_info or d.get('state_group_info')
        last_refreshed = max(last_refreshed, meta.get('last_refreshed_at') or '')
    workable = kpi.get('workable', 0)
    kpi['pct_done'] = round(100 * kpi.get('done', 0) / workable) if workable else 0
    weeks_list = [{'week': w, 'count': weeks[w]} for w in sorted(k for k in weeks if k)]
    portfolios.sort(key=lambda p: -((p.get('breakdown') or {}).get('_total', 0)))
    return {
        'items': items,
        'kpi': dict(kpi),
        'group_counts': dict(group_counts),
        'priority_counts': dict(priority_counts),
        'type_counts': dict(type_counts),
        'portfolios': portfolios[:8],
        'weeks': weeks_list,
        'today': today,
        'cutoff': cutoff,
        'state_group_info': state_group_info,
        'users': users,
        'user_colors': user_colors,
        'states_list': list(states.values()),
        'labels_list': list(labels.values()),
        'modules': list(modules.values()),
        '_meta': {
            'multi': True,
            'project_ids': project_ids,
            'item_count': len(items),
            'last_refreshed_at': last_refreshed or None,
        },
    }


def delete_cache_for(project_id: str, slug: str) -> list:
    """Remove a project's data, raw, and history files. Returns names removed."""
    removed = []
    for p in (data_path_for(project_id, slug), raw_path_for(project_id, slug), history_path_for(project_id, slug)):
        if p.exists():
            try:
                p.unlink()
                removed.append(p.name)
            except Exception:
                pass
    return removed


def migrate_flat_data_files():
    """One-time: move legacy data/<pid>.json (single-workspace layout) into
    data/<PLANE_WORKSPACE_SLUG>/ so the per-workspace layout finds them."""
    if not PLANE_WORKSPACE_SLUG or not DATA_DIR.is_dir():
        return
    dest = workspace_dir(PLANE_WORKSPACE_SLUG)
    moved = 0
    for f in DATA_DIR.glob('*.json'):
        dest.mkdir(parents=True, exist_ok=True)
        f.rename(dest / f.name)
        moved += 1
    for f in DATA_DIR.glob('*.history.jsonl'):
        dest.mkdir(parents=True, exist_ok=True)
        f.rename(dest / f.name)
        moved += 1
    if moved:
        print(f'  Migrated {moved} cache file(s) into data/{safe_slug(PLANE_WORKSPACE_SLUG)}/', file=sys.stderr)

# ---- Static lookups (would normally also come from API; baked for simplicity) ----
TYPES = {
    'a3cac356-dd91-47b5-a2d2-ee7153f8d24b': {'name': 'Bug',         'color': '#EF5974'},
    '9cfdebc1-7e3a-4f38-a66d-e0507dc5eb13': {'name': 'Task',        'color': '#A0D6FD'},
    '0e23a617-a57b-4fc6-92bc-bd167a012f97': {'name': 'Improvement', 'color': '#4C49F8'},
    'cf1334d1-2ef2-40d4-a7a6-9014f5279a9c': {'name': 'Feature',     'color': '#FC964D'},
    '559ec4a4-a8b8-498f-831f-b489f99ea318': {'name': 'Refactor',    'color': '#8280FF'},
}
STATES = {
    '3cefb6a8-729e-48aa-8cdd-3bd88f3e8a3e': {'name':'Icebox',           'group':'backlog',   'color':'#A3A3A3'},
    'f3d5418b-c8b9-40da-9f74-083c6db9b5dd': {'name':'In Scoping',       'group':'backlog',   'color':'#8ED1FC'},
    'be09b85f-61f5-4686-86e1-fa92a8493321': {'name':'Waiting for design','group':'unstarted','color':'#F78DA7'},
    '63f8769c-6e4c-42a6-b6da-4452eae815ba': {'name':'Ready for Dev',    'group':'unstarted', 'color':'#ABB8C3'},
    '36c0cf47-4c9d-45bd-a8f0-36e101bb32e0': {'name':'In Progress',      'group':'started',   'color':'#F59E0B'},
    'fe22aafd-5e65-48aa-9d54-f2c5232240e6': {'name':'In Review',        'group':'started',   'color':'#FCB900'},
    '8baf36f0-2740-4e43-8485-40a9fad7f216': {'name':'QA',               'group':'completed', 'color':'#8ED1FC'},
    '2ab1eda0-21a6-4355-b022-03042b0a1469': {'name':'UAT',              'group':'completed', 'color':'#7BDCB5'},
    'c1aeb3d7-b752-4216-9128-ce47c76810b9': {'name':'Done',             'group':'completed', 'color':'#16A34A'},
    '3cf39395-2933-471f-962e-b9b9cc0cb108': {'name':'Out of Scope',     'group':'cancelled', 'color':'#EF4444'},
    '8827479c-b4a5-4aea-a468-17a942f29f4c': {'name':'Discarded',        'group':'cancelled', 'color':'#DC2626'},
}
STATE_GROUP_INFO = {
    'completed': {'label':'Completed','color':'#16A34A','cls':'b-done'},
    'started':   {'label':'Started',  'color':'#F59E0B','cls':'b-inprogress'},
    'unstarted': {'label':'Unstarted','color':'#85B7EB','cls':'b-todo'},
    'backlog':   {'label':'Backlog',  'color':'#888780','cls':'b-backlog'},
    'cancelled': {'label':'Cancelled','color':'#A32D2D','cls':'b-cancelled'},
}
# Member display-name lookup. Populated dynamically on refresh from /workspace-members/.
USERS = {}
PALETTE = ['#534AB7','#D85A30','#1D9E75','#BA7517','#D4537E','#185FA5','#639922','#A32D2D','#9B59B6','#16A085','#E67E22','#8E44AD','#2C3E50','#C0392B','#27AE60']

# ---- Refresh state (keyed per workspace+project; refresh held behind a lock) ----
_refresh_lock = threading.Lock()
_refresh_states = {}  # (slug, project_id) -> {in_progress, last_run, last_error, pages_fetched}


def refresh_state_for(slug: str, project_id: str) -> dict:
    key = (safe_slug(slug), project_id)
    st = _refresh_states.get(key)
    if st is None:
        st = {'in_progress': False, 'last_run': None, 'last_error': None, 'pages_fetched': 0}
        _refresh_states[key] = st
    return st


_DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'


def _resolve_api_key(api_key: str = None) -> str:
    """Use the per-request PAT when provided, falling back to env PLANE_API_KEY."""
    key = (api_key or PLANE_API_KEY or '').strip()
    if not key:
        raise RuntimeError('no Plane PAT available for this request (sign in or set PLANE_API_KEY)')
    return key


def plane_patch(path: str, body: dict, api_key: str = None) -> dict:
    """PATCH against Plane REST API. Returns parsed JSON (or empty dict)."""
    url = f'{_active_api_base}/{path.lstrip("/")}'
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, method='PATCH',
        headers={
            'X-API-Key': _resolve_api_key(api_key),
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': _DEFAULT_UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            txt = resp.read().decode()
            return json.loads(txt) if txt.strip() else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors='ignore')[:500]
        raise RuntimeError(f'Plane API {e.code} on PATCH {path}: {msg}') from None


def plane_post(path: str, body: dict, api_key: str = None) -> dict:
    """POST against Plane REST API. Returns parsed JSON (or empty dict)."""
    url = f'{_active_api_base}/{path.lstrip("/")}'
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, method='POST',
        headers={
            'X-API-Key': _resolve_api_key(api_key),
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': _DEFAULT_UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            txt = resp.read().decode()
            return json.loads(txt) if txt.strip() else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors='ignore')[:500]
        raise RuntimeError(f'Plane API {e.code} on POST {path}: {msg}') from None


def plane_get(path: str, params=None, api_key: str = None, retries: int = 5, api_base: str = None) -> dict:
    """GET against Plane REST API. Returns parsed JSON.

    Retries on HTTP 429 (rate limit) with backoff, honoring Retry-After when the
    server sends it. The bulk due-date-history pass makes many activity calls and
    Plane's limiter is bursty, so transient 429s must be waited out, not dropped.

    `api_base` pins the target instance for this call (defaults to the per-request
    global); the background due-history thread passes it explicitly so a concurrent
    request can't repoint its calls mid-run.
    """
    url = f'{(api_base or _active_api_base)}/{path.lstrip("/")}'
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            'X-API-Key': _resolve_api_key(api_key),
            'Accept': 'application/json',
            'User-Agent': _DEFAULT_UA,
        },
    )
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                retry_after = e.headers.get('Retry-After') if e.headers else None
                try:
                    wait = float(retry_after) if retry_after else 0
                except ValueError:
                    wait = 0
                # Exponential backoff floor when no/short Retry-After is given,
                # capped so a single item can't hold the due-history gate for long.
                wait = min(max(wait, 2 ** attempt), 20)
                print(f'  Plane 429 on {path}; backing off {wait:.0f}s '
                      f'(attempt {attempt + 1}/{retries})', file=sys.stderr)
                time.sleep(wait)
                attempt += 1
                continue
            body = e.read().decode(errors='ignore')[:500]
            raise RuntimeError(f'Plane API {e.code} on {path}: {body}') from None


def fetch_projects(slug: str, api_key: str = None):
    """List projects in the workspace for the dropdown."""
    path = f'workspaces/{slug}/projects/'
    result = plane_get(path, api_key=api_key)
    items = result if isinstance(result, list) else result.get('results') or []
    out = []
    for p in items:
        pid = p.get('id')
        if not pid:
            continue
        out.append({
            'id': pid,
            'name': p.get('name', '') or pid,
            'identifier': p.get('identifier', ''),
        })
    out.sort(key=lambda p: (p['name'] or '').lower())
    return out


def fetch_work_items(project_id: str, slug: str, window_days=WINDOW_DAYS, max_pages=30, api_key: str = None, state: dict = None):
    """Paginate work items newest-first, stop when items age past the window."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).date().isoformat()
    all_items, cursor, pages = [], None, 0
    path = f'workspaces/{slug}/projects/{project_id}/work-items/'
    while pages < max_pages:
        params = {'per_page': 100}
        if cursor:
            params['cursor'] = cursor
        result = plane_get(path, params, api_key=api_key)
        # Plane returns either a paginated dict {results: [...], next_cursor: ..., total_count: ...}
        # or a bare list depending on endpoint version. Handle both.
        if isinstance(result, dict):
            items = result.get('results') or result.get('items') or []
            next_cursor = result.get('next_cursor')
        else:
            items, next_cursor = result, None
        all_items.extend(items)
        if state is not None:
            state['pages_fetched'] = pages + 1
        # Stop early once the oldest item on this page is past the window
        if items:
            oldest = min((i.get('created_at') or '') for i in items)
            if oldest and oldest[:10] < cutoff:
                break
        if not next_cursor:
            # Many APIs use this synthetic cursor format; if next_cursor is null, increment pages
            pages += 1
            if not items:
                break
            cursor = f'100:{pages}:0'
        else:
            pages += 1
            cursor = next_cursor
    return [i for i in all_items if (i.get('created_at') or '')[:10] >= cutoff]


def fetch_work_items_updated_since(project_id: str, slug: str, since_iso: str, max_pages=30, api_key: str = None, state: dict = None):
    """Fetch only items changed since `since_iso`, newest-updated first.

    Orders by -updated_at and stops as soon as a page's newest items are all older
    than the cutoff, so a delta refresh pulls just the handful of changed/new items
    instead of the whole window.
    """
    all_items, cursor, pages = [], None, 0
    path = f'workspaces/{slug}/projects/{project_id}/work-items/'
    while pages < max_pages:
        params = {'per_page': 100, 'order_by': '-updated_at'}
        if cursor:
            params['cursor'] = cursor
        result = plane_get(path, params, api_key=api_key)
        if isinstance(result, dict):
            items = result.get('results') or result.get('items') or []
            next_cursor = result.get('next_cursor')
        else:
            items, next_cursor = result, None
        # Keep only the changed ones; stop once we pass the cutoff.
        fresh = [i for i in items if (i.get('updated_at') or '') > since_iso]
        all_items.extend(fresh)
        if state is not None:
            state['pages_fetched'] = pages + 1
        if len(fresh) < len(items):
            break  # reached items at/older than the cutoff on this page → done
        pages += 1
        if not next_cursor:
            if not items:
                break
            cursor = f'100:{pages}:0'
        else:
            cursor = next_cursor
    return all_items


def fetch_states(project_id: str, slug: str, api_key: str = None):
    """Fetch project states; returns {state_id: {name, group, color}}."""
    try:
        path = f'workspaces/{slug}/projects/{project_id}/states/'
        result = plane_get(path, api_key=api_key)
        items = result if isinstance(result, list) else result.get('results') or []
        out = {}
        for s in items:
            sid = s.get('id')
            if not sid:
                continue
            group = (s.get('group') or 'backlog').lower()
            if group not in STATE_GROUP_INFO:
                group = 'backlog'
            out[sid] = {
                'name': s.get('name', 'Unknown'),
                'group': group,
                'color': s.get('color') or STATE_GROUP_INFO[group]['color'],
            }
        return out
    except Exception as e:
        print(f'  ! could not load states for {project_id} ({e}). Falling back to hardcoded.', file=sys.stderr)
        return {}


def fetch_types(project_id: str, slug: str, api_key: str = None):
    """Fetch project work item types; returns {type_id: {name, color}}."""
    endpoints = [
        f'workspaces/{slug}/projects/{project_id}/work-item-types/',
        f'workspaces/{slug}/projects/{project_id}/issue-types/',
    ]
    for endpoint in endpoints:
        try:
            result = plane_get(endpoint, api_key=api_key)
            items = result if isinstance(result, list) else result.get('results') or []
            out = {}
            for t in items:
                tid = t.get('id')
                if not tid:
                    continue
                out[tid] = {'name': t.get('name', 'Other'), 'color': t.get('color') or '#888780'}
            if out:
                return out
        except Exception:
            continue
    print(f'  ! could not load work item types for {project_id}. Falling back to hardcoded.', file=sys.stderr)
    return {}


def fetch_labels(project_id: str, slug: str, api_key: str = None):
    """Fetch project labels; returns {label_id: {name, color}}."""
    try:
        path = f'workspaces/{slug}/projects/{project_id}/labels/'
        result = plane_get(path, api_key=api_key)
        items = result if isinstance(result, list) else result.get('results') or []
        out = {}
        for l in items:
            lid = l.get('id')
            if not lid:
                continue
            out[lid] = {'name': l.get('name', '') or 'Unnamed', 'color': l.get('color') or '#888780'}
        return out
    except Exception as e:
        print(f'  ! could not load labels for {project_id} ({e}).', file=sys.stderr)
        return {}


def fetch_cycles(project_id: str, slug: str, api_key: str = None):
    """Fetch project cycles; returns {cycle_id: {name, start_date, end_date}}."""
    try:
        path = f'workspaces/{slug}/projects/{project_id}/cycles/'
        result = plane_get(path, api_key=api_key)
        items = result if isinstance(result, list) else result.get('results') or []
        out = {}
        for c in items:
            cid = c.get('id')
            if not cid:
                continue
            out[cid] = {
                'name': c.get('name', '') or 'Unnamed cycle',
                'start_date': c.get('start_date'),
                'end_date': c.get('end_date'),
            }
        return out
    except Exception as e:
        print(f'  ! could not load cycles for {project_id} ({e}).', file=sys.stderr)
        return {}


def fetch_modules(project_id: str, slug: str, api_key: str = None):
    """Fetch project modules + membership.

    Unlike cycles (a single FK on the work item), modules are a many-to-many
    relationship, so membership is pulled per-module from the module-issues
    endpoint. Returns (meta, item_modules):
      meta:         {module_id: {name}}
      item_modules: {issue_id: [module_id, ...]}
    """
    meta, item_modules = {}, {}
    try:
        path = f'workspaces/{slug}/projects/{project_id}/modules/'
        result = plane_get(path, api_key=api_key)
        mods = result if isinstance(result, list) else result.get('results') or []
    except Exception as e:
        print(f'  ! could not load modules for {project_id} ({e}).', file=sys.stderr)
        return meta, item_modules
    for m in mods:
        mid = m.get('id')
        if not mid:
            continue
        meta[mid] = {'name': m.get('name', '') or 'Unnamed module'}
        try:
            mpath = f'workspaces/{slug}/projects/{project_id}/modules/{mid}/module-issues/'
            mres = plane_get(mpath, api_key=api_key)
            rows = mres if isinstance(mres, list) else mres.get('results') or []
        except Exception as e:
            print(f'  ! could not load issues for module {mid} ({e}).', file=sys.stderr)
            continue
        for r in rows:
            # A module-issues row exposes the issue id as `issue` (M2M through-row);
            # some API versions inline the full issue object instead, so fall back to `id`.
            iid = r.get('issue') or (r.get('issue_detail') or {}).get('id') or r.get('id')
            if iid:
                item_modules.setdefault(iid, []).append(mid)
    return meta, item_modules


def _looks_like_id(s):
    """True if string looks like a raw UUID (with or without dashes) or '<uuid>-intake'."""
    if not s or not isinstance(s, str):
        return False
    v = s.lower()
    if v.endswith('-intake'):
        v = v[:-len('-intake')]
    plain = v.replace('-', '')
    return len(plain) >= 16 and all(c in '0123456789abcdef' for c in plain)


def fetch_members(slug: str, api_key: str = None):
    """Pull workspace members for assignee names. Falls through several fields to skip UUID-as-name junk."""
    try:
        path = f'workspaces/{slug}/members/'
        result = plane_get(path, api_key=api_key)
        members = result if isinstance(result, list) else result.get('results') or []
        out = {}
        for m in members:
            user = m.get('member') if isinstance(m.get('member'), dict) else m
            uid = user.get('id') or m.get('id')
            if not uid:
                continue
            full = ' '.join(filter(None, [user.get('first_name'), user.get('last_name')])).strip()
            candidates = [
                user.get('display_name'),
                m.get('display_name'),
                full,
                user.get('first_name'),
                (user.get('email') or m.get('email') or '').split('@')[0],
            ]
            disp = next((c for c in candidates if c and not _looks_like_id(c)), None)
            if not disp:
                disp = f'User {uid[:8]}'
            out[uid] = disp
        return out
    except Exception as e:
        print(f'  ! could not load members ({e}). Falling back to IDs.', file=sys.stderr)
        return {}


def fetch_work_item_activities(project_id: str, item_id: str, slug: str, max_pages=10, api_key: str = None, api_base: str = None, retries: int = 4):
    """Fetch a single work item's activity log (oldest-first).

    Makes ONE request per page and only follows a *real* next_cursor. We never
    synthesize a cursor: this endpoint can return a bare list of all activities,
    and a synthetic cursor would re-request the same page, multiplying calls and
    tripping the rate limiter.
    """
    path = f'workspaces/{slug}/projects/{project_id}/work-items/{item_id}/activities/'
    all_rows, cursor, pages = [], None, 0
    while pages < max_pages:
        params = {'per_page': 100}
        if cursor:
            params['cursor'] = cursor
        result = plane_get(path, params, api_key=api_key, api_base=api_base, retries=retries)
        if isinstance(result, dict):
            all_rows.extend(result.get('results') or result.get('items') or [])
            cursor = result.get('next_cursor')
        else:
            all_rows.extend(result or [])
            cursor = None
        pages += 1
        if not cursor:
            break
    return all_rows


def due_date_changes(activities: list) -> dict:
    """From a work item's activity log, summarize its due-date (target_date) history.

    Returns {due_count, due_dates, changes} where:
      - due_dates is the DISTINCT due dates the item has been assigned, in first-seen
        order (initial set included; clears ignored; a date repeated later does NOT
        count again). So Jun 12 -> Jun 19 -> Jun 12 yields [Jun 12, Jun 19].
      - due_count = len(due_dates). >= 2 means it has had more than one deadline.
      - changes is the full from->to chain (with timestamps) for the tooltip.
    """
    def norm(v):
        # Plane records an unset date as the string "None" (or null/empty).
        if v is None:
            return None
        s = str(v).strip()
        return None if s == '' or s.lower() == 'none' else s

    entries = sorted(
        (a for a in activities if a.get('field') == 'target_date' and a.get('verb') == 'updated'),
        key=lambda a: a.get('created_at') or '',
    )
    due_dates = []
    seen = set()
    changes = []
    for a in entries:
        old = norm(a.get('old_value'))
        new = norm(a.get('new_value'))
        if old == new:
            continue
        changes.append({'from': old, 'to': new, 'at': a.get('created_at')})
        # Track each DISTINCT real due date assigned, ignoring clears (new is None).
        if new is not None and new not in seen:
            seen.add(new)
            due_dates.append(new)
    return {'due_count': len(due_dates), 'due_dates': due_dates, 'changes': changes}


# Due-date-history activity calls all pass through ONE global gate: only a single
# such call is ever in flight, no matter how many projects refresh at once. The
# delay between calls adapts to Plane's (bursty, sub-60/min) limiter — it grows on
# 429 and eases back on success — so we never storm the user's real workspace.
# Bump when the due_date_changes counting RULE changes, so cached counts are
# recomputed even for items whose updated_at hasn't moved. v2 = distinct due dates.
DUE_LOGIC_VERSION = 2

_due_rate = {
    'gate': threading.Lock(),
    'delay': 1.5,    # current seconds between activity calls
    'min': 1.0,
    'max': 30.0,
}


def _fetch_activities_paced(project_id, item_id, slug, api_key=None, api_base=None):
    """Serialized + adaptively-throttled single-item activity fetch."""
    with _due_rate['gate']:
        time.sleep(_due_rate['delay'])
        try:
            rows = fetch_work_item_activities(project_id, item_id, slug, api_key=api_key, api_base=api_base)
            _due_rate['delay'] = max(_due_rate['min'], _due_rate['delay'] * 0.9)
            return rows
        except RuntimeError as e:
            if '429' in str(e) or 'RATE_LIMIT' in str(e):
                _due_rate['delay'] = min(_due_rate['max'], _due_rate['delay'] * 2)
                print(f'  Due-date rate backoff -> {_due_rate["delay"]:.1f}s between calls', file=sys.stderr)
            raise


def enrich_due_date_history(data: dict, project_id: str, slug: str, api_key: str = None,
                            state: dict = None, api_base: str = None, persist_path=None):
    """Attach `due_count` + `due_dates` to items whose due date may have changed.

    Incremental: only (re)fetches items with no cached count or whose `updated_at`
    changed since we last computed (tracked via `due_history_src`). Everything else
    keeps its carried-over count, so after the first pass each refresh is cheap.
    Items with due_count >= 2 have been rescheduled; the UI shows a pill at >= 2.
    """
    dated = [it for it in data.get('items', []) if it.get('end')]
    todo = [it for it in dated
            if it.get('due_count') is None
            or it.get('due_history_src') != it.get('updated_at')
            or it.get('due_logic_version') != DUE_LOGIC_VERSION]
    total = len(todo)
    if state is not None:
        state['due_history_total'] = total
        state['due_history_done'] = 0
    if not total:
        return
    print(f'  Due-date history: {total} of {len(dated)} dated items need (re)compute...', file=sys.stderr)
    done = 0
    for it in todo:
        try:
            acts = _fetch_activities_paced(project_id, it['id'], slug, api_key=api_key, api_base=api_base)
            hist = due_date_changes(acts)
            it['due_count'] = hist['due_count']
            it['due_dates'] = hist['due_dates']
            it['due_history_src'] = it.get('updated_at')   # mark as computed for this revision
            it['due_logic_version'] = DUE_LOGIC_VERSION
        except Exception as e:
            print(f'  ! due-date history failed for {it.get("seq")}: {e}', file=sys.stderr)
            continue   # leave uncached so the next refresh retries it
        done += 1
        if state is not None:
            state['due_history_done'] = done
        # Persist periodically so pills appear progressively, not only at the end.
        if persist_path is not None and done % 10 == 0:
            try:
                persist_path.write_text(json.dumps(data, default=str))
            except Exception:
                pass


def start_due_history_enrichment(data: dict, project_id: str, slug: str, api_key: str = None, state: dict = None):
    """Run due-date enrichment in a background thread, then rewrite data.json.

    The server is single-threaded, so we must not block request handling for the
    minutes this can take. The base refresh has already written data.json; this
    thread enriches the items and overwrites the file when done, so the pills
    appear on the next data load. Progress is exposed via the refresh state
    (`due_history_in_progress` / `_done` / `_total`) for /api/status polling.
    """
    if state is not None and state.get('due_history_in_progress'):
        print('  Due-date history already running; skipping duplicate pass.', file=sys.stderr)
        return
    dated_total = sum(1 for it in data.get('items', []) if it.get('end'))
    if state is not None:
        state['due_history_in_progress'] = dated_total > 0
        state['due_history_done'] = 0
        state['due_history_total'] = dated_total
        state['due_history_error'] = None
    if not dated_total:
        return
    # Pin the API base now so a later request can't repoint this thread's calls.
    api_base = _active_api_base

    def _run():
        try:
            workspace_dir(slug).mkdir(parents=True, exist_ok=True)
            path = data_path_for(project_id, slug)
            enrich_due_date_history(data, project_id, slug, api_key=api_key, state=state,
                                    api_base=api_base, persist_path=path)
            path.write_text(json.dumps(data, default=str))
            print(f'  Due-date history written for {slug}/{project_id}.', file=sys.stderr)
        except Exception as e:
            print(f'  ! due-date history thread failed: {e}', file=sys.stderr)
            if state is not None:
                state['due_history_error'] = str(e)
        finally:
            if state is not None:
                state['due_history_in_progress'] = False

    threading.Thread(target=_run, name=f'due-history-{project_id[:8]}', daemon=True).start()


def aggregate(items, users, states=None, types=None, labels=None, cycles=None,
              modules=None, item_modules=None, window_days=None):
    """Transform raw Plane items into the dashboard data shape."""
    today = datetime.now(timezone.utc).date()
    cutoff = (today - timedelta(days=window_days or WINDOW_DAYS)).isoformat()

    user_colors = {uid: PALETTE[i % len(PALETTE)] for i, uid in enumerate(sorted(users.keys()))}
    labels = labels or {}

    def state_info(sid):
        if states and sid in states:
            return states[sid]
        return STATES.get(sid, {'name':'Unknown','group':'backlog','color':'#888780'})

    def type_info(tid):
        if types and tid in types:
            return types[tid]
        return TYPES.get(tid, {'name':'Other','color':'#888780'})

    def expand_labels(raw):
        out = []
        for lid in (raw or []):
            if isinstance(lid, dict):
                lid = lid.get('id')
            if not lid:
                continue
            info = labels.get(lid)
            if info:
                out.append({'id': lid, 'name': info['name'], 'color': info['color']})
            else:
                out.append({'id': lid, 'name': lid[:8], 'color': '#888780'})
        return out

    in_window_ids = {i['id'] for i in items}
    items_by_id = {i['id']: i for i in items}
    children_of = defaultdict(list)
    for i in items:
        if i.get('parent') and i['parent'] in in_window_ids:
            children_of[i['parent']].append(i)

    def descendants(item_id, depth=0):
        if depth > 5: return []
        out = []
        for c in children_of.get(item_id, []):
            out.append(c)
            out.extend(descendants(c['id'], depth+1))
        return out

    slim = []
    for i in items:
        si = state_info(i.get('state'))
        ti = type_info(i.get('type_id') or i.get('type'))
        ass = (i.get('assignees') or [])
        # assignees may be uuid strings OR dicts depending on `expand`
        assignee_ids = [a.get('id') if isinstance(a, dict) else a for a in ass]
        assignee_ids = [a for a in assignee_ids if a]
        pa = assignee_ids[0] if assignee_ids else None
        slim.append({
            'id': i['id'],
            'seq': i.get('sequence_id'),
            'name': i.get('name', ''),
            'type': ti['name'],
            'type_color': ti['color'],
            'state': si['name'],
            'state_group': si['group'],
            'state_color': si['color'],
            'priority': i.get('priority') or 'none',
            'parent': i.get('parent') if i.get('parent') in in_window_ids else None,
            'assignee': users.get(pa) if pa else None,
            'assignee_color': user_colors.get(pa) if pa else None,
            'assignee_id': pa,
            'assignee_ids': assignee_ids,
            'start': i.get('start_date'),
            'end': i.get('target_date'),
            'created_at': i.get('created_at'),
            'updated_at': i.get('updated_at'),
            'cycle_id': i.get('cycle_id'),
            'module_ids': (item_modules or {}).get(i['id'], []),
            'labels': expand_labels(i.get('labels')),
            'description_html': i.get('description_html') or '',
            'description_stripped': i.get('description_stripped') or '',
        })

    total = len(items)
    group_counts = Counter(state_info(i.get('state'))['group'] for i in items)
    priority_counts = Counter((i.get('priority') or 'none') for i in items)
    type_counts = Counter(type_info(i.get('type_id') or i.get('type'))['name'] for i in items)

    done = group_counts.get('completed', 0)
    in_progress = group_counts.get('started', 0)
    backlog = group_counts.get('backlog', 0)
    unstarted = group_counts.get('unstarted', 0)
    cancelled = group_counts.get('cancelled', 0)
    workable = total - cancelled
    pct_done = round(100 * done / workable) if workable else 0

    # Activity by week
    weeks = defaultdict(int)
    for i in items:
        ca = i.get('created_at')
        if not ca: continue
        try:
            d = datetime.fromisoformat(ca.replace('Z','+00:00')).date()
        except Exception:
            continue
        monday = d - timedelta(days=d.weekday())
        weeks[monday.isoformat()] += 1
    spark_weeks = []
    cursor = min(weeks.keys()) if weeks else (today - timedelta(weeks=26)).isoformat()
    c = datetime.fromisoformat(cursor).date()
    while c <= today:
        spark_weeks.append({'week': c.isoformat(), 'count': weeks.get(c.isoformat(), 0)})
        c += timedelta(days=7)

    # Portfolios: Feature-type items with the most descendants
    feature_tid = 'cf1334d1-2ef2-40d4-a7a6-9014f5279a9c'
    cand = [i for i in items if (i.get('type_id') or i.get('type')) == feature_tid]
    scored = sorted(((len(descendants(c['id'])), c) for c in cand), key=lambda x: -x[0])
    portfolios_out = []
    for n, p in scored[:6]:
        if n == 0: continue
        ds = descendants(p['id'])
        bd = Counter(state_info(d.get('state'))['group'] for d in ds)
        bd_total = len(ds)
        bd_workable = bd_total - bd.get('cancelled', 0)
        bd_pct = round(100 * bd.get('completed', 0) / bd_workable) if bd_workable else 0
        bd_dict = dict(bd)
        bd_dict.update({'_total': bd_total, '_workable': bd_workable, '_done': bd.get('completed', 0), '_pct': bd_pct})
        ass = (p.get('assignees') or [])
        pa = ass[0] if ass else None
        if isinstance(pa, dict): pa = pa.get('id')
        portfolios_out.append({
            'id': p['id'], 'name': p.get('name',''), 'seq': p.get('sequence_id'),
            'state': state_info(p.get('state'))['name'], 'state_group': state_info(p.get('state'))['group'],
            'priority': p.get('priority') or 'none',
            'start_date': p.get('start_date'), 'target_date': p.get('target_date'),
            'assignee': users.get(pa) if pa else None, 'assignee_id': pa,
            'breakdown': bd_dict,
        })

    states_list = [{'id': sid, **info} for sid, info in (states or {}).items()] if states else []
    labels_list = [{'id': lid, **info} for lid, info in (labels or {}).items()]
    cycles_list = [{'id': cid, **info} for cid, info in (cycles or {}).items()]
    modules_list = [{'id': mid, **info} for mid, info in (modules or {}).items()]
    return {
        'items': slim,
        'kpi': {'total': total, 'pct_done': pct_done, 'done': done, 'in_progress': in_progress,
                'unstarted': unstarted, 'backlog': backlog, 'cancelled': cancelled, 'workable': workable},
        'group_counts': dict(group_counts),
        'priority_counts': dict(priority_counts),
        'type_counts': dict(type_counts),
        'portfolios': portfolios_out,
        'weeks': spark_weeks,
        'today': today.isoformat(),
        'cutoff': cutoff,
        'state_group_info': STATE_GROUP_INFO,
        'users': users,
        'user_colors': user_colors,
        'states_list': states_list,
        'labels_list': labels_list,
        'cycles': cycles_list,
        'modules': modules_list,
    }


def _load_raw_cache(project_id: str, slug: str):
    path = raw_path_for(project_id, slug)
    if not path.exists():
        return None
    try:
        cached = json.loads(path.read_text())
    except Exception:
        return None
    if not cached.get('items') or not cached.get('last_refreshed_at'):
        return None
    return cached


def do_refresh(project_id: str, slug: str, api_key: str = None, state: dict = None, window_days: int = None):
    """Re-fetch + write data/<slug>/<project_id>.json. Returns updated data.

    Incremental by default: if a raw cache exists, fetch only items updated since
    the last refresh and merge them in. A full window pull happens only when the
    raw cache is missing (first run, or the user deleted it from Settings).
    """
    # Timestamp captured BEFORE fetching, so the next delta re-checks anything that
    # changed during this run (a small, harmless overlap beats missing an edit).
    started_at = datetime.now(timezone.utc).isoformat()
    print(f'  Fetching workspace members for {slug}...', file=sys.stderr)
    users = fetch_members(slug, api_key=api_key)
    print(f'  Got {len(users)} members.', file=sys.stderr)
    print(f'  Fetching project states + types + labels for {project_id}...', file=sys.stderr)
    states = fetch_states(project_id, slug, api_key=api_key)
    types = fetch_types(project_id, slug, api_key=api_key)
    labels = fetch_labels(project_id, slug, api_key=api_key)
    cycles = fetch_cycles(project_id, slug, api_key=api_key)
    modules, item_modules = fetch_modules(project_id, slug, api_key=api_key)
    print(f'  Got {len(states)} states, {len(types)} work item types, {len(labels)} labels, {len(cycles)} cycles, {len(modules)} modules.', file=sys.stderr)
    # Resolve this project's identifier + name once, stored in _meta so the
    # multi-project merge can tag items without any per-load API call.
    proj_identifier, proj_name = None, None
    try:
        for p in fetch_projects(slug, api_key=api_key):
            if p['id'] == project_id:
                proj_identifier, proj_name = p.get('identifier'), p.get('name')
                break
    except Exception:
        pass

    wd = window_days or WINDOW_DAYS
    cutoff = (datetime.now(timezone.utc) - timedelta(days=wd)).date().isoformat()
    # Scale the page budget with the window so long (1–2 year) pulls aren't truncated.
    max_pages = max(30, min(300, round(30 * wd / WINDOW_DAYS)))
    prev_raw = _load_raw_cache(project_id, slug)
    # A delta refresh only re-fetches recently-changed items, so it can't backfill
    # older history. An explicit window request (e.g. fetch 1–2 years) must do a
    # full pull to widen the cache; the default (no window_days) stays incremental.
    if prev_raw and not window_days:
        since = prev_raw['last_refreshed_at']
        print(f'  Delta refresh: fetching items updated since {since}...', file=sys.stderr)
        delta = fetch_work_items_updated_since(project_id, slug, since, api_key=api_key, state=state)
        by_id = {i['id']: i for i in prev_raw['items']}
        for it in delta:
            by_id[it['id']] = it
        items = [i for i in by_id.values() if (i.get('created_at') or '')[:10] >= cutoff]
        mode = 'delta'
        print(f'  Delta: {len(delta)} changed; {len(items)} items in window.', file=sys.stderr)
    else:
        print(f'  Full refresh: fetching work items (last {wd} days)...', file=sys.stderr)
        items = fetch_work_items(project_id, slug, window_days=wd, max_pages=max_pages, api_key=api_key, state=state)
        mode = 'full'
        print(f'  Full: {len(items)} items in window.', file=sys.stderr)

    workspace_dir(slug).mkdir(parents=True, exist_ok=True)
    raw_path_for(project_id, slug).write_text(json.dumps(
        {'items': items, 'last_refreshed_at': started_at,
         'project_id': project_id, 'workspace_slug': slug}, default=str))

    data = aggregate(items, users, states, types, labels, cycles,
                     modules=modules, item_modules=item_modules, window_days=wd)
    # Carry over any previously-computed due-date history so the pills don't blink
    # off between the fast write below and the background re-enrichment completing.
    _carry_due_date_history(data, project_id, slug)
    data['_meta'] = {
        'last_refreshed_at': started_at,
        'item_count': len(items),
        'window_days': wd,
        'project_id': project_id,
        'project_identifier': proj_identifier,
        'project_name': proj_name,
        'workspace_slug': slug,
        'refresh_mode': mode,
    }
    data_path_for(project_id, slug).write_text(json.dumps(data, default=str))
    snapshot = {
        'ts': data['_meta']['last_refreshed_at'],
        'group_counts': data['group_counts'],
        'priority_counts': data['priority_counts'],
        'type_counts': data['type_counts'],
        'kpi': data['kpi'],
    }
    with history_path_for(project_id, slug).open('a') as fh:
        fh.write(json.dumps(snapshot, default=str) + '\n')
    # Due-date history is slow (one activity call per dated item); compute it in a
    # background thread that rewrites data.json when done, so the refresh request
    # returns promptly and the single-threaded server stays responsive.
    start_due_history_enrichment(data, project_id, slug, api_key=api_key, state=state)
    return data


def _carry_due_date_history(data: dict, project_id: str, slug: str):
    """Seed due_count/due_dates on fresh items from the previous data.json, if any.

    Avoids the pills disappearing for ~2 minutes on every refresh while the
    background pass recomputes them; stale-but-present beats absent.
    """
    path = data_path_for(project_id, slug)
    if not path.exists():
        return
    try:
        prev = json.loads(path.read_text())
    except Exception:
        return
    prev_hist = {i['id']: i for i in prev.get('items', []) if i.get('due_count') is not None}
    for it in data.get('items', []):
        old = prev_hist.get(it['id'])
        if old is not None:
            it['due_count'] = old.get('due_count')
            it['due_dates'] = old.get('due_dates')
            it['due_history_src'] = old.get('due_history_src')
            it['due_logic_version'] = old.get('due_logic_version')


# ---- Auth: signed-cookie session keyed on Plane PAT ----

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64url_decode(s: str) -> bytes:
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(payload: str) -> str:
    mac = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return _b64url_encode(mac)


def make_session_token(email: str, pat: str, user_id: str = '', display_name: str = '', remembered=None, api_base: str = '', ttl: int = None) -> str:
    """Signed cookie value carrying the user's identity + Plane PAT + the list of
    workspaces they've added (most-recent first) + the instance API base.

    Format: b64(email).b64(pat).b64(user_id).b64(display_name).b64(remembered_csv).b64(api_base).expiry.sig
    Signed with SESSION_SECRET — anyone tampering breaks the sig.
    The PAT is base64-encoded but not encrypted; the cookie is HttpOnly/SameSite=Lax.
    """
    ttl = ttl if ttl is not None else SESSION_TTL_SECONDS
    expiry = int(time.time()) + ttl
    remembered_csv = ','.join(safe_slug(s) for s in (remembered or []) if safe_slug(s))
    payload = (
        f'{_b64url_encode(email.encode())}.'
        f'{_b64url_encode(pat.encode())}.'
        f'{_b64url_encode((user_id or "").encode())}.'
        f'{_b64url_encode((display_name or "").encode())}.'
        f'{_b64url_encode(remembered_csv.encode())}.'
        f'{_b64url_encode((api_base or "").encode())}.'
        f'{expiry}'
    )
    return f'{payload}.{_sign(payload)}'


def parse_session_token(token: str):
    """Return (email, pat, user_id, display_name, remembered_list, api_base) if valid,
    else all None.

    Segment 5 is a CSV of remembered workspace slugs; segment 6 is the instance API
    base. Older tokens that predate either field fall back to empty / the cloud base.
    """
    none = (None, None, None, None, None, None)
    if not token or not SESSION_SECRET:
        return none
    parts = token.split('.')
    user_b64 = name_b64 = ws_b64 = base_b64 = ''
    if len(parts) == 8:
        email_b64, pat_b64, user_b64, name_b64, ws_b64, base_b64, expiry_s, sig = parts
    elif len(parts) == 7:
        email_b64, pat_b64, user_b64, name_b64, ws_b64, expiry_s, sig = parts
    elif len(parts) == 6:
        email_b64, pat_b64, user_b64, name_b64, expiry_s, sig = parts
    elif len(parts) == 5:
        email_b64, pat_b64, user_b64, expiry_s, sig = parts
    elif len(parts) == 4:
        email_b64, pat_b64, expiry_s, sig = parts
    else:
        return none
    # The signed payload is every segment except the trailing signature.
    payload = '.'.join(parts[:-1])
    if not hmac.compare_digest(_sign(payload), sig):
        return none
    try:
        if int(expiry_s) < int(time.time()):
            return none
        email = _b64url_decode(email_b64).decode('utf-8')
        pat = _b64url_decode(pat_b64).decode('utf-8')
        user_id = _b64url_decode(user_b64).decode('utf-8') if user_b64 else ''
        display_name = _b64url_decode(name_b64).decode('utf-8') if name_b64 else ''
        ws_csv = _b64url_decode(ws_b64).decode('utf-8') if ws_b64 else ''
        remembered = [safe_slug(s) for s in ws_csv.split(',') if safe_slug(s)]
        api_base = (_b64url_decode(base_b64).decode('utf-8') if base_b64 else '') or PLANE_API_BASE
        return email, pat, user_id, display_name, remembered, api_base
    except (ValueError, UnicodeDecodeError):
        return none


def _resolve_display_name(info: dict) -> str:
    """Pick the best human-readable name from a Plane /users/me/ response."""
    full = ' '.join(filter(None, [info.get('first_name'), info.get('last_name')])).strip()
    candidates = [
        full,
        info.get('display_name'),
        info.get('first_name'),
        (info.get('email') or '').split('@')[0],
    ]
    return next((c for c in candidates if c and not _looks_like_id(c)), '')


def _email_allowed(email: str) -> bool:
    if not email or '@' not in email:
        return False
    domain = email.rsplit('@', 1)[1].lower()
    return domain in ALLOWED_EMAIL_DOMAINS


def _cookie_header(name: str, value: str, max_age: int, http_only: bool = True) -> str:
    parts = [f'{name}={value}', f'Max-Age={max_age}', 'Path=/', 'SameSite=Lax']
    # Some browsers prefer Expires over Max-Age for persistent cookies; include both
    # so the cookie survives browser restarts even when privacy settings ignore Max-Age.
    if max_age > 0:
        expires_dt = datetime.utcnow() + timedelta(seconds=max_age)
        parts.append('Expires=' + expires_dt.strftime('%a, %d %b %Y %H:%M:%S GMT'))
    if http_only:
        parts.append('HttpOnly')
    return '; '.join(parts)


def _read_cookies(handler) -> dict:
    raw = handler.headers.get('Cookie', '')
    if not raw:
        return {}
    jar = http.cookies.SimpleCookie()
    try:
        jar.load(raw)
    except http.cookies.CookieError:
        return {}
    return {k: morsel.value for k, morsel in jar.items()}


def _session(handler):
    """Return (email, pat, user_id, display_name, remembered_list), or all None."""
    return parse_session_token(_read_cookies(handler).get(SESSION_COOKIE, ''))


def _redirect(handler, location: str, status: int = 302, set_cookies=None):
    handler.send_response(status)
    handler.send_header('Location', location)
    handler.send_header('Cache-Control', 'no-store')
    for c in (set_cookies or []):
        handler.send_header('Set-Cookie', c)
    handler.send_header('Content-Length', '0')
    handler.end_headers()


def auth_enabled() -> bool:
    return bool(SESSION_SECRET)


def fetch_plane_user(api_key: str) -> dict:
    """Call Plane's /users/me/ with the given PAT. Raises on failure."""
    url = f'{_active_api_base}/users/me/'
    req = urllib.request.Request(
        url,
        headers={'X-API-Key': api_key, 'Accept': 'application/json', 'User-Agent': _DEFAULT_UA},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


LOGIN_PAGE_HTML = """<!doctype html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>Sign in · Program Tracker</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; background: #0b0d12; color: #e6e7ea; }
  .card { width: min(420px, 92vw); padding: 32px 28px; border-radius: 14px; background: #14171f; border: 1px solid #232733; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
  .logo { width: 36px; height: 36px; margin: 0 auto 12px; display: block; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; text-align: center; }
  p { margin: 0 0 20px; color: #9aa0ad; font-size: 13px; line-height: 1.5; text-align: center; }
  label { display: block; font-size: 12px; color: #b9bdc8; margin: 0 0 6px; font-weight: 500; }
  input[type=password], input[type=text] { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; font-size: 13px; color: #e6e7ea; background: #0b0d12; border: 1px solid #2b303d; border-radius: 8px; outline: none; }
  input[type=password]:focus, input[type=text]:focus { border-color: #3F76FF; }
  .field { margin-bottom: 12px; }
  button { margin-top: 14px; width: 100%; padding: 10px 18px; font: inherit; font-size: 14px; font-weight: 500; color: white; background: #3F76FF; border: 0; border-radius: 8px; cursor: pointer; transition: background .15s; }
  button:hover { background: #5388ff; }
  .err { margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; background: #3a1d1d; color: #ffb4b4; font-size: 13px; }
  .hint { margin-top: 14px; font-size: 11px; color: #6a7080; text-align: center; line-height: 1.5; }
  .hint a { color: #8aa9ff; text-decoration: none; }
  .hint a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class=\"card\">
    <svg class=\"logo\" viewBox=\"0 0 32 32\" xmlns=\"http://www.w3.org/2000/svg\" aria-hidden>
      <rect width=\"32\" height=\"32\" rx=\"7\" fill=\"#3F76FF\"/>
      <path d=\"M10 8.5L20 16L10 23.5V8.5Z\" fill=\"white\"/>
      <circle cx=\"23\" cy=\"14.5\" r=\"3\" fill=\"white\" fill-opacity=\"0.9\"/>
    </svg>
    <h1>Program Tracker</h1>
    <p>Sign in with your Plane Personal Access Token.</p>
    __ERROR__
    <form method=\"POST\" action=\"/auth/pat/login\" autocomplete=\"off\">
      <div class=\"field\">
        <label for=\"url\">Plane URL</label>
        <input id=\"url\" name=\"url\" type=\"text\" placeholder=\"https://app.plane.so/\" value=\"https://app.plane.so/\">
      </div>
      <div class=\"field\">
        <label for=\"pat\">Plane PAT</label>
        <input id=\"pat\" name=\"pat\" type=\"password\" placeholder=\"plane_api_…\" autofocus required>
      </div>
      <button type=\"submit\">Sign in</button>
    </form>
    <div class=\"hint\">
      Sign in with your account token; you'll pick a workspace inside the app.<br>
      Get a token at <a href=\"https://app.plane.so/profile/settings\" target=\"_blank\" rel=\"noopener\">app.plane.so → Personal Access Tokens</a>.<br>
      Only __DOMAINS__ accounts allowed.
    </div>
  </div>
</body>
</html>
"""


def render_login_page(error: str = None) -> bytes:
    err_html = ''
    if error:
        safe = error.replace('<', '&lt;').replace('>', '&gt;')
        err_html = f'<div class="err">{safe}</div>'
    domains = ', '.join('@' + d for d in ALLOWED_EMAIL_DOMAINS) or '(any)'
    html = LOGIN_PAGE_HTML.replace('__ERROR__', err_html).replace('__DOMAINS__', domains)
    return html.encode('utf-8')


class Handler(BaseHTTPRequestHandler):
    # Optional Set-Cookie header to attach to the next response. Set by
    # _require_auth when a valid session is found, to roll the cookie's expiry
    # forward (sliding session). Read by _send_* helpers, then cleared.
    _renew_cookie: str = ''

    def _emit_renew_cookie(self):
        if self._renew_cookie:
            self.send_header('Set-Cookie', self._renew_cookie)
            self._renew_cookie = ''

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, default=str).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self._emit_renew_cookie()
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, content_type: str):
        if not path.exists():
            self.send_error(404, f'{path.name} missing')
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self._emit_renew_cookie()
        self.end_headers()
        self.wfile.write(body)

    def _query_project_id(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        pid = (qs.get('project_id') or [PLANE_PROJECT_ID])[0]
        return parsed.path, pid

    def _require_auth(self, path: str):
        """Return (email, pat, remembered_workspaces) for the signed-in user, or
        send 302/401 and return None.

        The active workspace is NOT in the session — it comes from the request
        (the `workspace` query param / URL). The session only carries the list of
        workspaces the user has added. Empty list is allowed (fresh login).

        - If auth is not configured (no SESSION_SECRET), falls back to the global
          PLANE_API_KEY + PLANE_WORKSPACE_SLUG so single-user local-dev still works.
        - HTML requests get a 302 to /login; API requests get 401 JSON.
        """
        global _active_api_base
        if not auth_enabled():
            _active_api_base = PLANE_API_BASE
            env = safe_slug(PLANE_WORKSPACE_SLUG)
            return ('__noauth__', PLANE_API_KEY, [env] if env else [])
        email, pat, user_id, name, remembered, api_base = _session(self)
        if email and pat and _email_allowed(email):
            # Point all Plane calls at this session's instance for the request.
            _active_api_base = api_base or PLANE_API_BASE
            # Sliding session: refresh cookie expiry on every authenticated
            # request so active users never get bumped to /login. Cookie is
            # attached automatically by _send_* helpers.
            fresh = make_session_token(email, pat, user_id, name, remembered=remembered, api_base=_active_api_base)
            self._renew_cookie = _cookie_header(SESSION_COOKIE, fresh, max_age=SESSION_TTL_SECONDS)
            return (email, pat, remembered)
        if path.startswith('/api/'):
            self._send_json({'error': 'unauthenticated'}, 401)
        else:
            _redirect(self, '/login')
        return None

    def _workspace(self, remembered):
        """Resolve the active workspace for this request from the `workspace`
        query param, validated against the user's remembered list. Returns '' if
        the param names a workspace the user hasn't added. Defaults to the most
        recent remembered workspace when the param is absent."""
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        ws = safe_slug((qs.get('workspace') or [''])[0])
        if ws:
            return ws if ws in remembered else ''
        return remembered[0] if remembered else ''

    def _send_html(self, body: bytes, status: int = 200, set_cookies=None):
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        for c in (set_cookies or []):
            self.send_header('Set-Cookie', c)
        self._emit_renew_cookie()
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, rel: str) -> bool:
        """Serve a file under static/ if it exists. Returns True if handled."""
        if '..' in rel.split('/'):
            self.send_error(403)
            return True
        p = HERE / 'static' / rel
        if not p.is_file():
            return False
        ctype, _ = mimetypes.guess_type(str(p))
        if not ctype:
            ctype = 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        self._send_file(p, ctype)
        return True

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        raw_path = parsed.path

        # ---- Public auth routes ----
        if raw_path == '/login':
            qs = urllib.parse.parse_qs(parsed.query)
            err = (qs.get('error') or [None])[0]
            self._send_html(render_login_page(err))
            return

        # ---- Auth guard for everything else ----
        auth = self._require_auth(raw_path)
        if auth is None:
            return
        _email, api_key, remembered = auth

        # Serve React build at /. Legacy /dashboard.html still works during transition.
        if self.path == '/' or self.path.startswith('/?'):
            self._send_file(HERE / 'static' / 'dist' / 'index.html', 'text/html; charset=utf-8')
            return
        if self.path == '/dashboard.legacy.html':
            legacy = HERE / 'dashboard.legacy.html'
            if legacy.exists():
                self._send_file(legacy, 'text/html; charset=utf-8')
                return
        if self.path.startswith('/static/'):
            if self._serve_static(self.path[len('/static/'):]):
                return
            self.send_error(404)
            return
        path, pid = self._query_project_id()
        slug = self._workspace(remembered)
        if path == '/api/me':
            if auth_enabled():
                email, _pat, user_id, display_name, _r, _ab = _session(self)
            else:
                email, user_id, display_name = None, None, None
            self._send_json({
                'email': email,
                'user_id': user_id,
                'display_name': display_name,
                'workspaces': remembered,
                'workspace_slug': slug,
                'auth_enabled': auth_enabled(),
            })
            return
        if path == '/api/projects':
            if not slug:
                self._send_json({'projects': [], 'default_project_id': None, 'workspace_slug': '', 'needs_workspace': True})
                return
            try:
                projects = fetch_projects(slug, api_key)
                ids = {p['id'] for p in projects}
                default_pid = PLANE_PROJECT_ID if PLANE_PROJECT_ID in ids else (projects[0]['id'] if projects else None)
                self._send_json({'projects': projects, 'default_project_id': default_pid, 'workspace_slug': slug})
            except Exception as e:
                self._send_json({'error': str(e)}, 500)
            return
        if path == '/api/data':
            if not slug:
                self._send_json({'error': 'no workspace selected', 'needs_workspace': True}, 400)
                return
            pids = [x for x in pid.split(',') if x]
            if len(pids) > 1:
                # Combined view: stitch together each project's cached dashboard.
                datas, missing = [], []
                for one in pids:
                    dp = data_path_for(one, slug)
                    try:
                        raw = dp.read_bytes() if dp.exists() else b''
                    except OSError:
                        raw = b''
                    if raw and b'"labels_list"' in raw:
                        try:
                            d = json.loads(raw)
                        except Exception:
                            d = None
                        if d:
                            meta = d.get('_meta') or {}
                            meta.setdefault('project_id', one)
                            d['_meta'] = meta
                            datas.append(d)
                            continue
                    missing.append(one)
                if not datas:
                    self._send_json({'error': 'no cached data for selected projects; click Refresh',
                                     'project_ids': pids, 'missing': missing}, 404)
                    return
                # Fill any project identifiers missing from older caches (one call).
                if any(not (d.get('_meta') or {}).get('project_identifier') for d in datas):
                    try:
                        pm = {p['id']: p for p in fetch_projects(slug, api_key=api_key)}
                        for d in datas:
                            m = d['_meta']
                            info = pm.get(m.get('project_id')) or {}
                            m.setdefault('project_identifier', info.get('identifier'))
                            m.setdefault('project_name', info.get('name'))
                    except Exception:
                        pass
                merged = merge_dashboards(datas)
                merged['_meta']['workspace_slug'] = slug
                merged['_meta']['missing'] = missing
                self._send_json(merged)
                return
            pid = pids[0] if pids else pid
            p = data_path_for(pid, slug)
            if p.exists():
                # Auto-invalidate caches written before the labels feature.
                # The `labels_list` key was added when fetch_labels landed; its
                # absence means the JSON predates the schema. Return 404 so the
                # frontend's cache-miss path auto-pulls fresh data with labels.
                try:
                    raw = p.read_bytes()
                except OSError:
                    raw = b''
                if raw and b'"labels_list"' not in raw:
                    self._send_json({
                        'error': 'cache predates labels schema; refresh required',
                        'project_id': pid,
                        'state': refresh_state_for(slug, pid),
                    }, 404)
                    return
                if raw:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('Content-Length', str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                self._send_file(p, 'application/json')
            else:
                self._send_json({'error': 'no cached data; click Refresh', 'project_id': pid, 'state': refresh_state_for(slug, pid)}, 404)
            return
        if path == '/api/history':
            hist_path = history_path_for(pid, slug)
            if hist_path.exists():
                rows = [json.loads(line) for line in hist_path.read_text().splitlines() if line.strip()]
                self._send_json({'history': rows})
            else:
                self._send_json({'history': []})
            return
        if path == '/api/status':
            self._send_json(refresh_state_for(slug, pid))
            return
        if path == '/api/cache':
            entries = list_cache_entries(remembered)
            # Best-effort project names per workspace (one cheap projects call each).
            names_by_ws = {}
            for ws in {e['workspace_slug'] for e in entries}:
                try:
                    names_by_ws[ws] = {p['id']: p['name'] for p in fetch_projects(ws, api_key=api_key)}
                except Exception:
                    names_by_ws[ws] = {}
            for e in entries:
                e['project_name'] = names_by_ws.get(e['workspace_slug'], {}).get(e['project_id'])
            self._send_json({'cache': entries})
            return
        if path == '/api/work-item-comments':
            qs = urllib.parse.parse_qs(parsed.query)
            item_id = (qs.get('item_id') or [''])[0]
            project_id = pid or PLANE_PROJECT_ID
            if not item_id:
                self._send_json({'error': 'item_id is required'}, 400)
                return
            api_path = f'workspaces/{slug}/projects/{project_id}/work-items/{item_id}/comments/'
            try:
                result = plane_get(api_path, api_key=api_key)
                rows = result.get('results') if isinstance(result, dict) else result
                self._send_json({'comments': rows or []})
            except Exception as e:
                self._send_json({'error': str(e)}, 500)
            return
        if path == '/api/work-item-activities':
            qs = urllib.parse.parse_qs(parsed.query)
            item_id = (qs.get('item_id') or [''])[0]
            project_id = pid or PLANE_PROJECT_ID
            if not item_id:
                self._send_json({'error': 'item_id is required'}, 400)
                return
            try:
                acts = fetch_work_item_activities(project_id, item_id, slug, api_key=api_key)
                self._send_json(due_date_changes(acts))
            except Exception as e:
                self._send_json({'error': str(e)}, 500)
            return
        # SPA fallback: client-side routes (e.g. /roadmap, /pulse) are served the
        # app shell so deep-links and refreshes work. (Auth already enforced above;
        # unknown /api/* paths still 404.)
        if not raw_path.startswith('/api/'):
            self._send_file(HERE / 'static' / 'dist' / 'index.html', 'text/html; charset=utf-8')
            return
        self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        raw_path = parsed.path

        if raw_path == '/auth/logout':
            clear = _cookie_header(SESSION_COOKIE, '', max_age=0)
            _redirect(self, '/login', set_cookies=[clear])
            return

        if raw_path == '/auth/pat/login':
            if not auth_enabled():
                _redirect(self, '/login?error=auth+not+configured+(SESSION_SECRET+missing)')
                return
            length = int(self.headers.get('Content-Length', 0) or 0)
            raw_body = self.rfile.read(length).decode('utf-8', errors='replace') if length else ''
            ctype = (self.headers.get('Content-Type') or '').lower()
            pat = ''
            url_in = ''
            if 'application/x-www-form-urlencoded' in ctype:
                form = urllib.parse.parse_qs(raw_body)
                pat = (form.get('pat') or [''])[0].strip()
                url_in = (form.get('url') or [''])[0].strip()
            elif 'application/json' in ctype:
                try:
                    j = json.loads(raw_body) or {}
                    pat = (j.get('pat') or '').strip()
                    url_in = (j.get('url') or '').strip()
                except Exception:
                    pat = ''
            if not pat:
                _redirect(self, '/login?error=PAT+is+required')
                return
            # The Plane URL selects the instance (cloud or self-hosted); the
            # workspace is chosen in-app afterwards. Point Plane calls at that
            # instance for this request so the PAT is validated against it.
            global _active_api_base
            _active_api_base = derive_api_base(url_in)
            try:
                info = fetch_plane_user(pat)
            except urllib.error.HTTPError as e:
                code = getattr(e, 'code', 'error')
                _redirect(self, f'/login?error=Plane+rejected+the+PAT+({code})')
                return
            except Exception as e:
                _redirect(self, f'/login?error={urllib.parse.quote(("could not reach " + _active_api_base + ": " + str(e))[:140])}')
                return
            email = (info.get('email') or '').strip().lower()
            if not email:
                _redirect(self, '/login?error=Plane+did+not+return+an+email+for+this+PAT')
                return
            if not _email_allowed(email):
                msg = f'access restricted to {", ".join(ALLOWED_EMAIL_DOMAINS)}'
                _redirect(self, f'/login?error={urllib.parse.quote(msg)}')
                return
            user_id = (info.get('id') or '').strip()
            display_name = _resolve_display_name(info)
            # Preserve workspaces remembered in a still-valid prior session cookie
            # (same email AND same instance), so re-logging in doesn't wipe the dropdown.
            _e, _p, _u, _n, prior, prior_base = _session(self)
            remembered = prior if (prior and _e == email and prior_base == _active_api_base) else []
            session = make_session_token(email, pat, user_id, display_name, remembered=remembered, api_base=_active_api_base)
            set_session = _cookie_header(SESSION_COOKIE, session, max_age=SESSION_TTL_SECONDS)
            _redirect(self, '/', set_cookies=[set_session])
            return

        auth = self._require_auth(raw_path)
        if auth is None:
            return
        _email, api_key, remembered = auth

        # Add a workspace: validate the PAT can reach it, then remember it.
        if raw_path == '/api/workspaces/add':
            if not auth_enabled():
                self._send_json({'error': 'workspace switching needs per-user auth'}, 400)
                return
            length = int(self.headers.get('Content-Length', 0) or 0)
            try:
                body = json.loads(self.rfile.read(length).decode()) if length else {}
            except Exception:
                self._send_json({'error': 'invalid JSON body'}, 400)
                return
            new_slug = parse_workspace_slug(body.get('url') or body.get('workspace') or '')
            if not new_slug:
                self._send_json({'error': 'a workspace URL or slug is required'}, 400)
                return
            try:
                fetch_projects(new_slug, api_key)
            except Exception:
                self._send_json({'error': f'this token cannot access workspace "{new_slug}" — check the URL and your membership'}, 403)
                return
            email, pat, user_id, name, _r, _ab = _session(self)
            updated = [new_slug] + [s for s in (remembered or []) if s != new_slug]
            fresh = make_session_token(email, pat, user_id, name, remembered=updated)
            # Persist the updated remembered-list in the session cookie (emitted by
            # _send_json via the renew slot, overriding the sliding-session renewal).
            self._renew_cookie = _cookie_header(SESSION_COOKIE, fresh, max_age=SESSION_TTL_SECONDS)
            self._send_json({'ok': True, 'workspace_slug': new_slug, 'workspaces': updated})
            return

        # Delete a project's cached files (data + raw + history). With the raw
        # cache gone the next refresh is a full rebuild instead of a delta.
        if raw_path == '/api/cache/delete':
            length = int(self.headers.get('Content-Length', 0) or 0)
            try:
                body = json.loads(self.rfile.read(length).decode()) if length else {}
            except Exception:
                self._send_json({'error': 'invalid JSON body'}, 400)
                return
            ws = safe_slug(body.get('workspace') or '')
            project_id = (body.get('project_id') or '').strip()
            if not ws or ws not in (remembered or []):
                self._send_json({'error': 'unknown or unauthorized workspace'}, 403)
                return
            if not _PROJECT_ID_RE.match(project_id):
                self._send_json({'error': 'invalid project_id'}, 400)
                return
            removed = delete_cache_for(project_id, ws)
            _refresh_states.pop((ws, project_id), None)
            self._send_json({'ok': True, 'removed': removed})
            return

        path, pid = self._query_project_id()
        slug = self._workspace(remembered)
        if path == '/api/work-item':
            length = int(self.headers.get('Content-Length', 0))
            try:
                body = json.loads(self.rfile.read(length).decode()) if length else {}
            except Exception:
                self._send_json({'error': 'invalid JSON body'}, 400)
                return
            project_id = body.get('project_id') or pid or PLANE_PROJECT_ID
            item_id = body.get('item_id')
            patch_in = body.get('patch') or {}
            if not item_id:
                self._send_json({'error': 'item_id required'}, 400)
                return
            # Strip empty strings, but keep empty arrays for fields like
            # assignee_ids where [] is the only way to clear all assignees.
            ARRAY_CLEARABLE = {'assignee_ids', 'label_ids'}
            patch = {
                k: v for k, v in patch_in.items()
                if v != '' and (v != [] or k in ARRAY_CLEARABLE)
            }
            if not patch:
                self._send_json({'error': 'empty patch'}, 400)
                return
            api_path = f'workspaces/{slug}/projects/{project_id}/work-items/{item_id}/'
            try:
                result = plane_patch(api_path, patch, api_key=api_key)
                self._send_json({'ok': True, 'item': result})
            except Exception as e:
                self._send_json({'error': str(e)}, 500)
            return
        if path == '/api/work-item-comment':
            length = int(self.headers.get('Content-Length', 0))
            try:
                body = json.loads(self.rfile.read(length).decode()) if length else {}
            except Exception:
                self._send_json({'error': 'invalid JSON body'}, 400)
                return
            project_id = body.get('project_id') or pid or PLANE_PROJECT_ID
            item_id = body.get('item_id')
            comment_html = (body.get('comment_html') or '').strip()
            if not item_id or not comment_html:
                self._send_json({'error': 'item_id and comment_html required'}, 400)
                return
            api_path = f'workspaces/{slug}/projects/{project_id}/work-items/{item_id}/comments/'
            try:
                result = plane_post(api_path, {'comment_html': comment_html}, api_key=api_key)
                self._send_json({'ok': True, 'comment': result})
            except Exception as e:
                self._send_json({'error': str(e)}, 500)
            return
        if path == '/api/refresh':
            if not pid:
                self._send_json({'error': 'project_id is required'}, 400)
                return
            # Optional ?window_days= widens the fetch (e.g. 365/730 for 1–2 years).
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                req_wd = int((qs.get('window_days') or ['0'])[0])
            except ValueError:
                req_wd = 0
            wd_arg = min(req_wd, 1100) if req_wd > 0 else None
            st = refresh_state_for(slug, pid)
            if st['in_progress']:
                self._send_json({'error': 'refresh already in progress', 'state': st}, 409)
                return
            with _refresh_lock:
                st['in_progress'] = True
                st['last_error'] = None
                st['pages_fetched'] = 0
                try:
                    data = do_refresh(pid, slug, api_key=api_key, state=st, window_days=wd_arg)
                    st['last_run'] = data['_meta']['last_refreshed_at']
                    self._send_json({'ok': True, 'meta': data['_meta']})
                except Exception as e:
                    st['last_error'] = str(e)
                    self._send_json({'error': str(e), 'state': st}, 500)
                finally:
                    st['in_progress'] = False
            return
        self.send_error(404)

    def log_message(self, format, *args):
        sys.stderr.write(f'[{self.log_date_time_string()}] {format % args}\n')


def main():
    # With per-user auth the workspace is chosen at login, so PLANE_WORKSPACE_SLUG
    # is only required for the no-auth single-user mode.
    if not auth_enabled():
        if not PLANE_WORKSPACE_SLUG:
            print('!! No auth and no PLANE_WORKSPACE_SLUG. Set SESSION_SECRET for per-user login')
            print('   (workspace chosen at sign-in), or set PLANE_WORKSPACE_SLUG for single-user mode.')
            sys.exit(1)
        if not PLANE_API_KEY:
            print('!! No auth and no PLANE_API_KEY. Either set SESSION_SECRET (per-user PAT login)')
            print('   or set PLANE_API_KEY (single-user local dev). See README.md.')
            sys.exit(1)
    migrate_flat_data_files()
    print(f'Dashboard server listening on {HOST}:{PORT}', flush=True)
    print(f'  Window:    last {WINDOW_DAYS} days')
    if auth_enabled():
        print(f'  Auth:      Plane PAT login — workspace chosen at sign-in (domains: {", ".join(ALLOWED_EMAIL_DOMAINS)})')
    else:
        print(f'  Workspace: {PLANE_WORKSPACE_SLUG} (single-user, shared PLANE_API_KEY; set SESSION_SECRET for per-user login)')
    print(f'  Open the URL in your browser, then sign in.')
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()

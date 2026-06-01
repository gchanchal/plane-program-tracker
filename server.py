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


def data_path_for(project_id: str) -> Path:
    return DATA_DIR / f'{project_id}.json'

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

# ---- Refresh state (single-threaded; refresh is held behind a lock) ----
_refresh_lock = threading.Lock()
_refresh_state = {'in_progress': False, 'last_run': None, 'last_error': None, 'pages_fetched': 0}


_DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'


def _resolve_api_key(api_key: str = None) -> str:
    """Use the per-request PAT when provided, falling back to env PLANE_API_KEY."""
    key = (api_key or PLANE_API_KEY or '').strip()
    if not key:
        raise RuntimeError('no Plane PAT available for this request (sign in or set PLANE_API_KEY)')
    return key


def plane_patch(path: str, body: dict, api_key: str = None) -> dict:
    """PATCH against Plane REST API. Returns parsed JSON (or empty dict)."""
    url = f'{PLANE_API_BASE}/{path.lstrip("/")}'
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
    url = f'{PLANE_API_BASE}/{path.lstrip("/")}'
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


def plane_get(path: str, params=None, api_key: str = None) -> dict:
    """GET against Plane REST API. Returns parsed JSON."""
    url = f'{PLANE_API_BASE}/{path.lstrip("/")}'
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
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='ignore')[:500]
        raise RuntimeError(f'Plane API {e.code} on {path}: {body}') from None


def fetch_projects(api_key: str = None):
    """List projects in the workspace for the dropdown."""
    path = f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/'
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


def fetch_work_items(project_id: str, window_days=WINDOW_DAYS, max_pages=30, api_key: str = None):
    """Paginate work items newest-first, stop when items age past the window."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).date().isoformat()
    all_items, cursor, pages = [], None, 0
    path = f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/work-items/'
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
        _refresh_state['pages_fetched'] = pages + 1
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


def fetch_states(project_id: str, api_key: str = None):
    """Fetch project states; returns {state_id: {name, group, color}}."""
    try:
        path = f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/states/'
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


def fetch_types(project_id: str, api_key: str = None):
    """Fetch project work item types; returns {type_id: {name, color}}."""
    endpoints = [
        f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/work-item-types/',
        f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/issue-types/',
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


def fetch_labels(project_id: str, api_key: str = None):
    """Fetch project labels; returns {label_id: {name, color}}."""
    try:
        path = f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/labels/'
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


def _looks_like_id(s):
    """True if string looks like a raw UUID (with or without dashes) or '<uuid>-intake'."""
    if not s or not isinstance(s, str):
        return False
    v = s.lower()
    if v.endswith('-intake'):
        v = v[:-len('-intake')]
    plain = v.replace('-', '')
    return len(plain) >= 16 and all(c in '0123456789abcdef' for c in plain)


def fetch_members(api_key: str = None):
    """Pull workspace members for assignee names. Falls through several fields to skip UUID-as-name junk."""
    try:
        path = f'workspaces/{PLANE_WORKSPACE_SLUG}/members/'
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


def aggregate(items, users, states=None, types=None, labels=None):
    """Transform raw Plane items into the dashboard data shape."""
    today = datetime.now(timezone.utc).date()
    cutoff = (today - timedelta(days=WINDOW_DAYS)).isoformat()

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
    }


def do_refresh(project_id: str, api_key: str = None):
    """Re-fetch + write data-<project_id>.json. Returns updated data."""
    print('  Fetching workspace members...', file=sys.stderr)
    users = fetch_members(api_key=api_key)
    print(f'  Got {len(users)} members.', file=sys.stderr)
    print(f'  Fetching project states + types + labels for {project_id}...', file=sys.stderr)
    states = fetch_states(project_id, api_key=api_key)
    types = fetch_types(project_id, api_key=api_key)
    labels = fetch_labels(project_id, api_key=api_key)
    print(f'  Got {len(states)} states, {len(types)} work item types, {len(labels)} labels.', file=sys.stderr)
    print(f'  Fetching work items for {project_id} (last {WINDOW_DAYS} days)...', file=sys.stderr)
    items = fetch_work_items(project_id, api_key=api_key)
    print(f'  Got {len(items)} items in window.', file=sys.stderr)
    data = aggregate(items, users, states, types, labels)
    data['_meta'] = {
        'last_refreshed_at': datetime.now(timezone.utc).isoformat(),
        'item_count': len(items),
        'window_days': WINDOW_DAYS,
        'project_id': project_id,
        'workspace_slug': PLANE_WORKSPACE_SLUG,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data_path_for(project_id).write_text(json.dumps(data, default=str))
    snapshot = {
        'ts': data['_meta']['last_refreshed_at'],
        'group_counts': data['group_counts'],
        'priority_counts': data['priority_counts'],
        'type_counts': data['type_counts'],
        'kpi': data['kpi'],
    }
    with (DATA_DIR / f'{project_id}.history.jsonl').open('a') as fh:
        fh.write(json.dumps(snapshot, default=str) + '\n')
    return data


# ---- Auth: signed-cookie session keyed on Plane PAT ----

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64url_decode(s: str) -> bytes:
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(payload: str) -> str:
    mac = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return _b64url_encode(mac)


def make_session_token(email: str, pat: str, user_id: str = '', display_name: str = '', ttl: int = None) -> str:
    """Signed cookie value carrying the user's identity + Plane PAT.

    Format: b64(email).b64(pat).b64(user_id).b64(display_name).expiry.sig
    Signed with SESSION_SECRET — anyone tampering breaks the sig.
    The PAT is base64-encoded but not encrypted; the cookie is HttpOnly/SameSite=Lax.
    """
    ttl = ttl if ttl is not None else SESSION_TTL_SECONDS
    expiry = int(time.time()) + ttl
    payload = (
        f'{_b64url_encode(email.encode())}.'
        f'{_b64url_encode(pat.encode())}.'
        f'{_b64url_encode((user_id or "").encode())}.'
        f'{_b64url_encode((display_name or "").encode())}.'
        f'{expiry}'
    )
    return f'{payload}.{_sign(payload)}'


def parse_session_token(token: str):
    """Return (email, pat, user_id, display_name) if valid, else (None, None, None, None).

    Tolerates older 5-segment tokens (no display_name) and 4-segment tokens (no user_id).
    """
    if not token or not SESSION_SECRET:
        return None, None, None, None
    parts = token.split('.')
    if len(parts) == 6:
        email_b64, pat_b64, user_b64, name_b64, expiry_s, sig = parts
    elif len(parts) == 5:
        email_b64, pat_b64, user_b64, expiry_s, sig = parts
        name_b64 = ''
    elif len(parts) == 4:
        email_b64, pat_b64, expiry_s, sig = parts
        user_b64 = ''
        name_b64 = ''
    else:
        return None, None, None, None
    if len(parts) == 6:
        payload = f'{email_b64}.{pat_b64}.{user_b64}.{name_b64}.{expiry_s}'
    elif len(parts) == 5:
        payload = f'{email_b64}.{pat_b64}.{user_b64}.{expiry_s}'
    else:
        payload = f'{email_b64}.{pat_b64}.{expiry_s}'
    if not hmac.compare_digest(_sign(payload), sig):
        return None, None, None, None
    try:
        if int(expiry_s) < int(time.time()):
            return None, None, None, None
        email = _b64url_decode(email_b64).decode('utf-8')
        pat = _b64url_decode(pat_b64).decode('utf-8')
        user_id = _b64url_decode(user_b64).decode('utf-8') if user_b64 else ''
        display_name = _b64url_decode(name_b64).decode('utf-8') if name_b64 else ''
        return email, pat, user_id, display_name
    except (ValueError, UnicodeDecodeError):
        return None, None, None, None


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
    """Return (email, pat, user_id, display_name), or (None, None, None, None)."""
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
    url = f'{PLANE_API_BASE}/users/me/'
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
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; font-size: 13px; color: #e6e7ea; background: #0b0d12; border: 1px solid #2b303d; border-radius: 8px; outline: none; }
  input[type=password]:focus { border-color: #3F76FF; }
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
      <label for=\"pat\">Plane PAT</label>
      <input id=\"pat\" name=\"pat\" type=\"password\" placeholder=\"plane_api_…\" autofocus required>
      <button type=\"submit\">Sign in</button>
    </form>
    <div class=\"hint\">
      Get one at <a href=\"https://app.plane.so/profile/settings\" target=\"_blank\" rel=\"noopener\">app.plane.so → Personal Access Tokens</a>.<br>
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
        """Return (email, pat) for the signed-in user, or send 302/401 and return None.

        - If auth is not configured (no SESSION_SECRET), falls back to the global PLANE_API_KEY
          so single-user local-dev still works without logging in.
        - HTML requests get a 302 to /login; API requests get 401 JSON.
        """
        if not auth_enabled():
            return ('__noauth__', PLANE_API_KEY)
        email, pat, user_id, name = _session(self)
        if email and pat and _email_allowed(email):
            # Sliding session: refresh cookie expiry on every authenticated
            # request so active users never get bumped to /login. Cookie is
            # attached automatically by _send_* helpers.
            fresh = make_session_token(email, pat, user_id, name)
            self._renew_cookie = _cookie_header(SESSION_COOKIE, fresh, max_age=SESSION_TTL_SECONDS)
            return (email, pat)
        if path.startswith('/api/'):
            self._send_json({'error': 'unauthenticated'}, 401)
        else:
            _redirect(self, '/login')
        return None

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
        _email, api_key = auth

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
        if path == '/api/me':
            if auth_enabled():
                email, _pat, user_id, display_name = _session(self)
            else:
                email, user_id, display_name = None, None, None
            self._send_json({
                'email': email,
                'user_id': user_id,
                'display_name': display_name,
                'auth_enabled': auth_enabled(),
            })
            return
        if path == '/api/projects':
            try:
                projects = fetch_projects(api_key)
                self._send_json({'projects': projects, 'default_project_id': PLANE_PROJECT_ID})
            except Exception as e:
                self._send_json({'error': str(e)}, 500)
            return
        if path == '/api/data':
            p = data_path_for(pid)
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
                        'state': _refresh_state,
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
                self._send_json({'error': 'no cached data; click Refresh', 'project_id': pid, 'state': _refresh_state}, 404)
            return
        if path == '/api/history':
            hist_path = DATA_DIR / f'{pid}.history.jsonl'
            if hist_path.exists():
                rows = [json.loads(line) for line in hist_path.read_text().splitlines() if line.strip()]
                self._send_json({'history': rows})
            else:
                self._send_json({'history': []})
            return
        if path == '/api/status':
            self._send_json(_refresh_state)
            return
        if path == '/api/work-item-comments':
            qs = urllib.parse.parse_qs(parsed.query)
            item_id = (qs.get('item_id') or [''])[0]
            project_id = pid or PLANE_PROJECT_ID
            if not item_id:
                self._send_json({'error': 'item_id is required'}, 400)
                return
            api_path = f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/work-items/{item_id}/comments/'
            try:
                result = plane_get(api_path, api_key=api_key)
                rows = result.get('results') if isinstance(result, dict) else result
                self._send_json({'comments': rows or []})
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
            if 'application/x-www-form-urlencoded' in ctype:
                pat = (urllib.parse.parse_qs(raw_body).get('pat') or [''])[0].strip()
            elif 'application/json' in ctype:
                try:
                    pat = (json.loads(raw_body) or {}).get('pat', '').strip()
                except Exception:
                    pat = ''
            if not pat:
                _redirect(self, '/login?error=PAT+is+required')
                return
            try:
                info = fetch_plane_user(pat)
            except urllib.error.HTTPError as e:
                code = getattr(e, 'code', 'error')
                _redirect(self, f'/login?error=Plane+rejected+the+PAT+({code})')
                return
            except Exception as e:
                _redirect(self, f'/login?error={urllib.parse.quote(("plane: " + str(e))[:120])}')
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
            session = make_session_token(email, pat, user_id, display_name)
            set_session = _cookie_header(SESSION_COOKIE, session, max_age=SESSION_TTL_SECONDS)
            _redirect(self, '/', set_cookies=[set_session])
            return

        auth = self._require_auth(raw_path)
        if auth is None:
            return
        _email, api_key = auth

        path, pid = self._query_project_id()
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
            api_path = f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/work-items/{item_id}/'
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
            api_path = f'workspaces/{PLANE_WORKSPACE_SLUG}/projects/{project_id}/work-items/{item_id}/comments/'
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
            if _refresh_state['in_progress']:
                self._send_json({'error': 'refresh already in progress', 'state': _refresh_state}, 409)
                return
            with _refresh_lock:
                _refresh_state['in_progress'] = True
                _refresh_state['last_error'] = None
                _refresh_state['pages_fetched'] = 0
                try:
                    data = do_refresh(pid, api_key=api_key)
                    _refresh_state['last_run'] = data['_meta']['last_refreshed_at']
                    self._send_json({'ok': True, 'meta': data['_meta']})
                except Exception as e:
                    _refresh_state['last_error'] = str(e)
                    self._send_json({'error': str(e), 'state': _refresh_state}, 500)
                finally:
                    _refresh_state['in_progress'] = False
            return
        self.send_error(404)

    def log_message(self, format, *args):
        sys.stderr.write(f'[{self.log_date_time_string()}] {format % args}\n')


def main():
    if not PLANE_WORKSPACE_SLUG:
        print('!! PLANE_WORKSPACE_SLUG not set. Find the slug in your Plane URL: app.plane.so/<slug>/...')
        sys.exit(1)
    if not auth_enabled() and not PLANE_API_KEY:
        print('!! No auth and no PLANE_API_KEY. Either set SESSION_SECRET (per-user PAT login)')
        print('   or set PLANE_API_KEY (single-user local dev). See README.md.')
        sys.exit(1)
    print(f'Dashboard server listening on {HOST}:{PORT}', flush=True)
    print(f'  Workspace: {PLANE_WORKSPACE_SLUG}')
    print(f'  Project:   {PLANE_PROJECT_ID}')
    print(f'  Window:    last {WINDOW_DAYS} days')
    if auth_enabled():
        print(f'  Auth:      Plane PAT login (domains: {", ".join(ALLOWED_EMAIL_DOMAINS)})')
    else:
        print('  Auth:      DISABLED — using shared PLANE_API_KEY from .env. Set SESSION_SECRET to require login.')
    print(f'  Open the URL in your browser, then click Refresh.')
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()

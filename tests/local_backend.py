"""Tiny Supabase-compatible backend for end-to-end tests.

Speaks enough of the PostgREST, GoTrue (auth) and Storage HTTP APIs for the real
supabase-js client to drive DeepQr against a local Postgres that has the real
migrations applied. Every request runs in its own transaction as the `anon` or
`authenticated` role with `request.jwt.claims` set, so row-level security,
triggers and SECURITY DEFINER functions behave as they do on Supabase.

    python tests/local_backend.py --port 54321 --dsn "host=/tmp/pg port=5433 dbname=dqtest user=postgres"
"""
import argparse, base64, json, os, re, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
import psycopg
from psycopg.types.json import Jsonb

IDENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
FILES = {}   # storage: (bucket, path) -> (bytes, content_type)

def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()

def make_token(uid, email):
    now = int(time.time())
    hdr = b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    pl = b64url(json.dumps({'sub': uid, 'email': email, 'role': 'authenticated', 'aud': 'authenticated',
                            'exp': now + 3600, 'iat': now}).encode())
    return f'{hdr}.{pl}.' + b64url(b'local-signature')

def read_token(tok):
    try:
        p = tok.split('.')[1]; p += '=' * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception:
        return None

class PgError(Exception):
    def __init__(self, status, body): self.status, self.body = status, body

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    # ---------- plumbing ----------
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
        self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Type')

    def reply(self, status, body=None, ctype='application/json', raw=None):
        data = raw if raw is not None else (b'' if body is None else json.dumps(body, default=str).encode())
        self.send_response(status); self.cors()
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def body_bytes(self):
        # read once and cache: an unread body would corrupt the next keep-alive request
        if not hasattr(self, '_body'):
            n = int(self.headers.get('Content-Length') or 0)
            self._body = self.rfile.read(n) if n else b''
        return self._body

    def body_json(self):
        b = self.body_bytes()
        return json.loads(b) if b else None

    def claims(self):
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            c = read_token(auth[7:])
            if c and c.get('sub'): return c
        return None

    def conn(self):
        return psycopg.connect(self.server.dsn, autocommit=False)

    def run(self, fn):
        claims = self.claims()
        with self.conn() as cx:
            with cx.cursor() as cur:
                cur.execute('set local role ' + ('authenticated' if claims else 'anon'))
                cur.execute("select set_config('request.jwt.claims', %s, true)",
                            (json.dumps(claims or {'role': 'anon'}),))
                try:
                    out = fn(cur)
                    cx.commit()
                    return out
                except psycopg.Error as e:
                    cx.rollback()
                    diag = e.diag
                    code = diag.sqlstate or 'XX000'
                    status = 403 if code == '42501' else 409 if code == '23505' else 400
                    raise PgError(status, {'code': code, 'message': diag.message_primary or str(e),
                                           'details': diag.message_detail, 'hint': diag.message_hint})

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.send_header('Content-Length', '0'); self.end_headers()

    def dispatch(self, method):
        u = urlparse(self.path); q = parse_qs(u.query, keep_blank_values=True)
        if hasattr(self, '_body'): del self._body
        self.body_bytes()
        try:
            if u.path.startswith('/auth/v1/'): return self.auth(method, u.path[9:], q)
            if u.path.startswith('/rest/v1/rpc/'): return self.rpc(u.path[13:])
            if u.path.startswith('/rest/v1/'): return self.table(method, u.path[9:], q)
            if u.path.startswith('/storage/v1/'): return self.storage(method, u.path[12:], q)
            self.reply(404, {'message': 'not found'})
        except PgError as e:
            self.reply(e.status, e.body)
        except Exception as e:  # pragma: no cover
            self.reply(500, {'message': repr(e)})

    do_GET = lambda self: self.dispatch('GET')
    do_POST = lambda self: self.dispatch('POST')
    do_PATCH = lambda self: self.dispatch('PATCH')
    do_PUT = lambda self: self.dispatch('PUT')
    do_DELETE = lambda self: self.dispatch('DELETE')

    # ---------- auth ----------
    def session(self, uid, email):
        tok = make_token(uid, email)
        user = {'id': uid, 'email': email, 'aud': 'authenticated', 'role': 'authenticated',
                'email_confirmed_at': '2026-01-01T00:00:00Z', 'app_metadata': {}, 'user_metadata': {},
                'created_at': '2026-01-01T00:00:00Z'}
        return {'access_token': tok, 'token_type': 'bearer', 'expires_in': 3600,
                'expires_at': int(time.time()) + 3600, 'refresh_token': 'r-' + uid, 'user': user}

    def auth(self, method, path, q):
        with self.conn() as cx, cx.cursor() as cur:
            cur.execute('create table if not exists auth.passwords (id uuid primary key, pw text)')
            if path == 'signup' and method == 'POST':
                b = self.body_json(); email = b['email'].lower()
                cur.execute('select 1 from auth.users where lower(email)=%s', (email,))
                if cur.fetchone():
                    cx.rollback(); return self.reply(422, {'code': 422, 'msg': 'User already registered', 'message': 'User already registered'})
                uid = str(uuid.uuid4())
                cur.execute('insert into auth.users(id,email) values (%s,%s)', (uid, email))
                cur.execute('insert into auth.passwords values (%s,%s)', (uid, b['password']))
                cx.commit(); return self.reply(200, self.session(uid, email))
            if path == 'token' and method == 'POST':
                b = self.body_json(); gt = q.get('grant_type', [''])[0]
                if gt == 'password':
                    cur.execute('select u.id, u.email from auth.users u join auth.passwords p on p.id=u.id where lower(u.email)=%s and p.pw=%s',
                                (b['email'].lower(), b['password']))
                    r = cur.fetchone()
                    if not r: return self.reply(400, {'error': 'invalid_grant', 'error_description': 'Invalid login credentials', 'message': 'Invalid login credentials'})
                    return self.reply(200, self.session(str(r[0]), r[1]))
                if gt == 'refresh_token':
                    uid = b['refresh_token'][2:]
                    cur.execute('select email from auth.users where id=%s', (uid,))
                    r = cur.fetchone()
                    return self.reply(200, self.session(uid, r[0])) if r else self.reply(400, {'message': 'bad refresh'})
            if path == 'user':
                c = self.claims()
                if not c: return self.reply(401, {'message': 'no user'})
                return self.reply(200, self.session(c['sub'], c.get('email'))['user'])
            if path == 'logout':
                return self.reply(204)
        self.reply(404, {'message': 'auth route not supported: ' + path})

    # ---------- PostgREST tables ----------
    def where(self, q, params, alias=''):
        clauses = []
        for k, vals in q.items():
            if k in ('select', 'order', 'limit', 'offset', 'on_conflict', 'columns'): continue
            if not IDENT.match(k): raise PgError(400, {'message': 'bad column ' + k})
            for v in vals:
                op, _, val = v.partition('.')
                neg = False
                if op == 'not': neg = True; op, _, val = val.partition('.')
                if op in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'):
                    sym = {'eq': '=', 'neq': '<>', 'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<=', 'like': 'like', 'ilike': 'ilike'}[op]
                    if op in ('like', 'ilike'):
                        val = val.replace('*', '%')
                        clauses.append(f'{"not " if neg else ""}{alias}"{k}"::text {sym} %s')
                    elif op in ('eq', 'neq'):
                        clauses.append(f'{"not " if neg else ""}{alias}"{k}"::text {sym} %s')
                    else:
                        t = (getattr(self, '_types', {}) or {}).get(k, 'text')
                        clauses.append(f'{"not " if neg else ""}{alias}"{k}" {sym} %s::{t}')
                    params.append(unquote(val))
                elif op == 'is':
                    clauses.append(f'{alias}"{k}" is {"not " if neg else ""}{ {"null": "null", "true": "true", "false": "false"}[val] }')
                elif op == 'in':
                    items = [unquote(x).strip('"') for x in val.strip('()').split(',') if x != '']
                    clauses.append(f'{"not " if neg else ""}{alias}"{k}"::text = any(%s)'); params.append(items)
                else:
                    raise PgError(400, {'message': 'unsupported filter ' + op})
        return (' where ' + ' and '.join(clauses)) if clauses else ''

    def cols(self, q):
        s = q.get('select', ['*'])[0]
        if s == '*' or not s: return '*'
        out = []
        for c in s.split(','):
            c = c.strip()
            if not IDENT.match(c): raise PgError(400, {'message': 'unsupported select ' + c})
            out.append(f'"{c}"')
        return ','.join(out)

    def order(self, q):
        if 'order' not in q: return ''
        parts = []
        for o in q['order'][0].split(','):
            bits = o.split('.'); c = bits[0]
            if not IDENT.match(c): raise PgError(400, {'message': 'bad order'})
            d = 'desc' if 'desc' in bits else 'asc'
            n = ' nulls first' if 'nullsfirst' in bits else ' nulls last' if 'nullslast' in bits else ''
            parts.append(f'"{c}" {d}{n}')
        return ' order by ' + ','.join(parts)

    def pk(self, cur, table):
        cur.execute("""select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
                       where i.indrelid=('public.'||%s)::regclass and i.indisprimary""", (table,))
        return [r[0] for r in cur.fetchall()]

    def table(self, method, table, q):
        if not IDENT.match(table): return self.reply(404, {'message': 'bad table'})
        accept = self.headers.get('Accept', '')
        prefer = self.headers.get('Prefer', '')
        want_obj = 'vnd.pgrst.object' in accept
        body = self.body_json() if method in ('POST', 'PATCH', 'PUT') else None

        def go(cur):
            params = []
            cur.execute("""select attname, format_type(atttypid, atttypmod) from pg_attribute
                           where attrelid = ('public.'||%s)::regclass and attnum > 0 and not attisdropped""", (table,))
            self._types = dict(cur.fetchall())
            if method == 'GET':
                sql = f'select coalesce(json_agg(row_to_json(t)), \'[]\') from (select {self.cols(q)} from public."{table}"{self.where(q, params)}{self.order(q)}'
                if 'limit' in q: sql += f' limit {int(q["limit"][0])}'
                if 'offset' in q: sql += f' offset {int(q["offset"][0])}'
                cur.execute(sql + ') t', params)
                return cur.fetchone()[0]
            if method == 'POST':
                rows = body if isinstance(body, list) else [body]
                keys = sorted({k for r in rows for k in r.keys()})
                for k in keys:
                    if not IDENT.match(k): raise PgError(400, {'message': 'bad column ' + k})
                cl = ','.join(f'"{k}"' for k in keys)
                sql = f'insert into public."{table}" ({cl}) select {cl} from json_populate_recordset(null::public."{table}", %s::json)'
                params.append(json.dumps(rows))
                if 'resolution=merge-duplicates' in prefer or 'resolution=ignore-duplicates' in prefer:
                    conflict = q.get('on_conflict', [None])[0]
                    target = conflict.split(',') if conflict else self.pk(cur, table)
                    if 'ignore' in prefer: sql += f' on conflict ({",".join(chr(34)+c+chr(34) for c in target)}) do nothing'
                    else:
                        upd = ','.join(f'"{k}"=excluded."{k}"' for k in keys if k not in target) or f'"{target[0]}"=excluded."{target[0]}"'
                        sql += f' on conflict ({",".join(chr(34)+c+chr(34) for c in target)}) do update set {upd}'
                if 'return=representation' not in prefer:   # like PostgREST: no RETURNING, so no SELECT policy needed
                    cur.execute(sql, params); return []
                cur.execute(f'with ins as ({sql} returning *) select coalesce(json_agg(row_to_json(ins)), \'[]\') from ins', params)
                return cur.fetchone()[0]
            if method == 'PATCH':
                keys = list(body.keys())
                for k in keys:
                    if not IDENT.match(k): raise PgError(400, {'message': 'bad column ' + k})
                sets = ','.join(f'"{k}"=r."{k}"' for k in keys)
                params.append(json.dumps(body))
                w = self.where(q, params, 't.').replace(' where ', ' and ', 1) if q else ''
                sql = f'update public."{table}" t set {sets} from json_populate_record(null::public."{table}", %s::json) r where true{w}'
                cur.execute(f'with up as ({sql} returning t.*) select coalesce(json_agg(row_to_json(up)), \'[]\') from up', params)
                return cur.fetchone()[0]
            if method == 'DELETE':
                sql = f'delete from public."{table}"{self.where(q, params)}'
                cur.execute(f'with d as ({sql} returning *) select coalesce(json_agg(row_to_json(d)), \'[]\') from d', params)
                return cur.fetchone()[0]
            raise PgError(405, {'message': 'method'})

        rows = self.run(go)
        if method != 'GET' and 'return=representation' not in prefer:
            return self.reply(201 if method == 'POST' else 204)
        if want_obj:
            if len(rows) != 1:
                return self.reply(406, {'code': 'PGRST116', 'message': 'JSON object requested, multiple (or no) rows returned',
                                        'details': f'The result contains {len(rows)} rows'})
            return self.reply(200, rows[0])
        return self.reply(201 if method == 'POST' else 200, rows)

    # ---------- PostgREST RPC ----------
    def rpc(self, fn):
        if not IDENT.match(fn): return self.reply(404, {'message': 'bad function'})
        args = self.body_json() or {}

        def go(cur):
            cur.execute("""select p.oid, coalesce(p.proargnames, '{}'), p.pronargs, p.pronargdefaults, p.proretset,
                                  format_type(p.prorettype, null), array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t)
                           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = %s""", (fn,))
            cands = cur.fetchall()
            if not cands:
                raise PgError(404, {'code': 'PGRST202', 'message': f'Could not find the function public.{fn}'})
            pick = None
            for oid, names, nargs, ndef, retset, rettype, types in cands:
                names = list(names)[:nargs]
                if set(args) <= set(names) and len(args) >= nargs - ndef:
                    pick = (names, types, retset, rettype); break
            if not pick:
                raise PgError(404, {'code': 'PGRST202', 'message': f'Could not find the function public.{fn} with those arguments'})
            names, types, retset, rettype = pick
            parts, params = [], []
            for n, t in zip(names, types):
                if n not in args: continue
                v = args[n]
                if t in ('jsonb', 'json'):
                    params.append(json.dumps(v))
                elif t.endswith('[]'):
                    params.append('{' + ','.join('"' + str(x) + '"' for x in (v or [])) + '}' if v is not None else None)
                else:
                    params.append(None if v is None else (json.dumps(v) if isinstance(v, (dict, list)) else str(v).lower() if isinstance(v, bool) else str(v)))
                parts.append(f'"{n}" => %s::{t}')
            call = f'public."{fn}"({", ".join(parts)})'
            if retset:
                cur.execute(f'select coalesce(json_agg(r), \'[]\') from {call} r', params)
            elif rettype == 'void':
                cur.execute(f'select {call}', params); return None
            else:
                cur.execute(f'select to_json({call})', params)
            return cur.fetchone()[0]

        out = self.run(go)
        if out is None: return self.reply(200, None)
        self.reply(200, out)

    # ---------- storage ----------
    def storage(self, method, path, q):
        c = self.claims()
        m = re.match(r'^object/(sign/|authenticated/|public/)?([^/]+)/?(.*)$', path)
        if not m: return self.reply(404, {'message': 'storage route not supported'})
        kind, bucket, name = m.group(1) or '', m.group(2), unquote(m.group(3))
        if method in ('POST', 'PUT') and kind == '':
            data = self.body_bytes(); ctype = self.headers.get('Content-Type', 'application/octet-stream')
            if ctype.startswith('multipart/form-data'):
                bnd = ctype.split('boundary=')[1].encode()
                part = [p for p in data.split(b'--' + bnd) if b'Content-Disposition' in p and b'filename' in p][0]
                head, _, rest = part.partition(b'\r\n\r\n')
                data = rest.rsplit(b'\r\n', 1)[0]
                mt = re.search(rb'Content-Type: ([^\r\n]+)', head); ctype = mt.group(1).decode() if mt else 'application/octet-stream'
            def go(cur):
                cur.execute('insert into storage.objects(bucket_id, name, owner, metadata) values (%s,%s,%s,%s) returning id',
                            (bucket, name, c['sub'] if c else None, Jsonb({'size': len(data), 'mimetype': ctype})))
                return cur.fetchone()[0]
            oid = self.run(go)
            FILES[(bucket, name)] = (data, ctype)
            return self.reply(200, {'Key': f'{bucket}/{name}', 'Id': str(oid)})
        if method == 'POST' and kind == 'sign/':
            def go(cur):
                cur.execute('select count(*) from storage.objects where bucket_id=%s and name=%s', (bucket, name))
                return cur.fetchone()[0]
            if not self.run(go): return self.reply(400, {'statusCode': '404', 'error': 'not_found', 'message': 'Object not found'})
            tok = b64url(json.dumps({'b': bucket, 'n': name}).encode())
            return self.reply(200, {'signedURL': f'/object/sign/{bucket}/{name}?token={tok}'})
        if method == 'GET' and kind == 'public/':
            f = FILES.get((bucket, name))
            return self.reply(200, raw=f[0], ctype=f[1]) if f else self.reply(404, {'message': 'not found'})
        if method == 'GET' and kind == 'sign/':
            f = FILES.get((bucket, name))
            return self.reply(200, raw=f[0], ctype=f[1]) if f else self.reply(404, {'message': 'not found'})
        if method == 'GET':
            def go(cur):
                cur.execute('select count(*) from storage.objects where bucket_id=%s and name=%s', (bucket, name))
                return cur.fetchone()[0]
            if not self.run(go): return self.reply(404, {'message': 'not found'})
            f = FILES.get((bucket, name), (b'', 'application/octet-stream'))
            return self.reply(200, raw=f[0], ctype=f[1])
        if method == 'DELETE':
            b = self.body_json() or {}
            names = b.get('prefixes') or ([name] if name else [])
            def go(cur):
                cur.execute('delete from storage.objects where bucket_id=%s and name = any(%s) returning name', (bucket, names))
                return [r[0] for r in cur.fetchall()]
            gone = self.run(go)
            for n in gone: FILES.pop((bucket, n), None)
            return self.reply(200, [{'name': n} for n in gone])
        self.reply(404, {'message': 'storage route not supported'})

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=54321)
    ap.add_argument('--dsn', default='host=/tmp/pg port=5433 dbname=dqtest user=postgres')
    a = ap.parse_args()
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), Handler); srv.dsn = a.dsn
    print(f'local backend on http://127.0.0.1:{a.port}', flush=True)
    srv.serve_forever()

"""Shared browser-test harness: static server, library routing, helpers."""
import http.server, socketserver, threading, sys, os, functools, subprocess, time, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'node_modules')
SHOTS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'tests', 'screens')
API = os.environ.get('DQ_API', 'http://127.0.0.1:54321')
PSQL = ['psql', '-h', '/tmp/pg', '-p', '5433', '-U', 'postgres', '-d', 'dqtest', '-Atq', '-c']
os.makedirs(SHOTS, exist_ok=True)

results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), info))
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  -> {info}'), flush=True)
def sql(q):
    return subprocess.run(PSQL + [q], capture_output=True, text=True, check=True).stdout.strip()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://localhost:{port}/index.html'   # "localhost" is a secure context, so the camera works

CONFIG = f"window.DQ_CONFIG={{supabaseUrl:'{API}',supabaseKey:'anon-key',docsBucket:'dq-docs',version:'test'}};"
LIBMAP = {
    'supabase.js': os.path.join(LIBS, '@supabase/supabase-js/dist/umd/supabase.js'),
    'JsBarcode.all.min.js': os.path.join(LIBS, 'jsbarcode/dist/JsBarcode.all.min.js'),
    'html5-qrcode.min.js': os.path.join(LIBS, 'html5-qrcode/html5-qrcode.min.js'),
    'qrcode.js': os.path.join(LIBS, 'qrcode-generator/qrcode.js'),
    'exceljs.min.js': os.path.join(LIBS, 'exceljs/dist/exceljs.min.js'),
    'leaflet.min.js': os.path.join(LIBS, 'leaflet/dist/leaflet.js'),
    'leaflet.min.css': os.path.join(LIBS, 'leaflet/dist/leaflet.css'),
}
def route(r):
    url = r.request.url
    if '/js/config.js' in url:
        return r.fulfill(body=CONFIG, content_type='application/javascript')
    if url.startswith(f'http://localhost:{port}') or url.startswith(API):
        return r.continue_()
    for k, path in LIBMAP.items():
        if url.split('?')[0].endswith(k):
            if not os.path.exists(path): return r.abort()
            return r.fulfill(path=path, content_type='text/css' if k.endswith('.css') else 'application/javascript')
    if 'fonts.g' in url:
        return r.fulfill(body='', content_type='text/css')
    return r.abort()

errors = []
def new_page(browser, w=1360, h=900, **ctx_opts):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, **ctx_opts)
    ctx.route('**/*', route)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    return pg

def login(pg, user, pw='secret1'):
    pg.goto(BASE)
    pg.wait_for_selector('#loginForm')
    pg.fill('#lu', user); pg.fill('#lp', pw); pg.click('#loginForm button.primary')
    pg.wait_for_selector('.app .side', timeout=15000)
    pg.wait_for_timeout(400)

def goto(pg, view, tab=None):
    pg.evaluate(f"go('{view}'{', {tab:' + repr(tab) + '}' if tab else ''})")
    pg.wait_for_timeout(500)

def toast_text(pg):
    return pg.inner_text('#toast') if pg.is_visible('#toast') else ''

def shot(pg, name):
    pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=False)

def scan_keys(pg, text, delay=8):
    """type like a keyboard-wedge scanner: fast keystrokes then Enter"""
    pg.keyboard.type(text, delay=delay)
    pg.keyboard.press('Enter')
    pg.wait_for_timeout(900)

def cart_serials(pg):
    return pg.eval_on_selector_all('#cartCard .serialChip', 'els => els.map(e => e.textContent.replace("×","").trim())')


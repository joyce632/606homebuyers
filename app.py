"""606 Home Buyers — disposition site.

Public pages list deals for buyers; the team signs in at /team to post deals,
upload photos, change status and manage users.

Flask backend serving a single-page frontend from ./static.
Run locally:  python app.py      Production:  gunicorn -w 1 --threads 8 app:app
Data lives in Postgres when DATABASE_URL is set (Render), otherwise in a local SQLite file.
Photos live in DATA_DIR/uploads (a persistent disk on Render).
"""
import html
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import timedelta
from functools import wraps

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory, session
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

try:  # iPhone photos (HEIC)
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:  # pragma: no cover
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "dispo.db")
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
if USE_PG:
    import psycopg
    from psycopg.rows import dict_row
os.makedirs(UPLOAD_DIR, exist_ok=True)

Image.MAX_IMAGE_PIXELS = 80_000_000


def _secret_key():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(DATA_DIR, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    MAX_CONTENT_LENGTH=30 * 1024 * 1024,
)

# ---------------------------------------------------------------- database


class DB:
    """Tiny wrapper so the same SQL (with ? placeholders) runs on SQLite and Postgres."""

    def __init__(self):
        if USE_PG:
            self.conn = psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=10)
        else:
            self.conn = sqlite3.connect(DB_PATH, timeout=15)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA journal_mode=WAL")

    def execute(self, sql, args=()):
        if USE_PG:
            sql = sql.replace("?", "%s")
        return self.conn.execute(sql, args)

    def all(self, sql, args=()):
        return [dict(r) for r in self.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        r = self.execute(sql, args).fetchone()
        return dict(r) if r else None

    def commit(self):
        self.conn.commit()

    def close(self):
        try:
            self.conn.rollback()
        except Exception:
            pass
        self.conn.close()


def db():
    if "db" not in g:
        g.db = DB()
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        pw_hash TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        last_login BIGINT
    )""",
    """CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        photos TEXT NOT NULL DEFAULT '[]',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        created_by TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    # Buyer questions and offers sent from a deal page.
    """CREATE TABLE IF NOT EXISTS inquiries (
        id TEXT PRIMARY KEY,
        deal_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        offer BIGINT,
        message TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        created_at BIGINT NOT NULL
    )""",
    # Buyers list sign-ups with their buy box.
    """CREATE TABLE IF NOT EXISTS buyers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        data TEXT NOT NULL,
        created_at BIGINT NOT NULL
    )""",
]


def now_ms():
    return int(time.time() * 1000)


def hash_pw(pw):
    return generate_password_hash(pw, method="pbkdf2:sha256:600000")


def temp_password():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(14))


def init_db():
    d = DB()
    try:
        for stmt in SCHEMA:
            d.execute(stmt)
        d.commit()
        if not d.one("SELECT id FROM users LIMIT 1"):
            email = os.environ.get("ADMIN_EMAIL", "admin@606homebuyers.com").strip().lower()
            pw = temp_password()
            d.execute(
                "INSERT INTO users (id, email, name, role, pw_hash, must_change, active, created_at) VALUES (?,?,?,?,?,1,1,?)",
                (uuid.uuid4().hex, email, "Admin", "admin", hash_pw(pw), now_ms()),
            )
            d.commit()
            with open(os.path.join(DATA_DIR, "FIRST_LOGIN.txt"), "w") as f:
                f.write(f"Sign in at /team\nEmail: {email}\nTemporary password: {pw}\n"
                        "You will be asked to set your own password. Delete this file afterwards.\n")
            print(f"[606] Created first admin {email}. Temporary password saved to {DATA_DIR}/FIRST_LOGIN.txt", flush=True)
    finally:
        d.close()


# ---------------------------------------------------------------- deal fields

STATUSES = ("draft", "active", "pending", "sold", "closed")  # draft: team only, never public
ROLES = ("admin", "editor")
TEXT_FIELDS = {
    "address": 200, "city": 80, "zip": 10, "area": 80, "county": 60, "lot": 60, "type": 40,
    "occupancy": 40, "closeBy": 10, "description": 8000, "highlights": 3000,
    "strategy": 40, "condition": 40, "parking": 60,
}
STRATEGIES = ("flip", "rental", "wholesale")
COMP_STATUSES = ("sold", "active", "pending")
NUM_FIELDS = ("beds", "baths", "sqft", "year", "units", "price", "arv", "repairs", "rent", "emd")
# Team-only: never sent to the public site.
PRIVATE_TEXT = {"access": 300, "internalNotes": 5000, "sellerName": 120, "sellerPhone": 40}
PRIVATE_NUM = ("contractPrice",)
PHOTO_RE = re.compile(r"^[a-f0-9]{32}$")


def clean_deal(body, draft=False):
    out = {}
    for k, n in {**TEXT_FIELDS, **PRIVATE_TEXT}.items():
        v = body.get(k)
        v = str(v).strip()[:n] if v not in (None, "") else None
        out[k] = v
    for k in NUM_FIELDS + PRIVATE_NUM:
        v = body.get(k)
        if v in (None, ""):
            out[k] = None
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            abort(400, f"{k} must be a number")
        if f < 0 or f > 1e10:
            abort(400, f"{k} is out of range")
        out[k] = int(f) if f.is_integer() else round(f, 2)
    if out["closeBy"] and not re.match(r"^\d{4}-\d{2}-\d{2}$", out["closeBy"]):
        out["closeBy"] = None
    if out["strategy"] not in STRATEGIES:
        out["strategy"] = None
    out["comps"] = clean_comps(body.get("comps"))
    if not out["address"] and not draft:
        abort(400, "Add a street address before publishing. You can save it as a draft without one.")
    return out


def _num(v, hi=1e10):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f < 0 or f > hi:
        return None
    return int(f) if f.is_integer() else round(f, 2)


def clean_comps(comps):
    """Comparable sales shown on the deal page: at most 12 rows of plain fields."""
    if not isinstance(comps, list):
        return []
    out = []
    for c in comps[:12]:
        if not isinstance(c, dict):
            continue
        address = str(c.get("address") or "").strip()[:120]
        price = _num(c.get("price"))
        if not address or price is None:
            continue
        status = c.get("status") if c.get("status") in COMP_STATUSES else "sold"
        out.append({"address": address, "status": status, "price": price,
                    "beds": _num(c.get("beds"), 100), "baths": _num(c.get("baths"), 100),
                    "sqft": _num(c.get("sqft"), 1e6), "distance": _num(c.get("distance"), 100),
                    "date": str(c.get("date") or "").strip()[:20] or None})
    return out


def deal_out(row, private=False):
    data = json.loads(row["data"])
    if not private:
        for k in list(PRIVATE_TEXT) + list(PRIVATE_NUM):
            data.pop(k, None)
    data.update(id=row["id"], status=row["status"], photos=json.loads(row["photos"]),
                createdAt=row["created_at"], updatedAt=row["updated_at"])
    return data


# ---------------------------------------------------------------- auth

_login_attempts = {}
_login_lock = threading.Lock()


def _rate_limited(key):
    t = time.time()
    with _login_lock:
        hits = [x for x in _login_attempts.get(key, []) if t - x < 900]
        _login_attempts[key] = hits
        return len(hits) >= 10


def _record_fail(key):
    with _login_lock:
        _login_attempts.setdefault(key, []).append(time.time())


def current_user():
    if "user" in g:
        return g.user
    uid = session.get("uid")
    u = None
    if uid:
        u = db().one("SELECT id, email, name, role, must_change, active FROM users WHERE id=?", (uid,))
        if u and not u["active"]:
            u = None
    g.user = u
    return u


def require(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                abort(401, "Sign in to continue.")
            if request.method not in ("GET", "HEAD"):
                if request.headers.get("X-CSRF-Token") != session.get("csrf"):
                    abort(403, "Your session expired. Reload the page and try again.")
            if u["must_change"] and fn.__name__ not in ("change_password", "me", "logout"):
                abort(403, "Set a new password first.")
            if role == "admin" and u["role"] != "admin":
                abort(403, "Only admins can do this.")
            return fn(*a, **kw)
        return wrapper
    return deco


def user_out(u):
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"],
            "mustChange": bool(u["must_change"]), "active": bool(u.get("active", 1)),
            "createdAt": u.get("created_at"), "lastLogin": u.get("last_login")}


@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(413)
def _err(e):
    if request.path.startswith("/api/"):
        msg = e.description if e.code != 413 else "That file is too large (30 MB max)."
        return jsonify(error=msg), e.code
    if e.code == 404 and request.method == "GET" and not request.path.startswith(("/static/", "/photos/")):
        return send_index()
    return e


@app.post("/api/login")
def login():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email", "")).strip().lower()
    pw = str(body.get("password", ""))
    key = (request.remote_addr or "") + "|" + email
    if _rate_limited(key):
        return jsonify(error="Too many attempts. Wait 15 minutes and try again."), 429
    u = db().one("SELECT * FROM users WHERE email=?", (email,))
    if not u or not u["active"] or not check_password_hash(u["pw_hash"], pw):
        _record_fail(key)
        return jsonify(error="That email and password don't match."), 401
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    session["csrf"] = secrets.token_urlsafe(24)
    db().execute("UPDATE users SET last_login=? WHERE id=?", (now_ms(), u["id"]))
    db().commit()
    return jsonify(user=user_out(u), csrf=session["csrf"])


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    u = current_user()
    if not u:
        return jsonify(user=None)
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(24)
    return jsonify(user=user_out(u), csrf=session["csrf"])


@app.post("/api/password")
@require()
def change_password():
    body = request.get_json(silent=True) or {}
    new = str(body.get("new", ""))
    row = db().one("SELECT pw_hash FROM users WHERE id=?", (g.user["id"],))
    if not check_password_hash(row["pw_hash"], str(body.get("current", ""))):
        abort(400, "Your current password is wrong.")
    if len(new) < 10:
        abort(400, "Use at least 10 characters.")
    db().execute("UPDATE users SET pw_hash=?, must_change=0 WHERE id=?", (hash_pw(new), g.user["id"]))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- users (admin)


@app.get("/api/users")
@require("admin")
def list_users():
    rows = db().all("SELECT * FROM users ORDER BY created_at")
    return jsonify(users=[user_out(r) for r in rows])


@app.post("/api/users")
@require("admin")
def create_user():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email", "")).strip().lower()
    name = str(body.get("name", "")).strip()[:80]
    role = body.get("role", "editor")
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        abort(400, "Enter a valid email.")
    if not name:
        abort(400, "Enter a name.")
    if role not in ROLES:
        abort(400, "Pick a role.")
    if db().one("SELECT id FROM users WHERE email=?", (email,)):
        abort(400, "Someone with this email already has an account.")
    pw = temp_password()
    uid = uuid.uuid4().hex
    db().execute(
        "INSERT INTO users (id, email, name, role, pw_hash, must_change, active, created_at) VALUES (?,?,?,?,?,1,1,?)",
        (uid, email, name, role, hash_pw(pw), now_ms()))
    db().commit()
    u = db().one("SELECT * FROM users WHERE id=?", (uid,))
    return jsonify(user=user_out(u), tempPassword=pw)


def _admins_left(excluding):
    r = db().one("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id<>?", (excluding,))
    return r["n"]


@app.patch("/api/users/<uid>")
@require("admin")
def update_user(uid):
    u = db().one("SELECT * FROM users WHERE id=?", (uid,)) or abort(404, "User not found.")
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", u["name"])).strip()[:80] or u["name"]
    role = body.get("role", u["role"])
    active = 1 if body.get("active", bool(u["active"])) else 0
    if role not in ROLES:
        abort(400, "Pick a role.")
    if u["role"] == "admin" and (role != "admin" or not active) and _admins_left(uid) == 0:
        abort(400, "Keep at least one active admin.")
    db().execute("UPDATE users SET name=?, role=?, active=? WHERE id=?", (name, role, active, uid))
    db().commit()
    return jsonify(user=user_out(db().one("SELECT * FROM users WHERE id=?", (uid,))))


@app.post("/api/users/<uid>/reset")
@require("admin")
def reset_user(uid):
    db().one("SELECT id FROM users WHERE id=?", (uid,)) or abort(404, "User not found.")
    pw = temp_password()
    db().execute("UPDATE users SET pw_hash=?, must_change=1 WHERE id=?", (hash_pw(pw), uid))
    db().commit()
    return jsonify(tempPassword=pw)


@app.delete("/api/users/<uid>")
@require("admin")
def delete_user(uid):
    if uid == g.user["id"]:
        abort(400, "You can't remove your own account.")
    u = db().one("SELECT * FROM users WHERE id=?", (uid,)) or abort(404, "User not found.")
    if u["role"] == "admin" and _admins_left(uid) == 0:
        abort(400, "Keep at least one active admin.")
    db().execute("DELETE FROM users WHERE id=?", (uid,))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- deals


@app.get("/api/deals")
def list_deals():
    private = bool(current_user())
    rows = db().all("SELECT * FROM deals ORDER BY created_at DESC")
    return jsonify(deals=[deal_out(r, private) for r in rows if private or r["status"] != "draft"])


@app.get("/api/deals/<did>")
def get_deal(did):
    r = db().one("SELECT * FROM deals WHERE id=?", (did,))
    if not r or (r["status"] == "draft" and not current_user()):
        abort(404, "Deal not found.")
    return jsonify(deal=deal_out(r, bool(current_user())))


def _clean_photos(body):
    photos = body.get("photos") or []
    if not isinstance(photos, list):
        abort(400, "photos must be a list")
    out = []
    for p in photos[:60]:
        if isinstance(p, str) and PHOTO_RE.match(p) and os.path.exists(photo_path(p)) and p not in out:
            out.append(p)
    return out


def _status(body):
    s = body.get("status", "active")
    if s not in STATUSES:
        abort(400, "Pick a status.")
    return s


@app.post("/api/deals")
@require()
def create_deal():
    body = request.get_json(silent=True) or {}
    did = uuid.uuid4().hex[:12]
    t = now_ms()
    status = _status(body)
    db().execute(
        "INSERT INTO deals (id, status, data, photos, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?)",
        (did, status, json.dumps(clean_deal(body, status == "draft")), json.dumps(_clean_photos(body)), t, t, g.user["id"]))
    db().commit()
    return jsonify(deal=deal_out(db().one("SELECT * FROM deals WHERE id=?", (did,)), True))


@app.put("/api/deals/<did>")
@require()
def update_deal(did):
    old = db().one("SELECT * FROM deals WHERE id=?", (did,)) or abort(404, "Deal not found.")
    body = request.get_json(silent=True) or {}
    photos = _clean_photos(body)
    status = _status(body)
    # A draft's listing clock starts when it is first published.
    if old["status"] == "draft" and status != "draft":
        db().execute("UPDATE deals SET created_at=? WHERE id=?", (now_ms(), did))
    db().execute("UPDATE deals SET status=?, data=?, photos=?, updated_at=? WHERE id=?",
                 (status, json.dumps(clean_deal(body, status == "draft")), json.dumps(photos), now_ms(), did))
    db().commit()
    for p in set(json.loads(old["photos"])) - set(photos):
        remove_photo_if_unused(p)
    return jsonify(deal=deal_out(db().one("SELECT * FROM deals WHERE id=?", (did,)), True))


@app.patch("/api/deals/<did>/status")
@require()
def set_status(did):
    old = db().one("SELECT * FROM deals WHERE id=?", (did,)) or abort(404, "Deal not found.")
    body = request.get_json(silent=True) or {}
    status = _status(body)
    if status != "draft" and not json.loads(old["data"]).get("address"):
        abort(400, "Add a street address before publishing this draft.")
    if old["status"] == "draft" and status != "draft":
        db().execute("UPDATE deals SET created_at=? WHERE id=?", (now_ms(), did))
    db().execute("UPDATE deals SET status=?, updated_at=? WHERE id=?", (status, now_ms(), did))
    db().commit()
    return jsonify(deal=deal_out(db().one("SELECT * FROM deals WHERE id=?", (did,)), True))


@app.delete("/api/deals/<did>")
@require()
def delete_deal(did):
    old = db().one("SELECT * FROM deals WHERE id=?", (did,)) or abort(404, "Deal not found.")
    db().execute("DELETE FROM deals WHERE id=?", (did,))
    db().commit()
    for p in json.loads(old["photos"]):
        remove_photo_if_unused(p)
    return jsonify(ok=True)


# ---------------------------------------------------------------- photos


def photo_path(pid, thumb=False):
    return os.path.join(UPLOAD_DIR, pid + ("_t" if thumb else "") + ".jpg")


def remove_photo_if_unused(pid):
    if not PHOTO_RE.match(pid):
        return
    if db().one("SELECT id FROM deals WHERE photos LIKE ?", ("%" + pid + "%",)):
        return
    for thumb in (False, True):
        try:
            os.remove(photo_path(pid, thumb))
        except FileNotFoundError:
            pass


@app.post("/api/photos")
@require()
def upload_photo():
    f = request.files.get("file")
    if not f:
        abort(400, "No file was sent.")
    try:
        img = Image.open(f.stream)
        img = ImageOps.exif_transpose(img)  # also drops EXIF (GPS etc.) on save
        img = img.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        abort(400, "That file isn't a photo we can read. Use JPG, PNG, WebP or HEIC.")
    pid = uuid.uuid4().hex
    full = img.copy()
    full.thumbnail((2000, 2000), Image.LANCZOS)
    full.save(photo_path(pid), "JPEG", quality=85, optimize=True, progressive=True)
    img.thumbnail((800, 800), Image.LANCZOS)
    img.save(photo_path(pid, True), "JPEG", quality=80, optimize=True, progressive=True)
    return jsonify(id=pid)


@app.delete("/api/photos/<pid>")
@require()
def delete_photo(pid):
    remove_photo_if_unused(pid)
    return jsonify(ok=True)


@app.get("/photos/<name>")
def serve_photo(name):
    if not re.match(r"^[a-f0-9]{32}(_t)?\.jpg$", name):
        abort(404)
    resp = send_from_directory(UPLOAD_DIR, name, max_age=31536000)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


# ---------------------------------------------------------------- buyer inquiries & buyers list

_public_posts = {}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _public_guard():
    """Spam checks for the two public forms: same-site origin, honeypot field, per-IP rate limit."""
    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") != request.url_root.rstrip("/"):
        abort(403, "Send the form from the 606 Home Buyers site.")
    body = request.get_json(silent=True) or {}
    if body.get("website"):  # hidden field real people never fill in
        abort(400, "Something went wrong. Try again.")
    key = request.remote_addr or ""
    t = time.time()
    with _login_lock:
        hits = [x for x in _public_posts.get(key, []) if t - x < 600]
        if len(hits) >= 8:
            abort(429, "You've sent several messages. Wait a few minutes and try again.")
        hits.append(t)
        _public_posts[key] = hits
    return body


def _contact_fields(body):
    name = str(body.get("name") or "").strip()[:100]
    email = str(body.get("email") or "").strip().lower()[:160]
    phone = str(body.get("phone") or "").strip()[:40]
    if not name:
        abort(400, "Enter your name.")
    if email and not EMAIL_RE.match(email):
        abort(400, "Check your email address.")
    if not email and len(re.sub(r"\D", "", phone)) < 10:
        abort(400, "Add a phone number or email so we can reach you.")
    return name, email or None, phone or None


@app.errorhandler(429)
def _err429(e):
    return jsonify(error=e.description), 429


@app.post("/api/inquiries")
def create_inquiry():
    body = _public_guard()
    name, email, phone = _contact_fields(body)
    deal_id = str(body.get("dealId") or "")[:20]
    if not db().one("SELECT id FROM deals WHERE id=? AND status<>'draft'", (deal_id,)):
        abort(400, "This deal is no longer listed.")
    kind = "offer" if body.get("kind") == "offer" else "inquiry"
    offer = _num(body.get("offer")) if kind == "offer" else None
    if kind == "offer" and not offer:
        abort(400, "Enter your offer amount.")
    message = str(body.get("message") or "").strip()[:3000] or None
    db().execute("INSERT INTO inquiries (id, deal_id, kind, name, email, phone, offer, message, status, created_at) "
                 "VALUES (?,?,?,?,?,?,?,?,'new',?)",
                 (uuid.uuid4().hex[:12], deal_id, kind, name, email, phone, offer, message, now_ms()))
    db().commit()
    return jsonify(ok=True)


def inquiry_out(r):
    return {"id": r["id"], "dealId": r["deal_id"], "kind": r["kind"], "name": r["name"], "email": r["email"],
            "phone": r["phone"], "offer": r["offer"], "message": r["message"], "status": r["status"],
            "createdAt": r["created_at"]}


@app.get("/api/inquiries")
@require()
def list_inquiries():
    rows = db().all("SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 500")
    return jsonify(inquiries=[inquiry_out(r) for r in rows])


@app.patch("/api/inquiries/<iid>")
@require()
def update_inquiry(iid):
    body = request.get_json(silent=True) or {}
    status = body.get("status")
    if status not in ("new", "contacted", "closed"):
        abort(400, "Pick a status.")
    db().execute("UPDATE inquiries SET status=? WHERE id=?", (status, iid))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/inquiries/<iid>")
@require()
def delete_inquiry(iid):
    db().execute("DELETE FROM inquiries WHERE id=?", (iid,))
    db().commit()
    return jsonify(ok=True)


BUYBOX_TYPES = ("Single family", "2-4 units", "5+ units", "Condo / townhome", "Mixed use", "Vacant land")
BUYBOX_COUNTIES = ("Cook", "DuPage", "Will", "Lake", "Kane", "McHenry", "Kendall")
BUYBOX_FUNDING = ("Cash", "Hard money / private lender", "Conventional loan", "DSCR / rental loan", "Seller financing")


def _picked(value, allowed):
    """Checkbox answers: keep only known options, in the form's order."""
    vals = value if isinstance(value, list) else [value]
    return [a for a in allowed if a in vals]


def _funding_list(b):
    """Older sign-ups stored funding as one lowercase string."""
    f = b.get("funding")
    if isinstance(f, list):
        return f
    legacy = {"cash": "Cash", "hard money": "Hard money / private lender", "conventional": "Conventional loan"}
    return [legacy.get(f, f)] if f else []


@app.post("/api/buyers")
def create_buyer():
    body = _public_guard()
    name, email, phone = _contact_fields(body)
    data = {
        "counties": _picked(body.get("counties"), BUYBOX_COUNTIES),
        "areas": str(body.get("areas") or "").strip()[:500] or None,
        "types": _picked(body.get("types"), BUYBOX_TYPES),
        "maxPrice": _num(body.get("maxPrice")),
        "funding": _picked(body.get("funding"), BUYBOX_FUNDING),
        "notes": str(body.get("notes") or "").strip()[:1000] or None,
    }
    if email:
        old = db().one("SELECT id FROM buyers WHERE email=?", (email,))
        if old:
            db().execute("UPDATE buyers SET name=?, phone=?, data=?, created_at=? WHERE id=?",
                         (name, phone, json.dumps(data), now_ms(), old["id"]))
            db().commit()
            return jsonify(ok=True)
    db().execute("INSERT INTO buyers (id, name, email, phone, data, created_at) VALUES (?,?,?,?,?,?)",
                 (uuid.uuid4().hex[:12], name, email, phone, json.dumps(data), now_ms()))
    db().commit()
    return jsonify(ok=True)


def buyer_out(r):
    out = {"id": r["id"], "name": r["name"], "email": r["email"], "phone": r["phone"], "createdAt": r["created_at"]}
    out.update(json.loads(r["data"]))
    out["funding"] = _funding_list(out)
    out.setdefault("counties", [])
    return out


@app.get("/api/buyers")
@require()
def list_buyers():
    rows = db().all("SELECT * FROM buyers ORDER BY created_at DESC")
    return jsonify(buyers=[buyer_out(r) for r in rows])


@app.delete("/api/buyers/<bid>")
@require()
def delete_buyer(bid):
    db().execute("DELETE FROM buyers WHERE id=?", (bid,))
    db().commit()
    return jsonify(ok=True)


@app.get("/api/buyers.csv")
@require()
def export_buyers():
    import csv
    import io
    from datetime import datetime
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Email", "Phone", "Counties", "Neighborhoods / cities", "Property types", "Max price", "Funding", "Notes", "Signed up"])
    for r in db().all("SELECT * FROM buyers ORDER BY created_at DESC"):
        b = buyer_out(r)
        row = [b["name"], b["email"] or "", b["phone"] or "", "; ".join(b["counties"]), b.get("areas") or "",
               "; ".join(b.get("types") or []), b.get("maxPrice") or "", "; ".join(b["funding"]), b.get("notes") or "",
               datetime.fromtimestamp(b["createdAt"] / 1000).strftime("%Y-%m-%d")]
        # Neutralize spreadsheet formulas typed into public form fields.
        w.writerow(["'" + c if isinstance(c, str) and c[:1] in ("=", "+", "-", "@") else c for c in row])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=606-buyers-list.csv"})


# ---------------------------------------------------------------- settings

SETTING_KEYS = {"phone": 40, "email": 120, "buyersListUrl": 300, "advisorName": 80,
                "dealsClosed": 10, "yearsInBusiness": 10}


def get_settings():
    rows = db().all("SELECT key, value FROM settings")
    s = {k: "" for k in SETTING_KEYS}
    s.update({r["key"]: r["value"] for r in rows if r["key"] in SETTING_KEYS})
    return s


@app.get("/api/settings")
def read_settings():
    return jsonify(settings=get_settings())


@app.put("/api/settings")
@require("admin")
def write_settings():
    body = request.get_json(silent=True) or {}
    for k, n in SETTING_KEYS.items():
        if k in body:
            v = str(body[k] or "").strip()[:n]
            if k == "buyersListUrl" and v and not v.startswith(("https://", "http://")):
                abort(400, "The buyers list link must start with https://")
            if k in ("dealsClosed", "yearsInBusiness") and v and not v.isdigit():
                abort(400, "Use a whole number for deals closed and years in business.")
            db().execute("DELETE FROM settings WHERE key=?", (k,))
            db().execute("INSERT INTO settings (key, value) VALUES (?,?)", (k, v))
    db().commit()
    return jsonify(settings=get_settings())


# ---------------------------------------------------------------- pages

with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as _f:
    INDEX_HTML = _f.read()

DEFAULT_TITLE = "606 Home Buyers | Off-market deals in Chicagoland"
DEFAULT_DESC = "Off-market and wholesale investment properties across Chicago and Illinois, with price, ARV and repair estimates on every deal."


def _money(n):
    return "${:,.0f}".format(n) if isinstance(n, (int, float)) else ""


def send_index(deal=None):
    title, desc, image = DEFAULT_TITLE, DEFAULT_DESC, request.url_root.rstrip("/") + "/static/og.png"
    if deal:
        place = ", ".join(x for x in [deal.get("area"), deal.get("city") or "Chicago"] if x)
        title = f"{deal.get('address') or 'Deal'} · {place} | 606 Home Buyers"
        bits = [deal.get("type"), _money(deal.get("price")) and "Asking " + _money(deal.get("price")),
                deal.get("arv") and "ARV " + _money(deal.get("arv")),
                deal.get("beds") is not None and f"{deal['beds']} bd",
                deal.get("baths") is not None and f"{deal['baths']} ba"]
        desc = " · ".join(str(b) for b in bits if b) or DEFAULT_DESC
        if deal.get("photos"):
            image = request.url_root.rstrip("/") + "/photos/" + deal["photos"][0] + ".jpg"
    page = (INDEX_HTML
            .replace("{{TITLE}}", html.escape(title))
            .replace("{{DESC}}", html.escape(desc))
            .replace("{{IMAGE}}", html.escape(image))
            .replace("{{URL}}", html.escape(request.url)))
    resp = Response(page, mimetype="text/html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
@app.get("/team")
@app.get("/buyers")
def index():
    return send_index()


@app.get("/deal/<did>")
def deal_page(did):
    r = db().one("SELECT * FROM deals WHERE id=?", (did,))
    if r and r["status"] == "draft" and not current_user():
        r = None
    return send_index(deal_out(r) if r else None)


@app.get("/static/<path:name>")
def static_files(name):
    resp = send_from_directory(STATIC_DIR, name, max_age=300)
    return resp


@app.get("/healthz")
def healthz():
    db().one("SELECT 1 AS ok")
    return "ok"


@app.after_request
def _headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
    if request.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5060))
    # Open http://127.0.0.1:<port> — some browsers resolve "localhost" to IPv6, which this server doesn't listen on.
    print(f"[606] Open http://127.0.0.1:{port} in your browser", flush=True)
    app.run(host="127.0.0.1", port=port, debug=False)

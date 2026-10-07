#!/usr/bin/env python3
"""Native messaging host for firefox-post-it: stores notes as Markdown files."""
import datetime
import hashlib
import json
import os
import re
import stat
import struct
import sys
import tempfile
import traceback
import urllib.parse

VERSION = "0.1.0"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.realpath(__file__)), "config.json")

# Firefox drops host->extension messages over 1 MB; keep headroom for framing.
MAX_REPLY = 1024 * 1024 - 1024
MAX_REQUEST = 64 * 1024 * 1024
MAX_BODY = 256 * 1024
MAX_SEGMENT_BYTES = 100
MAX_DEPTH = 32
MAX_ID_TRIES = 1000
CREATE_RETRIES = 3
QUERY_HASH_LEN = 6
SEGMENT_HASH_LEN = 8

EXT = ".md"
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
UNSAFE_RE = re.compile(r'[<>:"\\|?*\x00-\x1f\x7f]')
ID_FORMAT = "%Y-%m-%dT%H-%M-%S"
TS_FORMAT = "%Y-%m-%dT%H:%M:%S"
FIELDS = ("url", "color", "tags", "ignore_query", "created", "updated")
# JSON leaves these unescaped, but YAML treats them as line breaks.
YAML_BREAKS = {"\u0085": "\\u0085", "\u2028": "\\u2028", "\u2029": "\\u2029"}


class HostError(Exception):
    pass


def now():
    return datetime.datetime.now()


def log(msg):
    print(f"postit: {msg}", file=sys.stderr, flush=True)


def short_hash(s, n):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:n]


# --- config -----------------------------------------------------------------

def read_config(config_path):
    """Return the configured root; it is absolute but may not exist."""
    try:
        with open(config_path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        raise HostError(f"config: {e}")

    root = cfg.get("root") if isinstance(cfg, dict) else None
    if not isinstance(root, str) or not os.path.isabs(root):
        raise HostError("config: root must be an absolute path")
    return root


def load_root(config_path):
    root = read_config(config_path)
    if not os.path.isdir(root):
        raise HostError(f"config: root is not a directory: {root}")
    return os.path.realpath(root)


# --- paths ------------------------------------------------------------------

def contained(root, target):
    root = os.path.realpath(root)
    return os.path.commonpath([root, os.path.realpath(target)]) == root


def sanitize_segment(seg):
    # ".git" -> "_git": never create hidden dirs in the vault.
    seg = UNSAFE_RE.sub("_", seg).rstrip(". ")
    if seg.startswith("."):
        seg = "_" + seg[1:]
    if not seg:
        return "_"

    raw = seg.encode("utf-8")
    if len(raw) <= MAX_SEGMENT_BYTES:
        return seg
    head = raw[:MAX_SEGMENT_BYTES - SEGMENT_HASH_LEN - 1].decode("utf-8", "ignore")
    return f"{head}-{short_hash(seg, SEGMENT_HASH_LEN)}"


def url_segments(url, ignore_query=False):
    """https://h/a/b?q=1 -> ["h", "a", "b", "q-<hash>"]"""
    if not isinstance(url, str):
        raise HostError("url must be a string")
    try:
        p = urllib.parse.urlsplit(url)
        host, port = p.hostname, p.port
    except ValueError as e:
        raise HostError(f"invalid url: {e}")
    if p.scheme not in ("http", "https"):
        raise HostError("only http/https URLs are supported")
    if not host:
        raise HostError("url has no host")
    if port:
        host = f"{host}_{port}"

    parts = [s for s in urllib.parse.unquote(p.path).split("/") if s not in ("", ".", "..")]
    segs = [sanitize_segment(host)] + [sanitize_segment(s) for s in parts]
    if len(segs) == 1:
        segs.append("index")

    if len(segs) > MAX_DEPTH:
        rest = "/".join(segs[MAX_DEPTH - 1:])
        segs = segs[:MAX_DEPTH - 1] + [f"d-{short_hash(rest, SEGMENT_HASH_LEN)}"]

    if p.query and not ignore_query:
        pairs = sorted(urllib.parse.parse_qsl(p.query, keep_blank_values=True))
        segs.append(f"q-{short_hash(urllib.parse.urlencode(pairs), QUERY_HASH_LEN)}")
    return segs


def resolve_dir(root, url, ignore_query):
    d = os.path.join(root, *url_segments(url, ignore_query))
    if not contained(root, d):
        raise HostError("path escapes root")
    return d


def check_id(nid):
    if not isinstance(nid, str) or not ID_RE.match(nid):
        raise HostError("invalid id")
    return nid


def find_note(root, url, nid):
    for ignore_query in (False, True):
        path = os.path.join(resolve_dir(root, url, ignore_query), nid + EXT)
        if os.path.isfile(path) and not os.path.islink(path) and contained(root, path):
            return path
    return None


def list_notes(d):
    try:
        entries = list(os.scandir(d))
    except (FileNotFoundError, NotADirectoryError):
        return []
    return sorted(
        e.path for e in entries
        if e.name.endswith(EXT) and ID_RE.match(e.name[:-len(EXT)]) and e.is_file(follow_symlinks=False)
    )


def prune(root, d):
    """Remove empty dirs from d upwards, never root or above."""
    root = os.path.realpath(root)
    d = os.path.realpath(d)
    while d != root and contained(root, d):
        try:
            os.rmdir(d)
        except OSError:
            return
        d = os.path.dirname(d)


# --- note files -------------------------------------------------------------

def dump_value(v):
    s = json.dumps(v, ensure_ascii=False)
    for ch, esc in YAML_BREAKS.items():
        s = s.replace(ch, esc)
    return s


def dump_note(meta, body, extra=()):
    lines = ["---"]
    lines += [f"{k}: {dump_value(meta[k])}" for k in FIELDS if meta.get(k) is not None]
    lines += extra
    lines.append("---")
    return "\n".join(lines) + "\n" + body


def scalar(raw):
    try:
        return json.loads(raw)
    except ValueError:
        pass
    # Obsidian may rewrite values as plain YAML.
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return raw[1:-1].replace("''", "'")
    if raw.startswith("[") and raw.endswith("]"):
        return [scalar(x.strip()) for x in raw[1:-1].split(",") if x.strip()]
    return raw


def parse_note(text):
    """Return (meta, body, extra) where extra keeps unknown frontmatter lines verbatim."""
    meta, extra = {}, []
    lines = text.split("\n")
    if lines[0].rstrip("\r") != "---":
        return meta, text, extra
    end = next((i for i in range(1, len(lines)) if lines[i].rstrip("\r") == "---"), None)
    if end is None:
        return meta, text, extra

    fm = [line.rstrip("\r") for line in lines[1:end]]
    i = 0
    while i < len(fm):
        line = fm[i]
        i += 1

        # YAML block values: indented lines or "- item" lines
        cont = []
        while i < len(fm) and (fm[i][:1] in (" ", "\t") or fm[i].startswith("-")):
            cont.append(fm[i])
            i += 1

        key, sep, raw = line.partition(":")
        if not sep or key not in FIELDS:
            extra += [line] + cont
            continue

        raw = raw.strip()
        if not raw and cont:
            meta[key] = [scalar(c.strip()[1:].strip()) for c in cont if c.strip().startswith("-")]
        else:
            meta[key] = scalar(raw)

    return meta, "\n".join(lines[end + 1:]), extra


def as_str(v, default=""):
    return v if isinstance(v, str) else default


def as_tags(v):
    if isinstance(v, str):
        v = [v]
    return [str(t) for t in v] if isinstance(v, list) else []


def read_note(root, path):
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        mtime = os.fstat(f.fileno()).st_mtime_ns
        text = f.read()
    meta, body, _ = parse_note(text)
    return {
        "id": os.path.basename(path)[:-len(EXT)],
        "rel": os.path.relpath(path, root),
        "url": as_str(meta.get("url")),
        "color": as_str(meta.get("color")),
        "tags": as_tags(meta.get("tags")),
        "ignore_query": meta.get("ignore_query") is True,
        "created": as_str(meta.get("created")),
        "updated": as_str(meta.get("updated")),
        "body": body,
        "mtime": str(mtime),
    }


def write_atomic(path, content):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".postit-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        os.chmod(tmp, stat.S_IMODE(os.stat(path).st_mode))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return os.stat(path).st_mtime_ns


def reserve_write(d, base, content):
    """Create <base>.md, or <base>-2.md, ... if taken."""
    for n in range(1, MAX_ID_TRIES + 1):
        nid = base if n == 1 else f"{base}-{n}"
        path = os.path.join(d, nid + EXT)
        try:
            f = open(path, "x", encoding="utf-8", newline="")
        except FileExistsError:
            continue
        with f:
            f.write(content)
        return nid, path
    raise HostError("could not allocate note id")


def create_note(root, d, meta, body, t):
    content = dump_note(meta, body)
    base = t.strftime(ID_FORMAT)

    # A concurrent prune may remove d between makedirs and open.
    for attempt in range(CREATE_RETRIES):
        try:
            os.makedirs(d, exist_ok=True)
            return reserve_write(d, base, content)
        except FileNotFoundError:
            if attempt == CREATE_RETRIES - 1:
                raise


# --- ops --------------------------------------------------------------------

def op_ping(config_path):
    root = read_config(config_path)
    exists = os.path.isdir(root)
    return {
        "version": VERSION,
        "root": root,
        "exists": exists,
        "writable": exists and os.access(root, os.W_OK),
    }


def op_load(root, msg):
    url = msg.get("url")
    dirs = [(resolve_dir(root, url, False), False)]
    base = resolve_dir(root, url, True)
    if base != dirs[0][0]:
        # notes created with ignore_query live in the query-less dir
        dirs.append((base, True))

    notes, size = [], 0
    for d, only_ignoring in dirs:
        for path in list_notes(d):
            if not contained(root, path):
                continue
            n = read_note(root, path)
            if only_ignoring and not n["ignore_query"]:
                continue
            size += len(json.dumps(n, ensure_ascii=False).encode("utf-8"))
            if size > MAX_REPLY:
                raise HostError("too_large: notes for this page exceed 1 MB")
            notes.append(n)
    return {"notes": notes}


def op_save(root, msg):
    url, note, mtime = msg.get("url"), msg.get("note"), msg.get("mtime")
    if not isinstance(note, dict):
        raise HostError("note must be an object")

    body = note.get("body", "")
    if not isinstance(body, str):
        raise HostError("body must be a string")
    if len(body.encode("utf-8")) > MAX_BODY:
        raise HostError("too_large: note body exceeds limit")

    t = now()
    ts = t.strftime(TS_FORMAT)
    color = note.get("color")
    tags = note.get("tags")

    if note.get("id") is None:
        ignore_query = note.get("ignore_query") is True
        meta = {
            "url": url,
            "color": as_str(color, None),
            "tags": as_tags(tags),
            "ignore_query": True if ignore_query else None,
            "created": ts,
            "updated": ts,
        }
        d = resolve_dir(root, url, ignore_query)
        nid, path = create_note(root, d, meta, body, t)
        return {"id": nid, "rel": os.path.relpath(path, root), "mtime": str(os.stat(path).st_mtime_ns)}

    nid = check_id(note["id"])
    path = find_note(root, url, nid)
    if path is None:
        return {"error": "not_found"}

    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        current = os.fstat(f.fileno()).st_mtime_ns
        text = f.read()
    if mtime is not None and str(mtime) != str(current):
        return {"error": "conflict"}

    old, _, extra = parse_note(text)
    meta = dict(old)
    meta.setdefault("url", url)
    if isinstance(color, str):
        meta["color"] = color
    if tags is not None:
        meta["tags"] = as_tags(tags)
    meta["updated"] = ts

    new_mtime = write_atomic(path, dump_note(meta, body, extra))
    return {"id": nid, "rel": os.path.relpath(path, root), "mtime": str(new_mtime)}


def op_delete(root, msg):
    nid = check_id(msg.get("id"))
    path = find_note(root, msg.get("url"), nid)
    if path is None:
        return {"ok": True}
    os.remove(path)
    prune(root, os.path.dirname(path))
    return {"ok": True}


OPS = {"load": op_load, "save": op_save, "delete": op_delete}


def handle(msg, config_path=CONFIG_PATH):
    try:
        if not isinstance(msg, dict):
            raise HostError("message must be an object")
        op = msg.get("op")
        if op == "ping":
            return op_ping(config_path)
        fn = OPS.get(op)
        if fn is None:
            raise HostError(f"unknown op: {op!r}")
        return fn(load_root(config_path), msg)
    except HostError as e:
        return {"error": str(e)}
    except Exception as e:
        log(traceback.format_exc())
        return {"error": f"{type(e).__name__}: {e}"}


# --- framing ----------------------------------------------------------------

def read_message(stream):
    """Return the decoded message, or None on clean EOF."""
    header = stream.read(4)
    if not header:
        return None
    if len(header) < 4:
        raise EOFError("truncated header")
    (n,) = struct.unpack("=I", header)
    if n > MAX_REQUEST:
        raise HostError("request too large")
    data = stream.read(n)
    if len(data) < n:
        raise EOFError("truncated message")
    return json.loads(data.decode("utf-8"))


def encode_reply(reply):
    data = json.dumps(reply, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_REPLY:
        data = json.dumps({"error": "too_large: reply exceeds 1 MB"}).encode("utf-8")
    return struct.pack("=I", len(data)) + data


def main(config_path=CONFIG_PATH):
    out = sys.stdout.buffer
    inp = sys.stdin.buffer
    # Stray print() must never corrupt the protocol stream.
    sys.stdout = sys.stderr

    while True:
        try:
            msg = read_message(inp)
        except EOFError:
            return
        except HostError as e:
            out.write(encode_reply({"error": str(e)}))
            out.flush()
            return
        except ValueError as e:
            reply = {"error": f"bad json: {e}"}
        else:
            if msg is None:
                return
            reply = handle(msg, config_path)
        out.write(encode_reply(reply))
        out.flush()


if __name__ == "__main__":
    main()

import datetime
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import postit_host as h  # noqa: E402

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "postit_host.py")
FIXED = datetime.datetime(2026, 10, 7, 10, 23, 45)


def frame(msg):
    data = json.dumps(msg).encode()
    return struct.pack("=I", len(data)) + data


def read(path):
    with open(path) as f:
        return f.read()


def unframe_all(data):
    out = []
    while data:
        (n,) = struct.unpack("=I", data[:4])
        out.append(json.loads(data[4:4 + n]))
        data = data[4 + n:]
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(os.path.join(self.tmp.name, "Highlights"))
        os.mkdir(self.root)
        self.config = os.path.join(self.tmp.name, "config.json")
        with open(self.config, "w") as f:
            json.dump({"root": self.root}, f)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, **msg):
        return h.handle(msg, self.config)

    def save(self, url, body="", **note):
        return self.call(op="save", url=url, note={"body": body, **note})


class PathTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(
            h.url_segments("https://github.com/openshift/mco/blob/main/docs/x/"),
            ["github.com", "openshift", "mco", "blob", "main", "docs", "x"],
        )

    def test_index_and_fragment(self):
        self.assertEqual(h.url_segments("https://a.com"), ["a.com", "index"])
        self.assertEqual(h.url_segments("https://a.com/#frag"), ["a.com", "index"])
        self.assertEqual(h.url_segments("https://a.com/p#frag"), ["a.com", "p"])

    def test_encoded_dotdot(self):
        segs = h.url_segments("https://a.com/x/%2e%2e/%2E%2E%2F..%2fetc/passwd")
        self.assertNotIn("..", segs)
        self.assertEqual(segs, ["a.com", "x", "etc", "passwd"])

    def test_non_http(self):
        for url in ("file:///etc/passwd", "javascript:alert(1)", "ftp://a.com/x", "about:blank"):
            with self.assertRaises(h.HostError):
                h.url_segments(url)

    def test_unsafe_chars_and_trailing(self):
        self.assertEqual(h.url_segments('https://a.com/a<b>c:d"e|f*g/name.%20.'), ["a.com", "a_b_c_d_e_f_g", "name"])
        self.assertEqual(h.url_segments("https://a.com/%00x%0A"), ["a.com", "_x_"])
        self.assertEqual(h.url_segments("https://a.com/.git/x"), ["a.com", "_git", "x"])

    def test_long_segment(self):
        segs = h.url_segments("https://a.com/" + "é" * 200)
        self.assertLessEqual(len(segs[1].encode()), h.MAX_SEGMENT_BYTES)
        self.assertRegex(segs[1], r"-[0-9a-f]{8}$")
        self.assertNotEqual(segs[1], h.url_segments("https://a.com/" + "é" * 201)[1])

    def test_depth_cap(self):
        segs = h.url_segments("https://a.com/" + "/".join(["x"] * 100))
        self.assertEqual(len(segs), h.MAX_DEPTH)

    def test_port(self):
        self.assertEqual(h.url_segments("http://localhost:8080/"), ["localhost_8080", "index"])

    def test_query_hash(self):
        a = h.url_segments("https://youtube.com/watch?v=abc&t=1")
        b = h.url_segments("https://youtube.com/watch?t=1&v=abc")
        c = h.url_segments("https://youtube.com/watch?v=def")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertRegex(a[-1], r"^q-[0-9a-f]{6}$")
        self.assertEqual(a[:-1], ["youtube.com", "watch"])
        self.assertEqual(h.url_segments("https://youtube.com/watch?v=abc", True), ["youtube.com", "watch"])


class RootTest(Base):
    def test_prefix_sibling_not_contained(self):
        sibling = self.root + "2"
        os.mkdir(sibling)
        self.assertFalse(h.contained(self.root, os.path.join(sibling, "x.md")))
        self.assertTrue(h.contained(self.root, os.path.join(self.root, "x.md")))

    def test_symlink_escape(self):
        outside = os.path.join(self.tmp.name, "outside")
        os.mkdir(outside)
        os.symlink(outside, os.path.join(self.root, "a.com"))
        res = self.save("https://a.com/x", "hi")
        self.assertIn("error", res)
        self.assertEqual(os.listdir(outside), [])

    def test_prune_stops_at_root(self):
        res = self.save("https://a.com/x/y", "hi")
        self.call(op="delete", url="https://a.com/x/y", id=res["id"])
        self.assertTrue(os.path.isdir(self.root))
        self.assertEqual(os.listdir(self.root), [])

    def test_prune_keeps_nonempty(self):
        self.save("https://a.com/x", "keep")
        res = self.save("https://a.com/x/y", "hi")
        self.call(op="delete", url="https://a.com/x/y", id=res["id"])
        self.assertEqual(len(os.listdir(os.path.join(self.root, "a.com", "x"))), 1)

    def test_prune_direct(self):
        h.prune(self.root, self.root)
        self.assertTrue(os.path.isdir(self.root))
        h.prune(self.root, os.path.dirname(self.root))
        self.assertTrue(os.path.isdir(self.tmp.name))


class ConfigTest(Base):
    def assert_no_write(self, res):
        self.assertIn("error", res)
        self.assertEqual(os.listdir(self.root), [])

    def test_missing(self):
        os.remove(self.config)
        self.assert_no_write(self.save("https://a.com/", "x"))
        self.assertIn("error", self.call(op="ping"))

    def test_invalid_json(self):
        with open(self.config, "w") as f:
            f.write("{nope")
        self.assert_no_write(self.save("https://a.com/", "x"))

    def test_relative_root(self):
        with open(self.config, "w") as f:
            json.dump({"root": "Highlights"}, f)
        self.assert_no_write(self.save("https://a.com/", "x"))

    def test_root_not_dir(self):
        with open(self.config, "w") as f:
            json.dump({"root": os.path.join(self.root, "missing")}, f)
        self.assert_no_write(self.save("https://a.com/", "x"))
        ping = self.call(op="ping")
        self.assertFalse(ping["exists"])

    def test_ping(self):
        res = self.call(op="ping")
        self.assertEqual(res["root"], self.root)
        self.assertTrue(res["exists"])
        self.assertTrue(res["writable"])
        self.assertEqual(res["version"], h.VERSION)


class NoteTest(Base):
    def test_create_path(self):
        with mock.patch.object(h, "now", return_value=FIXED):
            res = self.save("https://github.com/o/r/blob/main/docs/x#L1", "hello", color="pink")
        self.assertEqual(res["id"], "2026-10-07T10-23-45")
        path = os.path.join(self.root, "github.com/o/r/blob/main/docs/x/2026-10-07T10-23-45.md")
        self.assertEqual(res["rel"], os.path.relpath(path, self.root))
        text = read(path)
        self.assertTrue(text.startswith('---\nurl: "https://github.com/o/r/blob/main/docs/x#L1"\ncolor: "pink"\n'))
        self.assertTrue(text.endswith("---\nhello"))

    def test_id_collision(self):
        with mock.patch.object(h, "now", return_value=FIXED):
            a = self.save("https://a.com/", "1")
            b = self.save("https://a.com/", "2")
            c = self.save("https://a.com/", "3")
        self.assertEqual(a["id"], "2026-10-07T10-23-45")
        self.assertEqual(b["id"], "2026-10-07T10-23-45-2")
        self.assertEqual(c["id"], "2026-10-07T10-23-45-3")

    def test_bad_id(self):
        for nid in ("../x", "a/b", "", "a.md", "x y"):
            res = self.call(op="save", url="https://a.com/", note={"id": nid, "body": "x"})
            self.assertIn("error", res)
        self.assertIn("error", self.call(op="delete", url="https://a.com/", id="../../x"))

    def test_frontmatter_roundtrip(self):
        meta = {
            "url": 'https://a.com/x?a=1#frag: "q", y',
            "color": "a: b # c, d",
            "tags": ["x: y", "#hash", "a,b", 'q"uote', "new\nline", "sep\u2028x"],
            "created": "2026-10-07T10:23:45",
        }
        body = "line 1\n---\nkey: value\n"
        text = h.dump_note(meta, body)
        self.assertNotIn("\u2028", text)
        got, got_body, extra = h.parse_note(text)
        self.assertEqual(got, meta)
        self.assertEqual(got_body, body)
        self.assertEqual(extra, [])

    def test_frontmatter_yaml_and_extra(self):
        text = "---\nurl: https://a.com/\ntags:\n  - a\n  - b\naliases: [x]\nfoo:\n  bar: 1\ncolor: 'it''s'\n---\nbody"
        meta, body, extra = h.parse_note(text)
        self.assertEqual(meta, {"url": "https://a.com/", "tags": ["a", "b"], "color": "it's"})
        self.assertEqual(extra, ["aliases: [x]", "foo:", "  bar: 1"])
        self.assertEqual(body, "body")

    def test_update_keeps_extra_and_created(self):
        res = self.save("https://a.com/", "v1")
        path = os.path.join(self.root, res["rel"])
        text = read(path)
        with open(path, "w") as f:
            f.write(text.replace("---\nv1", "aliases: [x]\n---\nv1"))
        mtime = str(os.stat(path).st_mtime_ns)
        res2 = self.call(op="save", url="https://a.com/", note={"id": res["id"], "body": "v2"}, mtime=mtime)
        self.assertNotIn("error", res2)
        meta, body, extra = h.parse_note(read(path))
        self.assertEqual(body, "v2")
        self.assertEqual(extra, ["aliases: [x]"])
        self.assertIn("created", meta)

    def test_conflict(self):
        res = self.save("https://a.com/", "v1")
        path = os.path.join(self.root, res["rel"])
        stale = res["mtime"]
        with open(path, "a") as f:
            f.write(" edited in obsidian")
        os.utime(path, ns=(1, 1))
        res2 = self.call(op="save", url="https://a.com/", note={"id": res["id"], "body": "v2"}, mtime=stale)
        self.assertEqual(res2, {"error": "conflict"})
        self.assertIn("edited in obsidian", read(path))

    def test_save_with_fresh_mtime(self):
        res = self.save("https://a.com/", "v1")
        res2 = self.call(op="save", url="https://a.com/", note={"id": res["id"], "body": "v2"}, mtime=res["mtime"])
        self.assertNotIn("error", res2)
        res3 = self.call(op="save", url="https://a.com/", note={"id": res["id"], "body": "v3"}, mtime=res2["mtime"])
        self.assertNotIn("error", res3)

    def test_not_found(self):
        res = self.call(op="save", url="https://a.com/", note={"id": "nope", "body": "x"})
        self.assertEqual(res, {"error": "not_found"})

    def test_load(self):
        self.save("https://a.com/p", "one")
        self.save("https://a.com/p/sub", "child")
        self.save("https://a.com/other", "other")
        res = self.call(op="load", url="https://a.com/p/#x")
        self.assertEqual([n["body"] for n in res["notes"]], ["one"])
        self.assertTrue(res["notes"][0]["mtime"].isdigit())

    def test_load_query(self):
        self.save("https://y.com/watch?v=1", "v1")
        self.save("https://y.com/watch?v=2", "v2")
        self.save("https://y.com/watch?v=1", "all", ignore_query=True)
        bodies = lambda url: sorted(n["body"] for n in self.call(op="load", url=url)["notes"])  # noqa: E731
        self.assertEqual(bodies("https://y.com/watch?v=1"), ["all", "v1"])
        self.assertEqual(bodies("https://y.com/watch?v=2"), ["all", "v2"])
        self.assertEqual(bodies("https://y.com/watch"), ["all"])

    def test_load_skips_non_notes(self):
        d = os.path.join(self.root, "a.com", "index")
        os.makedirs(d)
        for name in ("readme.txt", "bad name.md", ".hidden.md"):
            open(os.path.join(d, name), "w").close()
        self.assertEqual(self.call(op="load", url="https://a.com/")["notes"], [])

    def test_delete(self):
        res = self.save("https://a.com/", "x")
        self.assertEqual(self.call(op="delete", url="https://a.com/", id=res["id"]), {"ok": True})
        self.assertEqual(os.listdir(self.root), [])


class SizeTest(Base):
    def test_load_cap(self):
        d = os.path.join(self.root, "a.com", "index")
        os.makedirs(d)
        for i in range(3):
            with open(os.path.join(d, f"n{i}.md"), "w") as f:
                f.write("x" * 400_000)
        res = self.call(op="load", url="https://a.com/")
        self.assertTrue(res["error"].startswith("too_large"))
        self.assertLess(len(h.encode_reply(res)), 1024 * 1024)

    def test_body_cap(self):
        res = self.save("https://a.com/", "x" * (2 * 1024 * 1024))
        self.assertTrue(res["error"].startswith("too_large"))
        self.assertEqual(os.listdir(self.root), [])

    def test_encode_reply_cap(self):
        data = h.encode_reply({"body": "x" * (2 * 1024 * 1024)})
        self.assertLess(len(data), 1024 * 1024)
        self.assertIn("error", unframe_all(data)[0])


class FramingTest(Base):
    def run_main(self, stdin_bytes):
        stdin = io.TextIOWrapper(io.BytesIO(stdin_bytes))
        stdout_buf = io.BytesIO()
        stdout = io.TextIOWrapper(stdout_buf)
        saved = sys.stdin, sys.stdout, sys.stderr
        sys.stdin, sys.stdout, sys.stderr = stdin, stdout, io.StringIO()
        try:
            h.main(self.config)
        finally:
            sys.stdin, sys.stdout, sys.stderr = saved
        return stdout_buf.getvalue()

    def test_roundtrip(self):
        out = self.run_main(frame({"op": "ping"}) + frame({"op": "nope"}))
        replies = unframe_all(out)
        self.assertEqual(replies[0]["root"], self.root)
        self.assertIn("error", replies[1])

    def test_stray_print_does_not_corrupt(self):
        real = h.op_ping

        def noisy(cfg):
            print("stray output")
            return real(cfg)

        with mock.patch.object(h, "op_ping", noisy):
            out = self.run_main(frame({"op": "ping"}))
        replies = unframe_all(out)
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["root"], self.root)

    def test_bad_json(self):
        bad = b"{nope"
        out = self.run_main(struct.pack("=I", len(bad)) + bad)
        self.assertIn("error", unframe_all(out)[0])

    def test_subprocess(self):
        env = dict(os.environ)
        proc = subprocess.run(
            [sys.executable, "-c", f"import sys; sys.path.insert(0, {os.path.dirname(HOST)!r}); "
             f"import postit_host as h; h.main({self.config!r})"],
            input=frame({"op": "ping"}), capture_output=True, env=env, check=True,
        )
        replies = unframe_all(proc.stdout)
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["root"], self.root)


if __name__ == "__main__":
    unittest.main()

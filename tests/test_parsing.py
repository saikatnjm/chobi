"""Fast offline tests for the parsers. Run: python3 -m unittest discover -s tests"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import genres  # noqa: E402
import movies  # noqa: E402
import server  # noqa: E402
import subs  # noqa: E402


class TitleParsing(unittest.TestCase):
    def check(self, name, title, year=None, q=None, is_file=False):
        p = movies.parse_name(name, is_file)
        self.assertEqual(p["t"], title, name)
        if year is not None:
            self.assertEqual(p["y"], year, name)
        if q is not None:
            self.assertEqual(p["q"], q, name)
        return p

    def test_folders(self):
        self.check("Ace Ventura-When Nature Calls (1995) 720p [Dual Audio]", "Ace Ventura: When Nature Calls", 1995, "720p")
        self.check("Spider-Man 3 (2007) 720p", "Spider-Man 3", 2007)
        self.check("X-Men-Days of Future Past (2014) 1080p", "X-Men: Days of Future Past", 2014, "1080p")
        self.check("021. Interstellar (2014) 1080p [Dual Audio]", "Interstellar", 2014)
        self.check("(1958) Jalsaghar", "Jalsaghar", 1958)
        self.check("1000 Abaddalu(2013)Telugu", "1000 Abaddalu", 2013)
        p = self.check("Chalo (2018) 720p (Telugu)", "Chalo", 2018)
        self.assertEqual(p["lang"], "Telugu")
        self.assertIn("Dual Audio", movies.parse_name("Heat (1995) 720p [Dual Audio]")["tags"])

    def test_files(self):
        self.check("Heat.1995.BrRip.720p.x264.YIFY.mkv", "Heat", 1995, "720p", is_file=True)

    def test_groups(self):
        self.assertEqual(movies.year_group("(1996)"), (1996, 1996))
        self.assertEqual(movies.year_group("(1995) 1080p & Before"), (0, 1995))
        self.assertEqual(movies.year_group("(1960-1994)"), (1960, 1994))
        self.assertIsNone(movies.year_group("Heat (1995) 720p"))
        self.assertTrue(movies.is_collection("007 James Bond Films Collection (1962-2015) 1080p"))
        self.assertFalse(movies.is_collection("The Collection (2012) 720p"))


class Listings(unittest.TestCase):
    def test_nginx(self):
        page = ('<pre><a href="../">../</a>\n<a href="Heat%20(1995)/">Heat (1995)/</a>   21-Nov-2026 10:10   -\n'
                '<a href="a.mkv">a.mkv</a>   21-Nov-2026 10:11   891223780\n</pre>')
        items = server.parse_autoindex(page, "http://x/m/")
        self.assertEqual([i["href"] for i in items], ["/m/Heat%20%281995%29/", "/m/a.mkv"])
        self.assertEqual(items[1]["size"], 891223780)

    def test_apache(self):
        page = ('<tr><td><a href="/">Parent Directory</a></td></tr><tr><td><a href="b.mp4">b.mp4</a></td>'
                '<td align="right">2026-11-21 10:10</td><td align="right">1.2G</td></tr>')
        items = server.parse_autoindex(page, "http://x/m/")
        self.assertEqual(items[0]["href"], "/m/b.mp4")
        self.assertGreater(items[0]["size"], 10 ** 9)

    def test_norm_path(self):
        self.assertEqual(server.norm_path("/A B/(1995)/"), "/A%20B/%281995%29/")
        self.assertEqual(server.norm_path("/A%20B/"), "/A%20B/")


class Misc(unittest.TestCase):
    def test_norm_matches_js_rules(self):
        self.assertEqual(genres.norm("The Dark.Knight_Rises!"), "the dark knight rises")
        self.assertEqual(genres.norm("Amélie & Co's"), "amelie and cos")

    def test_srt_to_vtt(self):
        self.assertTrue(server.srt_to_vtt("1\n00:00:01,000 --> 00:00:02,500\nHi\n").startswith("WEBVTT"))
        self.assertIn("00:00:01.000", server.srt_to_vtt("1\n00:00:01,000 --> 00:00:02,500\nHi\n"))

    def test_subtitle_cleanup(self):
        srt = ("1\n00:00:01,000 --> 00:00:02,000\n<font color=\"#fff\">Hello</font>\n\n"
               "2\n00:00:03,000 --> 00:00:04,000\nWatch Online Movies and Series for FREE\nwww.osdb.link/lm\n\n"
               "3\n00:00:05,000 --> 00:00:06,000\nBye\n")
        out = subs.clean_srt(srt)
        self.assertIn("Hello", out)
        self.assertNotIn("<font", out)
        self.assertNotIn("osdb", out)
        self.assertIn("Bye", out)
        with self.assertRaises(ValueError):
            subs.download("https://evil.example/x.gz")

    def test_minifiers(self):
        self.assertEqual(server.minify_js("/* c */\n  const a = 1;\n  // note\n  f(a);\n"), "const a = 1;\nf(a);")
        self.assertEqual(server.minify_css("a { color: red; }\n/* x */ b , c { margin: 0 }"), "a{color: red}b,c{margin: 0}")


if __name__ == "__main__":
    unittest.main()

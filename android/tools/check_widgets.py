#!/usr/bin/env python3
"""Static check of the NEOWATCH home-screen widgets (what a launcher really accepts).

Ported from the Sentinel House widget kit (SentinelHouse feat/jarvis-v3,
08-sentinel-home/tests/test_widgets_android.py), same organisation, same owner. Why it exists:
RemoteViews only inflates a CLOSED list of views. A bare <View> (a divider, a veil) gives
"Can't load widget" on the user's phone, never at build time. This reads the sources.

NEOWATCH additions: the strings exist in en / fr / ru with the same format arguments, widget
sentences stay at 12 words or less, no em dash anywhere under android/, and the widget code
never touches a token, a signed proxy link or a forbidden route. Shell guards (review of 09/10/2026):
deep links are checked on the raw authority and rebuilt, the page's own blob: downloads are
saved, and the soft keyboard is followed on phones.

Usage (from the repo root):  python3 -I android/tools/check_widgets.py
Exit code 0 = every check passed.
"""
import re
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID = Path(__file__).resolve().parents[1]
MAIN = ANDROID / "app" / "src" / "main"
RES = MAIN / "res"
JAVA = MAIN / "java"

#: The views RemoteViews can inflate (Android docs, "App widgets: layouts"), as in the kit.
PERMISES = {"FrameLayout", "LinearLayout", "RelativeLayout", "GridLayout", "AnalogClock", "Button",
            "Chronometer", "ImageButton", "ImageView", "ProgressBar", "TextView", "ViewFlipper", "ListView",
            "GridView", "StackView", "AdapterViewFlipper", "ViewStub", "TextClock", "CheckBox", "Switch",
            "RadioButton", "RadioGroup"}

EM_DASH = chr(0x2014)  # spelled by code point, so this file passes its own check
ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


def widget_java():
    return sorted(p for p in JAVA.rglob("Widget*.java"))


def gabarits_de_widgets():
    """Widget layouts: those named by the provider files xml/widget_*.xml, and those the widget
    code draws (R.layout.widget_*)."""
    noms = set()
    for f in (RES / "xml").glob("widget_*.xml"):
        noms |= set(re.findall(r'@layout/([a-z0-9_]+)', f.read_text(encoding="utf-8")))
    for f in widget_java():
        noms |= set(re.findall(r'R\.layout\.(widget_[a-z0-9_]+)', f.read_text(encoding="utf-8")))
    return sorted(noms)


def strings(dossier):
    f = RES / dossier / "strings.xml"
    if not f.exists():
        return {}
    out = {}
    for e in ET.parse(f).getroot().iter("string"):
        out[e.get("name")] = ("".join(e.itertext()), e.get("translatable") != "false")
    return out


class TestWidgets(unittest.TestCase):
    def test_every_widget_layout_uses_only_remoteviews_views(self):
        noms = gabarits_de_widgets()
        self.assertGreaterEqual(len(noms), 5)
        for nom in noms:
            with self.subTest(layout=nom):
                texte = (RES / "layout" / f"{nom}.xml").read_text(encoding="utf-8")
                balises = set(re.findall(r"<([A-Za-z][A-Za-z0-9_.]*)[\s>/]", texte)) - {"?xml"}
                self.assertEqual(balises - PERMISES, set(), f"{nom}: a view RemoteViews refuses")

    def test_every_view_id_the_code_sets_exists_in_the_layout_it_draws(self):
        # A RemoteViews action on a missing id fails at apply time, on the launcher ("Can't load
        # widget"). Every R.id.w_* used by the widget code must exist in at least one widget layout,
        # and the shortcut must not touch row-only ids (w_l_nom / w_l_sous / w_l_suite).
        ids = set()
        for nom in gabarits_de_widgets():
            ids |= set(re.findall(r'@\+id/([a-z0-9_]+)', (RES / "layout" / f"{nom}.xml").read_text(encoding="utf-8")))
        for f in widget_java():
            for i in set(re.findall(r'R\.id\.(w_[a-z0-9_]+)', f.read_text(encoding="utf-8"))):
                with self.subTest(fichier=f.name, id=i):
                    self.assertIn(i, ids)
        raccourci = (JAVA / "co/soclose/neowatch/twa/WidgetChaine.java").read_text(encoding="utf-8")
        chaine_ids = set(re.findall(r'@\+id/([a-z0-9_]+)', (RES / "layout" / "widget_chaine.xml").read_text(encoding="utf-8")))
        for i in set(re.findall(r'R\.id\.(w_[a-z0-9_]+)', raccourci)):
            with self.subTest(shortcut_id=i):
                self.assertIn(i, chaine_ids)
        rendu = (JAVA / "co/soclose/neowatch/twa/WidgetRendu.java").read_text(encoding="utf-8")
        for fn in ("plaque", "etat"):
            corps = re.search(r"static void " + fn + r"\(.*?\n    }\n", rendu, re.S).group(0)
            for i in set(re.findall(r'R\.id\.(w_[a-z0-9_]+)', corps)):
                with self.subTest(shared_fn=fn, id=i):
                    self.assertIn(i, chaine_ids, f"{fn}() is used on widget_chaine too")

    def test_every_preview_and_resource_of_a_provider_exists(self):
        for f in sorted((RES / "xml").glob("widget_*.xml")):
            texte = f.read_text(encoding="utf-8")
            for d in re.findall(r'@drawable/([a-z0-9_]+)', texte):
                with self.subTest(fiche=f.name, drawable=d):
                    self.assertTrue(list(RES.glob(f"drawable*/{d}.*")), f"{f.name}: {d} missing")
            for l in re.findall(r'@layout/([a-z0-9_]+)', texte):
                with self.subTest(fiche=f.name, layout=l):
                    self.assertTrue((RES / "layout" / f"{l}.xml").exists())
            with self.subTest(fiche=f.name, check="period"):
                periode = int(re.search(r'updatePeriodMillis="(\d+)"', texte).group(1))
                self.assertGreaterEqual(periode, 30 * 60 * 1000, "refresh period under 30 min")
            with self.subTest(fiche=f.name, check="configure"):
                m = re.search(r'android:configure="([^"]+)"', texte)
                if m:
                    cls = m.group(1).rsplit(".", 1)[-1]
                    self.assertTrue((JAVA / "co/soclose/neowatch/twa" / f"{cls}.java").exists())

    def test_every_widget_receiver_has_its_provider_file(self):
        manifeste = (MAIN / "AndroidManifest.xml").read_text(encoding="utf-8")
        fiches = set(re.findall(r'android:resource="@xml/(widget_[a-z_]+)"', manifeste))
        self.assertEqual(len(fiches), 3)
        for fiche in fiches:
            with self.subTest(fiche=fiche):
                self.assertTrue((RES / "xml" / f"{fiche}.xml").exists())
        # The tap receiver and the job are never exported.
        root = ET.parse(MAIN / "AndroidManifest.xml").getroot()
        for e in root.iter():
            if e.get(ANDROID_NS + "name") in (".WidgetActions", ".WidgetJob"):
                with self.subTest(component=e.get(ANDROID_NS + "name")):
                    self.assertEqual(e.get(ANDROID_NS + "exported"), "false")

    def test_strings_exist_in_en_fr_ru_with_the_same_arguments(self):
        en, fr, ru = strings("values"), strings("values-fr"), strings("values-ru")
        for nom, (texte, traduisible) in en.items():
            if not traduisible:
                continue
            for langue, d in (("fr", fr), ("ru", ru)):
                with self.subTest(string=nom, langue=langue):
                    self.assertIn(nom, d, f"{nom} missing in values-{langue}")
                    args_en = sorted(re.findall(r"%\d\$[sd]", texte))
                    self.assertEqual(sorted(re.findall(r"%\d\$[sd]", d[nom][0])), args_en)
        for langue, d in (("fr", fr), ("ru", ru)):
            for nom in d:
                with self.subTest(extra=nom, langue=langue):
                    self.assertIn(nom, en, f"{nom} only in values-{langue}")

    def test_widget_sentences_have_12_words_at_most(self):
        for dossier in ("values", "values-fr", "values-ru"):
            for nom, (texte, _) in strings(dossier).items():
                if not nom.startswith("w_"):
                    continue
                for phrase in re.split(r"(?<=[.!?…])\s+", texte.strip()):
                    with self.subTest(dossier=dossier, string=nom):
                        self.assertLessEqual(len(phrase.split()), 12, f"{nom}: {phrase!r}")

    def test_no_em_dash_anywhere_under_android(self):
        for f in list(ANDROID.rglob("*.java")) + list(RES.rglob("*.xml")) + list(ANDROID.rglob("*.md")) \
                + list(ANDROID.rglob("*.py")) + list(ANDROID.rglob("*.gradle")):
            if not f.is_file() or "/build/" in str(f) or "/.gradle/" in str(f):
                continue
            with self.subTest(fichier=str(f.relative_to(ANDROID))):
                self.assertNotIn(EM_DASH, f.read_text(encoding="utf-8"))

    def test_widget_code_never_touches_a_token_a_proxy_link_or_a_forbidden_route(self):
        interdit = re.compile(
            r"Authorization|Bearer|X-Renewed-Token|getCookie|CookieManager|localStorage|jwt|\"token\""
            r"|\"proxyUrl\"|/api/proxy|/api/auth|/api/me\b|/api/admin|/api/billing|/api/checkout|/api/pair"
            r"|/api/tv|/api/link|purchase|checkout", re.I)
        for f in widget_java():
            texte = f.read_text(encoding="utf-8")
            code = "\n".join(l for l in texte.splitlines() if not l.strip().startswith(("*", "/*", "//")))
            code = re.sub(r"//.*", "", code)
            with self.subTest(fichier=f.name):
                trouve = [m.group(0) for m in interdit.finditer(code)]
                self.assertEqual(trouve, [], f"{f.name}: forbidden in widget code")
        # The only API routes the widget code reads, all public:
        routes = set()
        for f in widget_java():
            routes |= set(re.findall(r'"(/api/[a-z/]+)', f.read_text(encoding="utf-8")))
        self.assertEqual(routes, {"/api/catalog/home", "/api/catalog/channel/", "/api/catalog/channels", "/api/epg/now"})


class TestShell(unittest.TestCase):
    """LauncherActivity guards that a refactor could silently drop (no device needed)."""

    @classmethod
    def setUpClass(cls):
        texte = (JAVA / "co" / "soclose" / "neowatch" / "twa" / "LauncherActivity.java").read_text(encoding="utf-8")
        cls.code = re.sub(r"//.*", "", re.sub(r"/\*.*?\*/", "", texte, flags=re.S))

    def test_deep_links_check_the_raw_authority_and_load_the_rebuilt_url(self):
        # An unpatched android.net.Uri (API 23-26) gives getHost() = our host for
        # "https://evil.example\\@neowatch.soclose.co/": never decide on getHost().
        self.assertNotIn(".getHost()", self.code)
        self.assertIn("HOST.equalsIgnoreCase(uri.getEncodedAuthority())", self.code)
        self.assertRegex(self.code, r"static String urlFromIntent\(Intent intent\) \{[^}]*return ownUrl\(intent\.getData\(\), true\);")
        self.assertIn("ownUrl(Uri.parse(saved), false)", self.code)

    def test_the_pages_own_blob_downloads_are_saved_not_dropped(self):
        # openExternally refuses blob: (no other app can read it): the listener must save it first.
        m = re.search(r"setDownloadListener\((.*?)\);\n", self.code, re.S)
        self.assertIsNotNone(m)
        self.assertIn("OWN_BLOB.matcher(url).matches()", m.group(1))
        self.assertIn("saveBlob(", m.group(1))
        self.assertIn("R.string.download_failed", self.code)
        self.assertNotIn("addJavascriptInterface", self.code)

    def test_phones_follow_the_soft_keyboard(self):
        # Under the fullscreen theme adjustResize is ignored (API 23-29).
        self.assertIn("if (!isTv) followKeyboard();", self.code)


    def test_widget_options_keep_unsaved_choices_on_recreation(self):
        # No configChanges on WidgetConfigActivity: a rotation recreates it before Done.
        texte = (JAVA / "co" / "soclose" / "neowatch" / "twa" / "WidgetConfigActivity.java").read_text(encoding="utf-8")
        self.assertIn("protected void onSaveInstanceState(Bundle out)", texte)
        self.assertRegex(texte, r"if \(b != null && b\.getStringArray\(ETAT_IDS\) != null\) \{[^}]*restaurer\(b\);")


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if r.wasSuccessful() else 1)

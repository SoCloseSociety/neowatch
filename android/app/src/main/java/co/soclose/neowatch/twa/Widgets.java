package co.soclose.neowatch.twa;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * NEOWATCH home-screen widgets (v2.1.0): the RULES (pure) and what the phone keeps about them.
 *
 * Adapted from the Sentinel House widget kit (SentinelHouse feat/jarvis-v3,
 * 08-sentinel-home/apps/android: Widgets.java, KIT-WIDGETS.md), same organisation, same owner.
 *
 * Three widgets, all on PUBLIC routes of https://neowatch.soclose.co, never a token:
 *   - "Live now"          GET /api/catalog/home?lang=   (featured[] then the first rail)
 *   - "My channels"       GET /api/catalog/channel/<id>?channelId=, GET /api/epg/now?ids=
 *   - "Channel shortcut"  GET /api/catalog/channel/<id>?channelId=
 *
 * The rules that explain the code (kit, "les regles qui ont coute cher"):
 *   1. An honest state, always: loading, not answering, sign-in needed, off air, not checked,
 *      no guide, no longer listed. A kept read is DATED ("checked 12 min ago") and greyed when old.
 *   2. A widget opens a page, it never acts: no purchase, no pairing approval, no sign-in/out, no
 *      account or admin action. A tap opens /chaine/<id>?play=1 or the home page in the shell.
 *   3. Nothing playable is stored: a stream URL, a signed /api/proxy link, a JWT never reach these
 *      preferences (compact() keeps an allowlist of fields).
 */
final class Widgets {
    private Widgets() {}

    static final String HOST = LauncherActivity.HOST;
    static final String BASE = "https://" + HOST;

    /** The kinds of widget (the key of their cache and of their job). */
    static final String DIRECT = "direct", MES = "mes", CHAINE = "chaine";

    /** How many channels a "My channels" widget keeps (its L size shows them all). */
    static final int MAX_CHOISIES = 8;
    /** How many "Live now" channels are kept from a read (L shows them all). */
    static final int MAX_DIRECT = 8;

    /** Past this age a kept read is STALE (greyed, dated): older than one refresh period. */
    static final long PERIME_MS = 35L * 60_000L;

    // ------------------------------------------------------------------ sizes

    /** Three drawings per widget: S (narrow), M (wide), L (wide and tall). Kit: Widgets.Taille. */
    enum Taille { S, M, L }

    /** Width from which a widget is "wide" (4 cells), and height from which it is also "tall".
     *  HAUT_DP is where 8 channel rows (about 36 dp each) plus the header and footer fit: measured on
     *  an API 34 Pixel emulator, a 3-row widget (about 327 dp) clipped the 8th row, so it stays M. */
    static final int LARGE_DP = 250;
    static final int HAUT_DP = 360;

    static Taille taille(int largeurDp, int hauteurDp) {
        if (largeurDp < LARGE_DP) return Taille.S;
        return hauteurDp >= HAUT_DP ? Taille.L : Taille.M;
    }

    /** Rows shown by size. "My channels": S = 1, M = 4, L = 8 (the owner's spec). */
    static int lignes(String genre, Taille t) {
        if (MES.equals(genre)) return t == Taille.S ? 1 : t == Taille.M ? 4 : 8;
        return t == Taille.L ? 8 : 3;
    }

    // ------------------------------------------------------------------ styles (kit: Widgets.Style)

    enum Style { LUNAIRE, DOUX, VERRE }

    static Style styleDe(String s) {
        if (s == null) return Style.LUNAIRE;
        switch (s.trim().toLowerCase(Locale.ROOT)) {
            case "doux": return Style.DOUX;
            case "verre": return Style.VERRE;
            default: return Style.LUNAIRE;
        }
    }

    static int fondDe(Style s) {
        switch (s == null ? Style.LUNAIRE : s) {
            case DOUX: return R.drawable.w_fond_doux;
            case VERRE: return R.drawable.w_fond_verre;
            default: return R.drawable.w_fond;
        }
    }

    // ------------------------------------------------------------------ ids and URLs

    /** A catalog channel id (index-based base36 today, e.g. "r231mq"): short, url-safe. */
    static boolean idValide(String id) {
        return id != null && id.matches("^[A-Za-z0-9_-]{1,64}$");
    }

    /** An iptv-org tvg-id ("France24.fr", "TF1.fr@SD"): bounded, no space, no quote. */
    static boolean channelIdValide(String cid) {
        return cid != null && cid.matches("^[A-Za-z0-9_.@:+-]{1,200}$");
    }

    /** The only page a channel tap opens: the channel, playing. Null for an id we do not trust. */
    static String urlChaine(String id) {
        if (!idValide(id)) return null;
        return BASE + "/chaine/" + Uri.encode(id) + "?play=1";
    }

    static final String URL_ACCUEIL = BASE + "/";

    /** The UI language sent to /api/catalog/home: the device's, if the site speaks it, else en. */
    static String langue() {
        String l = Locale.getDefault().getLanguage();
        return "fr".equals(l) || "ru".equals(l) ? l : "en";
    }

    // ------------------------------------------------------------------ what a widget may keep

    /**
     * A channel from the API, reduced to what a widget draws. ALLOWLIST: never url, proxyUrl,
     * alternates, userAgent, referrer (a stream or a signed proxy link must never be stored).
     */
    static JSONObject compacter(JSONObject c, String sous) {
        if (c == null) return null;
        String id = texte(c, "id");
        if (!idValide(id)) return null;
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            String cid = texte(c, "channelId");
            o.put("channelId", channelIdValide(cid) ? cid : "");
            o.put("name", borne(texte(c, "name"), 120));
            String logo = texte(c, "logo");
            o.put("logo", WidgetLogos.urlAcceptee(logo) ? logo : "");
            if (c.has("online") && !c.isNull("online")) o.put("online", c.optBoolean("online"));
            if (c.optLong("checkedAt", 0) > 0) o.put("checkedAt", c.optLong("checkedAt"));
            o.put("locked", c.optBoolean("locked", false));
            if (sous != null && !sous.isEmpty()) o.put("sous", borne(sous, 80));
        } catch (Exception e) {
            return null;
        }
        return o;
    }

    /** A string field, "" when absent OR JSON null (optString would return the word "null"). */
    static String texte(JSONObject o, String cle) {
        if (o == null || !o.has(cle) || o.isNull(cle)) return "";
        Object v = o.opt(cle);
        return v instanceof String ? (String) v : "";
    }

    /** Online verdict of a kept channel: TRUE, FALSE, or null (never checked). */
    static Boolean enLigne(JSONObject c) {
        if (c == null || !c.has("online") || c.isNull("online")) return null;
        return c.optBoolean("online");
    }

    static String borne(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    /** Two letters when a logo is missing or cannot be drawn (same rule as web ChannelCard.monogram). */
    static String monogramme(String nom) {
        String[] mots = (nom == null ? "" : nom).replaceAll("[^\\p{L}\\p{N}]+", " ").trim().split("\\s+");
        String a = mots.length > 0 && !mots[0].isEmpty() ? mots[0].substring(0, 1) : "?";
        String b = mots.length > 1 && !mots[1].isEmpty() ? mots[1].substring(0, 1)
                : mots.length > 0 && mots[0].length() > 1 ? mots[0].substring(1, 2) : "";
        return (a + b).toUpperCase(Locale.ROOT);
    }

    // ------------------------------------------------------------------ freshness and age

    static boolean perime(long ageMs) {
        return ageMs < 0 || ageMs > PERIME_MS;
    }

    /** "just now", "12 min ago", "3 h ago", "2 d ago" (the web's fmtAge steps). */
    static String age(Context c, long tsMs, long maintenant) {
        long min = Math.max(0, (maintenant - tsMs) / 60_000L);
        if (min < 1) return c.getString(R.string.w_age_maintenant);
        if (min < 60) return c.getString(R.string.w_age_min, (int) min);
        long h = min / 60;
        if (h < 48) return c.getString(R.string.w_age_h, (int) h);
        return c.getString(R.string.w_age_j, (int) (h / 24));
    }

    // ------------------------------------------------------------------ preferences (never a token)

    private static final String FICHIER = "neowatch_widgets";

    private static SharedPreferences p(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(FICHIER, Context.MODE_PRIVATE);
    }

    static Style style(Context ctx, int id) {
        return styleDe(p(ctx).getString("style_" + id, ""));
    }

    static void poserStyle(Context ctx, int id, Style s) {
        p(ctx).edit().putString("style_" + id, s == null ? "lunaire" : s.name().toLowerCase(Locale.ROOT)).commit();
    }

    /** Logos shown (default) or letters only. */
    static boolean logos(Context ctx, int id) {
        return p(ctx).getBoolean("logos_" + id, true);
    }

    static void poserLogos(Context ctx, int id, boolean oui) {
        p(ctx).edit().putBoolean("logos_" + id, oui).commit();
    }

    /** Has this widget been through its options screen (or does it need none)? */
    static boolean configure(Context ctx, int id) {
        return p(ctx).getBoolean("cfg_" + id, false);
    }

    static void poserConfigure(Context ctx, int id) {
        p(ctx).edit().putBoolean("cfg_" + id, true).commit();
    }

    /** One picked channel: id + channelId + name, nothing else. */
    static final class Choix {
        String id, channelId, nom;

        Choix(String id, String channelId, String nom) {
            this.id = id == null ? "" : id;
            this.channelId = channelId == null ? "" : channelId;
            this.nom = nom == null ? "" : nom;
        }
    }

    /** The channels picked for a widget (bad JSON or bad ids are dropped, never a crash). */
    static List<Choix> choisies(Context ctx, int id) {
        List<Choix> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(p(ctx).getString("choix_" + id, "[]"));
            for (int i = 0; i < a.length() && out.size() < MAX_CHOISIES; i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null || !idValide(o.optString("id"))) continue;
                String cid = o.optString("channelId", "");
                out.add(new Choix(o.optString("id"), channelIdValide(cid) ? cid : "", borne(o.optString("name", ""), 120)));
            }
        } catch (Exception e) {
            // a broken entry reads as "no channel picked": the widget says so
        }
        return out;
    }

    static void poserChoisies(Context ctx, int id, List<Choix> choix) {
        JSONArray a = new JSONArray();
        for (Choix c : choix) {
            if (a.length() >= MAX_CHOISIES || !idValide(c.id)) continue;
            JSONObject o = new JSONObject();
            try {
                o.put("id", c.id);
                o.put("channelId", channelIdValide(c.channelId) ? c.channelId : "");
                o.put("name", borne(c.nom, 120));
            } catch (Exception e) {
                continue;
            }
            a.put(o);
        }
        p(ctx).edit().putString("choix_" + id, a.toString()).commit();
    }

    // The last successful read and its date: per KIND for "Live now" (every such widget shows the
    // same list), per WIDGET for "My channels" and "Channel shortcut" (their own picks).
    static String cleLecture(String genre, int id) {
        return DIRECT.equals(genre) ? genre : genre + "_" + id;
    }

    static String cache(Context ctx, String cle) {
        return p(ctx).getString("cache_" + cle, "");
    }

    static long cacheTs(Context ctx, String cle) {
        return p(ctx).getLong("cache_ts_" + cle, 0L);
    }

    static void poserCache(Context ctx, String cle, String json, long ts) {
        p(ctx).edit().putString("cache_" + cle, json == null ? "" : json).putLong("cache_ts_" + cle, ts).commit();
    }

    /** The state of the last read: "" never, "lecture" running, "ok", "reseau", "refus", "inattendu". */
    static String statut(Context ctx, String cle) {
        return p(ctx).getString("statut_" + cle, "");
    }

    static void poserStatut(Context ctx, String cle, String statut) {
        p(ctx).edit().putString("statut_" + cle, statut == null ? "" : statut).commit();
    }

    static JSONObject objet(String json) {
        try {
            return json == null || json.isEmpty() ? null : new JSONObject(json);
        } catch (Exception e) {
            return null;
        }
    }

    static List<JSONObject> liste(JSONObject o, String cle) {
        List<JSONObject> out = new ArrayList<>();
        JSONArray a = o == null ? null : o.optJSONArray(cle);
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject x = a.optJSONObject(i);
            if (x != null) out.add(x);
        }
        return out;
    }

    /** A widget removed: its picks, options, cache and state leave with it. */
    static void oublier(Context ctx, String genre, int[] ids) {
        SharedPreferences.Editor e = p(ctx).edit();
        for (int id : ids) {
            e.remove("style_" + id).remove("logos_" + id).remove("cfg_" + id).remove("choix_" + id);
            if (!DIRECT.equals(genre)) {
                String cle = cleLecture(genre, id);
                e.remove("cache_" + cle).remove("cache_ts_" + cle).remove("statut_" + cle);
            }
        }
        e.apply();
    }
}

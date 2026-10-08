package co.soclose.neowatch.twa;

import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The reads of a widget: short GETs to the PUBLIC NEOWATCH API, off the main thread.
 *
 * Adapted from the Sentinel House widget kit (LectureMaison.java), same organisation, minus the
 * house key: NEOWATCH widgets only read public routes, so NO token, NO cookie, NO Authorization
 * header ever leaves the phone from here. Same discipline otherwise:
 *   - short delays (3 s connect / 6 s read): a widget that waits is not a widget;
 *   - bodies capped at 512 KB, no redirect followed, no HTTP cache;
 *   - 401 / 403 = REFUS (the site asks for a sign-in), 404 = INTROUVABLE, 5xx = INATTENDU;
 *   - never called on the main thread (refused, logged).
 */
final class WidgetLecture {
    private WidgetLecture() {}

    private static final String TAG = "NeoWatchWidget";
    static final String UA = "NeoWatchWidget/2.1 (Android)";

    enum Sorte { OK, RESEAU, REFUS, INTROUVABLE, INATTENDU }

    static final class Reponse {
        final Sorte sorte;
        final int code;
        final String corps;

        Reponse(Sorte sorte, int code, String corps) {
            this.sorte = sorte;
            this.code = code;
            this.corps = corps == null ? "" : corps;
        }

        boolean ok() { return sorte == Sorte.OK; }

        /** The body as JSON, or an empty object (bad JSON never crashes a widget). */
        JSONObject json() {
            try {
                return corps.isEmpty() ? new JSONObject() : new JSONObject(corps);
            } catch (Exception e) {
                return new JSONObject();
            }
        }

        /** The read state kept for the widget (Widgets.poserStatut). */
        String statut() {
            switch (sorte) {
                case OK: return "ok";
                case REFUS: return "refus";
                case RESEAU: return "reseau";
                default: return "inattendu";
            }
        }
    }

    /** GET <BASE><chemin>. BLOCKING: never on the main thread. */
    static Reponse get(String chemin) {
        if (Looper.getMainLooper().isCurrentThread()) {
            Log.w(TAG, "read refused on the main thread");
            return new Reponse(Sorte.INATTENDU, 0, "");
        }
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(Widgets.BASE + chemin).openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(6000);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", UA);
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String texte = in == null ? "" : lire(in, 512 * 1024);
            if (code == 401 || code == 403) return new Reponse(Sorte.REFUS, code, "");
            if (code == 404) return new Reponse(Sorte.INTROUVABLE, code, "");
            if (code != 200) return new Reponse(Sorte.INATTENDU, code, "");
            return new Reponse(Sorte.OK, code, texte);
        } catch (Exception e) {
            // Only the path and the exception class: nothing else worth logging, nothing secret here.
            Log.w(TAG, "read " + chemin.replaceAll("\\?.*$", "") + " -> " + e.getClass().getSimpleName());
            return new Reponse(Sorte.RESEAU, 0, "");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String lire(InputStream in, int max) throws IOException {
        return new String(lireOctets(in, max), "UTF-8");
    }

    static byte[] lireOctets(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n, total = 0;
        try (InputStream x = in) {
            while ((n = x.read(buf)) > 0) {
                total += n;
                if (total > max) throw new IOException("body too large");
                out.write(buf, 0, n);
            }
        }
        return out.toByteArray();
    }
}

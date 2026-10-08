package co.soclose.neowatch.twa;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Looper;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.Map;

/**
 * Channel logos for the widgets: fetched in the job (never on the main thread), reduced to a
 * small PNG in the app's private files, drawn from there. A logo that cannot be read (an SVG,
 * a dead host, too big) leaves a marker for a day and the widget shows the monogram instead.
 *
 * Bounded like the kit's camera snapshot (LectureMaison.getOctets): https only, 3 s / 6 s,
 * 300 KB at most, 80 px at most once stored (a RemoteViews bitmap travels through Binder).
 */
final class WidgetLogos {
    private WidgetLogos() {}

    private static final String TAG = "NeoWatchWidget";
    private static final int MAX_OCTETS = 300 * 1024;
    private static final int COTE_PX = 80;
    private static final long GARDER_MS = 7L * 24 * 3600_000L;
    private static final long ECHEC_MS = 24L * 3600_000L;
    private static final long PURGER_MS = 30L * 24 * 3600_000L;

    /** A logo URL we accept to fetch: https, bounded, and never a NEOWATCH API link. */
    static boolean urlAcceptee(String url) {
        if (url == null || url.isEmpty() || url.length() > 1000) return false;
        try {
            Uri u = Uri.parse(url);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) return false;
            String chemin = u.getPath() == null ? "" : u.getPath().toLowerCase(Locale.ROOT);
            return !chemin.startsWith("/api/");
        } catch (Exception e) {
            return false;
        }
    }

    private static File dossier(Context ctx) {
        File d = new File(ctx.getApplicationContext().getFilesDir(), "widget_logos");
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    private static String nom(String url) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] h = md.digest(url.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 12; i++) sb.append(String.format(Locale.ROOT, "%02x", h[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(url.hashCode());
        }
    }

    /** Fetches and stores a logo if we do not have a recent copy (or a recent failure). BLOCKING. */
    static void recuperer(Context ctx, String url) {
        if (!urlAcceptee(url) || Looper.getMainLooper().isCurrentThread()) return;
        File d = dossier(ctx);
        String n = nom(url);
        File png = new File(d, n + ".png"), rate = new File(d, n + ".rate");
        long maintenant = System.currentTimeMillis();
        if (png.exists() && maintenant - png.lastModified() < GARDER_MS) return;
        if (rate.exists() && maintenant - rate.lastModified() < ECHEC_MS) return;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(6000);
            c.setUseCaches(false);
            // Logo hosts (imgur, wikimedia) redirect within https; HttpURLConnection never follows
            // a redirect to another protocol, so an https logo stays https.
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", WidgetLecture.UA);
            c.setRequestProperty("Accept", "image/png,image/jpeg,image/webp,image/*;q=0.8");
            if (c.getResponseCode() != 200) throw new java.io.IOException("http " + c.getResponseCode());
            byte[] octets;
            try (InputStream in = c.getInputStream()) {
                octets = WidgetLecture.lireOctets(in, MAX_OCTETS);
            }
            Bitmap b = reduire(octets);
            if (b == null) throw new java.io.IOException("not a bitmap");
            File tmp = new File(d, n + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                b.compress(Bitmap.CompressFormat.PNG, 100, out);
            }
            b.recycle();
            if (!tmp.renameTo(png)) tmp.delete();
            if (rate.exists()) rate.delete();
        } catch (Exception e) {
            try {
                if (!rate.exists()) rate.createNewFile();
                else rate.setLastModified(maintenant);
            } catch (Exception ignore) {
                // without the marker we simply try again next time
            }
            Log.i(TAG, "logo not usable (" + e.getClass().getSimpleName() + "), monogram instead");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Decodes and scales to COTE_PX at most (null for an SVG or anything Android cannot decode). */
    private static Bitmap reduire(byte[] octets) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(octets, 0, octets.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0 || o.outWidth > 8000 || o.outHeight > 8000) return null;
        int ech = 1;
        while (o.outWidth / (ech * 2) >= COTE_PX && o.outHeight / (ech * 2) >= COTE_PX) ech *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = ech;
        Bitmap b = BitmapFactory.decodeByteArray(octets, 0, octets.length, o2);
        if (b == null) return null;
        float f = Math.min(1f, (float) COTE_PX / Math.max(b.getWidth(), b.getHeight()));
        if (f >= 1f) return b;
        Bitmap s = Bitmap.createScaledBitmap(b, Math.max(1, Math.round(b.getWidth() * f)), Math.max(1, Math.round(b.getHeight() * f)), true);
        if (s != b) b.recycle();
        return s;
    }

    /**
     * The stored logo, or null. `memo` holds the bitmaps of ONE drawing pass, so the same Bitmap
     * instance is reused by the S / M / L variants (RemoteViews then sends it once).
     */
    static Bitmap charger(Context ctx, String url, Map<String, Bitmap> memo) {
        if (!urlAcceptee(url)) return null;
        if (memo != null && memo.containsKey(url)) return memo.get(url);
        Bitmap b = null;
        try {
            File png = new File(dossier(ctx), nom(url) + ".png");
            if (png.exists() && png.length() < MAX_OCTETS) b = BitmapFactory.decodeFile(png.getPath());
        } catch (Exception e) {
            b = null;
        }
        if (memo != null) memo.put(url, b);
        return b;
    }

    /** Old logos leave (a channel no widget shows any more). */
    static void purger(Context ctx) {
        try {
            File[] fichiers = dossier(ctx).listFiles();
            long maintenant = System.currentTimeMillis();
            if (fichiers == null) return;
            for (File f : fichiers) if (maintenant - f.lastModified() > PURGER_MS) f.delete();
        } catch (Exception ignore) {
            // a file we cannot delete is harmless
        }
    }
}

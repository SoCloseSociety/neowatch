package co.soclose.neowatch.twa;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.SizeF;
import android.widget.RemoteViews;

import java.util.HashMap;
import java.util.Map;

/**
 * What the three NEOWATCH widgets share. Adapted from the Sentinel House widget kit
 * (WidgetBase.java + WidgetModule.java), same organisation:
 *
 *   - ONE DRAWING PER SIZE: on Android 12+ a size map (the launcher picks the drawing that fits,
 *     no round trip to the app); before, the size comes from the widget options. Drawing reads
 *     the CACHE and the STATE of the last read: drawing never touches the network.
 *   - THE NETWORK IN A JOB (WidgetJob): onUpdate draws what is known at once, then asks for a read.
 *   - TAPS open a page in the shell (an explicit intent to LauncherActivity with the URL as data)
 *     or ask for a refresh (WidgetActions, NOT exported). Nothing else: no purchase, no pairing,
 *     no sign-in or sign-out, no account or admin action, never a /api/proxy link.
 */
abstract class WidgetBase extends AppWidgetProvider {
    static final String TAG = "NeoWatchWidget";

    /** The kind (Widgets.DIRECT...). */
    abstract String genre();

    /** The drawing of one widget for one size, from the cache and the state. */
    abstract RemoteViews vues(Context c, int id, Widgets.Taille t, Map<String, Bitmap> memo);

    /** false for a widget with a single drawing (the 1x1 shortcut). */
    boolean parTaille() { return true; }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) dessinerSur(ctx, mgr, id);
        WidgetJob.lancer(ctx, genre(), 0, false);
        WidgetActions.planifierTic(ctx);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        dessinerSur(ctx, mgr, id);
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        Widgets.oublier(ctx, genre(), ids);
    }

    @Override
    public void onDisabled(Context ctx) {
        WidgetActions.arreterTicSiAucun(ctx);
    }

    void dessinerSur(Context ctx, AppWidgetManager mgr, int id) {
        try {
            mgr.updateAppWidget(id, vuesParTaille(ctx, mgr, id));
        } catch (Exception e) {
            // A drawing must never crash the receiver: the launcher keeps the previous one.
            Log.w(TAG, "widget " + genre() + ": drawing failed -- " + e.getClass().getSimpleName());
        }
    }

    /** S / M / L as a size map (Android 12+) or chosen from the options. */
    RemoteViews vuesParTaille(Context ctx, AppWidgetManager mgr, int id) {
        Map<String, Bitmap> memo = new HashMap<>();
        if (!parTaille()) return vues(ctx, id, Widgets.Taille.S, memo);
        if (Build.VERSION.SDK_INT >= 31) {
            Map<SizeF, RemoteViews> carte = new HashMap<>();
            carte.put(new SizeF(0f, 0f), vues(ctx, id, Widgets.Taille.S, memo));
            carte.put(new SizeF(Widgets.LARGE_DP, 0f), vues(ctx, id, Widgets.Taille.M, memo));
            carte.put(new SizeF(Widgets.LARGE_DP, Widgets.HAUT_DP), vues(ctx, id, Widgets.Taille.L, memo));
            return new RemoteViews(carte);
        }
        Bundle o = mgr.getAppWidgetOptions(id);
        int l = o == null ? 0 : o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int h = o == null ? 0 : o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        return vues(ctx, id, Widgets.taille(l, h), memo);
    }

    /** Redraws EVERY widget of a kind (after a read, a tick, a language change). */
    static void rendre(Context ctx, String genre) {
        Class<? extends WidgetBase> classe = classeDe(genre);
        if (classe == null) return;
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, classe));
            if (ids == null || ids.length == 0) return;
            WidgetBase w = classe.getDeclaredConstructor().newInstance();
            for (int id : ids) w.dessinerSur(ctx, mgr, id);
        } catch (Exception e) {
            Log.w(TAG, "widget " + genre + ": drawing failed -- " + e.getClass().getSimpleName());
        }
    }

    /** Redraws one widget (after its options screen). */
    static void rendre(Context ctx, String genre, int id) {
        Class<? extends WidgetBase> classe = classeDe(genre);
        if (classe == null) return;
        try {
            classe.getDeclaredConstructor().newInstance().dessinerSur(ctx, AppWidgetManager.getInstance(ctx), id);
        } catch (Exception e) {
            Log.w(TAG, "widget " + genre + ": drawing failed -- " + e.getClass().getSimpleName());
        }
    }

    static final String[] GENRES = {Widgets.DIRECT, Widgets.MES, Widgets.CHAINE};

    static Class<? extends WidgetBase> classeDe(String genre) {
        if (genre == null) return null;
        switch (genre) {
            case Widgets.DIRECT: return WidgetDirect.class;
            case Widgets.MES: return WidgetMesChaines.class;
            case Widgets.CHAINE: return WidgetChaine.class;
            default: return null;
        }
    }

    /** The widget ids of a kind placed right now (empty, never null). */
    static int[] ids(Context ctx, String genre) {
        Class<? extends WidgetBase> classe = classeDe(genre);
        if (classe == null) return new int[0];
        try {
            int[] ids = AppWidgetManager.getInstance(ctx).getAppWidgetIds(new ComponentName(ctx, classe));
            return ids == null ? new int[0] : ids;
        } catch (Exception e) {
            return new int[0];
        }
    }

    /** The kind of a placed widget, from its provider ("" if unknown). */
    static String genreDe(Context ctx, int id) {
        try {
            android.appwidget.AppWidgetProviderInfo info = AppWidgetManager.getInstance(ctx).getAppWidgetInfo(id);
            if (info == null || info.provider == null) return "";
            String nom = info.provider.getClassName();
            for (String g : GENRES) {
                Class<?> c = classeDe(g);
                if (c != null && c.getName().equals(nom)) return g;
            }
        } catch (Exception e) {
            Log.w(TAG, "widget: unknown provider -- " + e.getClass().getSimpleName());
        }
        return "";
    }

    // ------------------------------------------------------------------ tap intents

    /**
     * Opens a NEOWATCH page in the shell: an EXPLICIT intent to LauncherActivity, ACTION_VIEW with
     * the URL as data (LauncherActivity.urlFromIntent only accepts https://neowatch.soclose.co).
     * Callers only pass Widgets.URL_ACCUEIL or Widgets.urlChaine(id).
     */
    static PendingIntent ouvrir(Context ctx, int requete, String url) {
        if (url == null || !LauncherActivity.isOwnUrl(Uri.parse(url))) url = Widgets.URL_ACCUEIL;
        Intent i = new Intent(ctx, LauncherActivity.class);
        i.setAction(Intent.ACTION_VIEW);
        i.setData(Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(ctx, requete, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** A refresh tap: WidgetActions (not exported), with the widget id. */
    static PendingIntent rafraichir(Context ctx, int requete, int id) {
        Intent i = new Intent(ctx, WidgetActions.class);
        i.setAction(WidgetActions.RAFRAICHIR);
        i.putExtra(WidgetActions.EXTRA_ID, id);
        return PendingIntent.getBroadcast(ctx, requete, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** A unique request code per widget and per button (kit: WidgetBase.requete). */
    static int requete(int id, int bouton) {
        return id * 100 + bouton;
    }

    // ------------------------------------------------------------------ shared card bits

    /** Title, refresh, footer, freshness and the read state of a card (kit: WidgetModule.vues). */
    static WidgetRendu.Carte carte(Context c, int id, String cle, int titre, long maintenant) {
        WidgetRendu.Carte k = new WidgetRendu.Carte();
        k.style = Widgets.style(c, id);
        k.logos = Widgets.logos(c, id);
        k.titre = c.getString(titre);
        String statut = Widgets.statut(c, cle);
        long ts = Widgets.cacheTs(c, cle);
        boolean ok = "ok".equals(statut);
        k.pied = WidgetRendu.pied(c, ts, maintenant);
        k.frais = ts > 0 && ok && !Widgets.perime(maintenant - ts);
        k.perime = ts > 0 && !k.frais;
        k.statut = WidgetRendu.statut(c, statut, ts > 0);
        k.clicTitre = ouvrir(c, requete(id, 0), Widgets.URL_ACCUEIL);
        k.clicRafraichir = rafraichir(c, requete(id, 1), id);
        return k;
    }
}

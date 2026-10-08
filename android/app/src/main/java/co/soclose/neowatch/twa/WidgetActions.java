package co.soclose.neowatch.twa;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The widget taps that are not a page: a NON exported receiver (kit: WidgetActions.java), so only
 * this app's PendingIntents reach it. Two actions, nothing else:
 *   - RAFRAICHIR: the refresh tap -> a read in WidgetJob for that widget;
 *   - TIC: a redraw WITHOUT network, so "checked N min ago" stays true between two reads.
 *     The tick is an INEXACT, NON-WAKEUP alarm (AlarmManager.RTC): it never wakes the phone, it
 *     only runs while the screen is in use, and it stops when the last widget is removed.
 * No purchase, no pairing, no sign-in or sign-out, no account action can be sent from a widget.
 */
public class WidgetActions extends BroadcastReceiver {
    static final String RAFRAICHIR = "co.soclose.neowatch.widget.RAFRAICHIR";
    static final String TIC = "co.soclose.neowatch.widget.TIC";
    static final String EXTRA_ID = "widget";
    private static final long TIC_MS = 60_000L;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        switch (intent.getAction()) {
            case RAFRAICHIR: {
                int id = intent.getIntExtra(EXTRA_ID, 0);
                String genre = WidgetBase.genreDe(ctx, id);
                if (genre.isEmpty()) return;
                WidgetJob.lancer(ctx, genre, Widgets.DIRECT.equals(genre) ? 0 : id, true);
                return;
            }
            case TIC:
                if (!aucun(ctx)) {
                    for (String g : WidgetBase.GENRES) WidgetBase.rendre(ctx, g);
                } else {
                    arreterTicSiAucun(ctx);
                }
                return;
            default:
        }
    }

    private static PendingIntent tic(Context ctx) {
        Intent i = new Intent(ctx, WidgetActions.class).setAction(TIC);
        return PendingIntent.getBroadcast(ctx, 7499, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void planifierTic(Context ctx) {
        try {
            AlarmManager am = ctx.getSystemService(AlarmManager.class);
            if (am != null) am.setInexactRepeating(AlarmManager.RTC, System.currentTimeMillis() + TIC_MS, TIC_MS, tic(ctx));
        } catch (Exception ignore) {
            // without the tick the footer is still right after each read
        }
    }

    static void arreterTicSiAucun(Context ctx) {
        if (!aucun(ctx)) return;
        try {
            AlarmManager am = ctx.getSystemService(AlarmManager.class);
            if (am != null) am.cancel(tic(ctx));
        } catch (Exception ignore) {
            // nothing to cancel
        }
    }

    private static boolean aucun(Context ctx) {
        for (String g : WidgetBase.GENRES) if (WidgetBase.ids(ctx, g).length > 0) return false;
        return true;
    }
}

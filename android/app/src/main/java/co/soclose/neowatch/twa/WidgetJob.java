package co.soclose.neowatch.twa;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.PersistableBundle;
import android.util.Log;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * The network of the widgets: one job per read, right away, off the main thread.
 * Adapted from the Sentinel House widget kit (WidgetJob.java): why a job and not the widget
 * receiver -- a receiver has ten seconds, a job has ten minutes and survives the process; the
 * kit uses JobScheduler (no WorkManager), so does this shell (still zero dependencies).
 *
 * Extras: the KIND, the widget (0 = every widget of that kind), and whether the user asked
 * (a tap: always read; an automatic update: skipped if the last read is under 2 minutes old,
 * so placing a widget does not read twice). Never a URL, never a token.
 */
public class WidgetJob extends JobService {
    private static final String TAG = WidgetBase.TAG;
    private static final String K_GENRE = "genre", K_ID = "id", K_DEMANDE = "demande";
    /** The job id range of the widgets (the shell has no other job). */
    private static final int BASE = 7500, PLAGE = 200;
    private static final long RECENT_MS = 2 * 60_000L;
    private static final AtomicInteger sCompteur = new AtomicInteger((int) (System.currentTimeMillis() % PLAGE));

    static void lancer(Context ctx, String genre, int widgetId, boolean demande) {
        try {
            JobScheduler js = ctx.getSystemService(JobScheduler.class);
            if (js == null || WidgetBase.classeDe(genre) == null) return;
            PersistableBundle b = new PersistableBundle();
            b.putString(K_GENRE, genre);
            b.putInt(K_ID, widgetId);
            b.putInt(K_DEMANDE, demande ? 1 : 0);
            // Without a kept read the widget says "Loading"; with one, it keeps its dated value.
            for (int id : widgetId != 0 ? new int[]{widgetId} : WidgetBase.ids(ctx, genre)) {
                String cle = Widgets.cleLecture(genre, id);
                if (Widgets.cache(ctx, cle).isEmpty()) Widgets.poserStatut(ctx, cle, "lecture");
            }
            int id = BASE + (sCompteur.getAndIncrement() % PLAGE);
            js.schedule(new JobInfo.Builder(id, new ComponentName(ctx, WidgetJob.class))
                    .setOverrideDeadline(0)
                    .setExtras(b)
                    .build());
        } catch (Exception e) {
            Log.w(TAG, "widget: job not scheduled -- " + e.getClass().getSimpleName());
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                executer(params.getExtras());
            } catch (Exception e) {
                Log.w(TAG, "widget: read failed -- " + e.getClass().getSimpleName());
            } finally {
                jobFinished(params, false);
            }
        }, "neowatch-widget").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }

    private void executer(PersistableBundle b) {
        String genre = b.getString(K_GENRE, "");
        int widgetId = b.getInt(K_ID, 0);
        boolean demande = b.getInt(K_DEMANDE, 0) == 1;
        long maintenant = System.currentTimeMillis();
        try {
            switch (genre) {
                case Widgets.DIRECT:
                    if (WidgetBase.ids(this, genre).length == 0) return;
                    if (!demande && recent(Widgets.DIRECT, maintenant)) break;
                    WidgetDirect.lire(this, maintenant);
                    break;
                case Widgets.MES:
                case Widgets.CHAINE:
                    for (int id : widgetId != 0 ? new int[]{widgetId} : WidgetBase.ids(this, genre)) {
                        if (!demande && recent(Widgets.cleLecture(genre, id), maintenant)) continue;
                        WidgetMesChaines.lire(this, genre, id, Widgets.MES.equals(genre), maintenant);
                    }
                    break;
                default:
                    return;
            }
        } catch (Exception e) {
            // Bad JSON, a broken entry: the widget says "Unexpected answer", it never crashes.
            Log.w(TAG, "widget " + genre + ": " + e.getClass().getSimpleName());
            if (Widgets.DIRECT.equals(genre)) Widgets.poserStatut(this, genre, "inattendu");
            else if (widgetId != 0) Widgets.poserStatut(this, Widgets.cleLecture(genre, widgetId), "inattendu");
        }
        WidgetLogos.purger(this);
        if (widgetId != 0) WidgetBase.rendre(this, genre, widgetId);
        else WidgetBase.rendre(this, genre);
    }

    private boolean recent(String cle, long maintenant) {
        long ts = Widgets.cacheTs(this, cle);
        return ts > 0 && "ok".equals(Widgets.statut(this, cle)) && maintenant - ts >= 0 && maintenant - ts < RECENT_MS;
    }
}

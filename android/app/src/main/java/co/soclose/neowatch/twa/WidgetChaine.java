package co.soclose.neowatch.twa;

import android.content.Context;
import android.graphics.Bitmap;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.util.List;
import java.util.Map;

/**
 * "CHANNEL SHORTCUT" (1x1): one channel picked when it is placed; its logo (or two letters) and
 * one state word (a red point + LIVE, or OFF AIR / NOT CHECKED). A tap opens /chaine/<id>?play=1
 * in the shell. Pattern: the kit's WidgetRaccourci, plus the same read as "My channels" (no guide).
 */
public class WidgetChaine extends WidgetBase {
    @Override String genre() { return Widgets.CHAINE; }
    @Override boolean parTaille() { return false; }

    @Override
    RemoteViews vues(Context c, int id, Widgets.Taille t, Map<String, Bitmap> memo) {
        long maintenant = System.currentTimeMillis();
        String cle = Widgets.cleLecture(Widgets.CHAINE, id);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_chaine);
        Widgets.Style style = Widgets.style(c, id);
        WidgetRendu.Palette p = new WidgetRendu.Palette(c, style);
        v.setInt(R.id.w_racine, "setBackgroundResource", Widgets.fondDe(style));

        List<Widgets.Choix> choix = Widgets.choisies(c, id);
        WidgetRendu.Ligne l = new WidgetRendu.Ligne();
        if (choix.isEmpty()) {
            l.nom = "?";
            WidgetRendu.plaque(c, v, l, p, false, memo);
            v.setViewVisibility(R.id.w_l_point, View.GONE);
            v.setViewVisibility(R.id.w_l_etat, View.GONE);
            v.setContentDescription(R.id.w_racine, c.getString(R.string.w_aucune_choisie));
            v.setOnClickPendingIntent(R.id.w_racine, ouvrir(c, requete(id, 0), Widgets.URL_ACCUEIL));
            return v;
        }
        Widgets.Choix ch = choix.get(0);
        JSONObject o = Widgets.objet(Widgets.cache(c, cle));
        JSONObject x = null;
        for (JSONObject y : Widgets.liste(o, "chaines")) if (ch.id.equals(y.optString("id"))) x = y;
        l.nom = x != null && !x.optString("name", "").isEmpty() ? x.optString("name") : ch.nom;
        l.logo = x == null ? "" : x.optString("logo", "");
        l.enLigne = x == null ? null : Widgets.enLigne(x);
        l.disparue = x != null && x.optBoolean("gone", false);
        long ts = Widgets.cacheTs(c, cle);
        boolean perime = ts <= 0 || !"ok".equals(Widgets.statut(c, cle)) || Widgets.perime(maintenant - ts);
        WidgetRendu.plaque(c, v, l, p, Widgets.logos(c, id), memo);
        WidgetRendu.etat(c, v, l, p, perime);
        if (l.disparue) {
            v.setTextViewText(R.id.w_l_etat, c.getString(R.string.w_disparue));
            v.setTextColor(R.id.w_l_etat, p.texte2);
            v.setViewVisibility(R.id.w_l_etat, View.VISIBLE);
        }
        String etat = l.disparue ? c.getString(R.string.w_disparue)
                : c.getString(Boolean.TRUE.equals(l.enLigne) ? R.string.w_etat_live : l.enLigne == null ? R.string.w_etat_inconnu : R.string.w_etat_hors);
        String quand = ts > 0 ? ", " + WidgetRendu.pied(c, ts, maintenant) : "";
        v.setContentDescription(R.id.w_racine, l.nom + ", " + etat + quand);
        v.setOnClickPendingIntent(R.id.w_racine, ouvrir(c, requete(id, 0), Widgets.urlChaine(ch.id)));
        return v;
    }
}

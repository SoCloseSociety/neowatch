package co.soclose.neowatch.twa;

import android.content.Context;
import android.graphics.Bitmap;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * "LIVE NOW" (S / M / L): the channels on air, read from the PUBLIC home payload
 * (GET /api/catalog/home?lang=en|fr|ru): featured[] first (confirmed online by the server), then
 * the first rail (online first). Names with a red point + LIVE, "checked N min ago" in the footer.
 * A channel tap opens /chaine/<id>?play=1 in the shell; the title opens the home page.
 * Pattern: the kit's WidgetDirect (a module widget), on NEOWATCH's own API.
 */
public class WidgetDirect extends WidgetBase {
    @Override String genre() { return Widgets.DIRECT; }

    /** The read (in WidgetJob): the compact list, or null with the failed state set. */
    static void lire(Context ctx, long maintenant) {
        WidgetLecture.Reponse r = WidgetLecture.get("/api/catalog/home?lang=" + Widgets.langue());
        if (!r.ok()) {
            Widgets.poserStatut(ctx, Widgets.DIRECT, r.statut());
            return;
        }
        JSONObject o = compacter(r.json());
        Widgets.poserCache(ctx, Widgets.DIRECT, o.toString(), maintenant);
        Widgets.poserStatut(ctx, Widgets.DIRECT, "ok");
        int n = 0;
        for (JSONObject c : Widgets.liste(o, "chaines")) {
            if (n++ >= Widgets.MAX_DIRECT) break;
            WidgetLogos.recuperer(ctx, c.optString("logo", ""));
        }
    }

    /** featured[] then rails[0] (its online channels first), deduplicated, MAX_DIRECT at most. */
    static JSONObject compacter(JSONObject home) {
        JSONArray out = new JSONArray();
        Set<String> vus = new HashSet<>();
        for (JSONObject f : Widgets.liste(home, "featured")) ajouter(out, vus, f, Widgets.texte(f, "railKey"), Widgets.texte(f, "railTitle"));
        List<JSONObject> rails = Widgets.liste(home, "rails");
        if (!rails.isEmpty()) {
            JSONObject rail = rails.get(0);
            String cle = Widgets.texte(rail, "key"), titre = Widgets.texte(rail, "title");
            List<JSONObject> chaines = Widgets.liste(rail, "channels");
            for (JSONObject c : chaines) if (Boolean.TRUE.equals(Widgets.enLigne(c))) ajouter(out, vus, c, cle, titre);
            for (JSONObject c : chaines) if (!Boolean.TRUE.equals(Widgets.enLigne(c))) ajouter(out, vus, c, cle, titre);
        }
        JSONObject o = new JSONObject();
        try {
            o.put("chaines", out);
        } catch (Exception ignore) {
            // an empty list says "no live channel right now"
        }
        return o;
    }

    private static void ajouter(JSONArray out, Set<String> vus, JSONObject c, String rail, String titre) {
        if (out.length() >= Widgets.MAX_DIRECT) return;
        JSONObject k = Widgets.compacter(c, titre);
        if (k == null || !vus.add(k.optString("id"))) return;
        try {
            if (rail != null && rail.matches("^[a-z]{1,20}$")) k.put("rail", rail);
        } catch (Exception ignore) {
            // without the key the server's title is shown
        }
        out.put(k);
    }

    /** The rail name in the DEVICE language, by rail key (server HOME_RAILS keys); 0 if unknown. */
    static int nomDuRail(String cle) {
        switch (cle == null ? "" : cle) {
            case "foot": return R.string.w_rail_foot;
            case "fr": return R.string.w_rail_fr;
            case "uk": return R.string.w_rail_uk;
            case "de": return R.string.w_rail_de;
            case "it": return R.string.w_rail_it;
            case "es": return R.string.w_rail_es;
            case "news": return R.string.w_rail_news;
            case "movies": return R.string.w_rail_movies;
            case "series": return R.string.w_rail_series;
            case "kids": return R.string.w_rail_kids;
            case "music": return R.string.w_rail_music;
            case "documentary": return R.string.w_rail_documentary;
            case "entertainment": return R.string.w_rail_entertainment;
            case "general": return R.string.w_rail_general;
            default: return 0;
        }
    }

    @Override
    RemoteViews vues(Context c, int id, Widgets.Taille t, Map<String, Bitmap> memo) {
        long maintenant = System.currentTimeMillis();
        WidgetRendu.Carte k = carte(c, id, Widgets.DIRECT, R.string.w_direct_titre, maintenant);
        JSONObject o = Widgets.objet(Widgets.cache(c, Widgets.DIRECT));
        int i = 0;
        for (JSONObject ch : Widgets.liste(o, "chaines")) {
            WidgetRendu.Ligne l = new WidgetRendu.Ligne();
            l.nom = ch.optString("name", "");
            l.logo = ch.optString("logo", "");
            l.enLigne = Widgets.enLigne(ch);
            // The rail name from our own strings (one language on screen), the server's title otherwise.
            int nomRail = nomDuRail(ch.optString("rail", ""));
            String sous = nomRail != 0 ? c.getString(nomRail) : ch.optString("sous", "");
            l.sous = ch.optBoolean("locked", false) ? c.getString(R.string.w_premium) + (sous.isEmpty() ? "" : " · " + sous) : sous;
            l.clic = ouvrir(c, requete(id, 10 + i++), Widgets.urlChaine(ch.optString("id")));
            k.lignes.add(l);
        }
        if (o != null && k.lignes.isEmpty() && k.statut.isEmpty()) k.statut = c.getString(R.string.w_aucune_direct);
        return WidgetRendu.dessiner(c, k, t, Widgets.lignes(Widgets.DIRECT, t), memo);
    }
}

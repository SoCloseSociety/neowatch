package co.soclose.neowatch.twa;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * "MY CHANNELS" (S = 1 channel, M = 4, L = 8): channels picked in the options screen (search),
 * stored as id + channelId + name per widget. A read re-asks each channel
 * (GET /api/catalog/channel/<id>?channelId=<tvg-id>, adopting `canonicalId` when the catalog moved
 * the id) for online / name / logo, then the guide (GET /api/epg/now?ids=...) for now / next.
 * Honest words: OFF AIR, NOT CHECKED, "No guide", "No longer listed", "checked N min ago".
 */
public class WidgetMesChaines extends WidgetBase {
    @Override String genre() { return Widgets.MES; }

    /**
     * The read of ONE widget's picks (also used by the 1x1 shortcut, without the guide). BLOCKING,
     * in WidgetJob. A network / sign-in / server failure keeps the last list and sets the state;
     * a 404 marks that one channel "no longer listed".
     */
    static void lire(Context ctx, String genre, int id, boolean guide, long maintenant) {
        String cle = Widgets.cleLecture(genre, id);
        List<Widgets.Choix> choix = Widgets.choisies(ctx, id);
        if (choix.isEmpty()) return;
        JSONArray chaines = new JSONArray();
        boolean change = false;
        for (Widgets.Choix ch : choix) {
            String chemin = "/api/catalog/channel/" + Uri.encode(ch.id)
                    + (ch.channelId.isEmpty() ? "" : "?channelId=" + Uri.encode(ch.channelId));
            WidgetLecture.Reponse r = WidgetLecture.get(chemin);
            if (r.sorte == WidgetLecture.Sorte.INTROUVABLE) {
                JSONObject g = new JSONObject();
                try {
                    g.put("id", ch.id).put("channelId", ch.channelId).put("name", ch.nom).put("gone", true);
                } catch (Exception ignore) {
                    continue;
                }
                chaines.put(g);
                continue;
            }
            if (!r.ok()) {
                Widgets.poserStatut(ctx, cle, r.statut());
                return;
            }
            JSONObject j = r.json();
            // The catalog id is index-based and can move between rebuilds: adopt the canonical one.
            String canon = Widgets.texte(j, "canonicalId");
            if (Widgets.idValide(canon) && !canon.equals(ch.id)) { ch.id = canon; change = true; }
            else if (canon.isEmpty() && Widgets.idValide(Widgets.texte(j, "id")) && !Widgets.texte(j, "id").equals(ch.id)) {
                ch.id = Widgets.texte(j, "id"); change = true;
            }
            String nom = Widgets.borne(Widgets.texte(j, "name"), 120);
            if (!nom.isEmpty() && !nom.equals(ch.nom)) { ch.nom = nom; change = true; }
            String cid = Widgets.texte(j, "channelId");
            if (Widgets.channelIdValide(cid) && !cid.equals(ch.channelId)) { ch.channelId = cid; change = true; }
            try {
                j.put("id", ch.id);
            } catch (Exception ignore) {
                // the compact entry keeps the id the catalog gave
            }
            JSONObject k = Widgets.compacter(j, "");
            if (k != null) chaines.put(k);
        }
        if (change) Widgets.poserChoisies(ctx, id, choix);

        JSONObject o = new JSONObject();
        try {
            o.put("chaines", chaines);
            o.put("guideLu", false);
            if (guide) lireGuide(chaines, o);
        } catch (Exception ignore) {
            // a guide we could not attach reads as "not read": no "No guide" claim
        }
        Widgets.poserCache(ctx, cle, o.toString(), maintenant);
        Widgets.poserStatut(ctx, cle, "ok");
        for (int i = 0; i < chaines.length(); i++) {
            JSONObject c = chaines.optJSONObject(i);
            if (c != null) WidgetLogos.recuperer(ctx, c.optString("logo", ""));
        }
    }

    /** GET /api/epg/now?ids=a,b,c -> now / next per channel (title, start, stop), guideLu = true. */
    private static void lireGuide(JSONArray chaines, JSONObject o) throws Exception {
        StringBuilder ids = new StringBuilder();
        for (int i = 0; i < chaines.length(); i++) {
            String cid = chaines.optJSONObject(i).optString("channelId", "");
            if (cid.isEmpty()) continue;
            if (ids.length() > 0) ids.append(',');
            ids.append(Uri.encode(cid));
        }
        if (ids.length() == 0) { o.put("guideLu", true); return; }
        WidgetLecture.Reponse r = WidgetLecture.get("/api/epg/now?ids=" + ids);
        if (!r.ok()) return;
        JSONObject parChaine = r.json().optJSONObject("channels");
        for (int i = 0; i < chaines.length(); i++) {
            JSONObject c = chaines.optJSONObject(i);
            JSONObject nn = parChaine == null ? null : parChaine.optJSONObject(c.optString("channelId", ""));
            if (nn == null) continue;
            JSONObject now = programme(nn.optJSONObject("now")), next = programme(nn.optJSONObject("next"));
            if (now != null) c.put("now", now);
            if (next != null) c.put("next", next);
        }
        o.put("guideLu", true);
    }

    private static JSONObject programme(JSONObject p) throws Exception {
        if (p == null) return null;
        String titre = Widgets.borne(Widgets.texte(p, "title"), 120);
        long s = p.optLong("start", 0), e = p.optLong("stop", 0);
        if (titre.isEmpty() || s <= 0) return null;
        return new JSONObject().put("t", titre).put("s", s).put("e", e > s ? e : s + 3600_000L);
    }

    /** The programme on air at `t` among now / next, and the one after it ([cur, suivant], each may be null). */
    static JSONObject[] programmes(JSONObject ch, long t) {
        JSONObject now = ch.optJSONObject("now"), next = ch.optJSONObject("next");
        if (now != null && now.optLong("s") <= t && t < now.optLong("e")) {
            boolean suite = next != null && next.optLong("s") >= now.optLong("e") - 60_000L && next.optLong("s") > now.optLong("s");
            return new JSONObject[]{now, suite ? next : null};
        }
        if (next != null && next.optLong("s") <= t && t < next.optLong("e")) return new JSONObject[]{next, null};
        return new JSONObject[]{null, null};
    }

    @Override
    RemoteViews vues(Context c, int id, Widgets.Taille t, Map<String, Bitmap> memo) {
        long maintenant = System.currentTimeMillis();
        String cle = Widgets.cleLecture(Widgets.MES, id);
        WidgetRendu.Carte k = carte(c, id, cle, R.string.w_mes_titre, maintenant);
        List<Widgets.Choix> choix = Widgets.choisies(c, id);
        if (choix.isEmpty()) {
            k.statut = c.getString(R.string.w_aucune_choisie);
            k.pied = "";
            k.frais = false;
            return WidgetRendu.dessiner(c, k, t, 0, memo);
        }
        JSONObject o = Widgets.objet(Widgets.cache(c, cle));
        boolean guideLu = o != null && o.optBoolean("guideLu", false);
        Map<String, JSONObject> parId = new HashMap<>();
        for (JSONObject ch : Widgets.liste(o, "chaines")) parId.put(ch.optString("id"), ch);
        k.hero = t == Widgets.Taille.S;
        DateFormat heure = android.text.format.DateFormat.getTimeFormat(c);
        int max = Widgets.lignes(Widgets.MES, t);
        List<WidgetRendu.Ligne> lignes = new ArrayList<>();
        int i = 0;
        for (Widgets.Choix ch : choix) {
            JSONObject x = parId.get(ch.id);
            WidgetRendu.Ligne l = new WidgetRendu.Ligne();
            l.nom = x != null && !x.optString("name", "").isEmpty() ? x.optString("name") : ch.nom;
            l.clic = ouvrir(c, requete(id, 10 + i++), Widgets.urlChaine(ch.id));
            if (x == null) {
                l.enLigne = null;
            } else if (x.optBoolean("gone", false)) {
                l.disparue = true;
                l.sous = c.getString(R.string.w_disparue);
            } else {
                l.enLigne = Widgets.enLigne(x);
                l.logo = x.optString("logo", "");
                JSONObject[] pr = programmes(x, maintenant);
                if (pr[0] != null) l.sous = pr[0].optString("t", "");
                else if (guideLu) l.sous = c.getString(R.string.w_sans_guide);
                if (pr[1] != null) l.suite = c.getString(R.string.w_suite, heure.format(new Date(pr[1].optLong("s"))), pr[1].optString("t", ""));
                if (x.optBoolean("locked", false)) l.sous = c.getString(R.string.w_premium) + (l.sous.isEmpty() ? "" : " · " + l.sous);
            }
            lignes.add(l);
        }
        k.lignes.addAll(lignes);
        // "+3 more": under the single channel in S (room there), on the footer line in M / L (a
        // status line of its own pushed the last row out on a 4x2, measured on the emulator).
        if (lignes.size() > max) {
            String plus = c.getString(R.string.w_plus, lignes.size() - max);
            if (k.hero) { if (k.statut.isEmpty()) k.statut = plus; }
            else k.pied = plus + (k.pied.isEmpty() ? "" : " · " + k.pied);
        }
        return WidgetRendu.dessiner(c, k, t, max, memo);
    }
}

package co.soclose.neowatch.twa;

import android.app.PendingIntent;
import android.content.Context;
import android.graphics.Bitmap;
import android.view.View;
import android.widget.RemoteViews;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The common drawing of the NEOWATCH widgets: a CARD (title, refresh, channel rows, an honest
 * state, a dated footer) in one of two frames (widget_cadre_s / widget_cadre), in the style
 * chosen at placement. Adapted from the Sentinel House widget kit (WidgetRendu.java).
 *
 * Readability rules (kit): a stale read takes the secondary ink and the footer says how old it
 * is; a state is a WORD (LIVE, OFF AIR, NOT CHECKED), the red point only goes WITH the word, and
 * mint only marks a fresh read. Rows are nested views (widget_ligne) added one by one.
 */
final class WidgetRendu {
    private WidgetRendu() {}

    /** One channel row. */
    static final class Ligne {
        String nom = "", sous = "", suite = "", logo = "";
        /** TRUE live, FALSE off air, null not checked. */
        Boolean enLigne;
        boolean disparue;
        PendingIntent clic;
    }

    /** What a widget wants to show. An empty field is simply absent. */
    static final class Carte {
        String titre = "", statut = "", pied = "";
        final List<Ligne> lignes = new ArrayList<>();
        /** The read is fresh (mint point in the footer). */
        boolean frais;
        /** The read is stale or failed: values take the secondary ink, LIVE is not claimed in red. */
        boolean perime;
        /** One large channel (the S size of "My channels"). */
        boolean hero;
        PendingIntent clicTitre, clicRafraichir;
        Widgets.Style style = Widgets.Style.LUNAIRE;
        boolean logos = true;
    }

    /** The inks of a style (kit: Widgets.Palette). Glass keeps the Lunaire inks (AA on its veil). */
    static final class Palette {
        final int texte, texte2, menthe, live, plaque;

        Palette(Context c, Widgets.Style s) {
            boolean doux = s == Widgets.Style.DOUX;
            texte = c.getColor(doux ? R.color.w_doux_texte : R.color.w_texte);
            texte2 = c.getColor(doux ? R.color.w_doux_texte2 : R.color.w_texte2);
            menthe = c.getColor(doux ? R.color.w_doux_menthe : R.color.w_menthe);
            live = c.getColor(doux ? R.color.w_doux_live : R.color.w_live);
            plaque = doux ? R.drawable.w_plaque_doux : R.drawable.w_plaque;
        }
    }

    static RemoteViews dessiner(Context c, Carte k, Widgets.Taille t, int maxLignes, Map<String, Bitmap> memo) {
        RemoteViews v = new RemoteViews(c.getPackageName(), t == Widgets.Taille.S ? R.layout.widget_cadre_s : R.layout.widget_cadre);
        Palette p = new Palette(c, k.style);
        v.setInt(R.id.w_racine, "setBackgroundResource", Widgets.fondDe(k.style));

        v.setTextViewText(R.id.w_titre, k.titre);
        v.setTextColor(R.id.w_titre, p.texte2);
        v.setInt(R.id.w_rafraichir, "setColorFilter", p.texte2);

        v.removeAllViews(R.id.w_lignes);
        int n = Math.min(k.lignes.size(), maxLignes);
        for (int i = 0; i < n; i++) {
            Ligne l = k.lignes.get(i);
            RemoteViews r = new RemoteViews(c.getPackageName(), k.hero ? R.layout.widget_ligne_hero
                    : t == Widgets.Taille.S ? R.layout.widget_ligne_s : R.layout.widget_ligne);
            plaque(c, r, l, p, k.logos, memo);
            etat(c, r, l, p, k.perime);
            r.setTextViewText(R.id.w_l_nom, l.nom);
            r.setTextColor(R.id.w_l_nom, k.perime || l.disparue ? p.texte2 : p.texte);
            boolean avecSous = !l.sous.isEmpty() && (k.hero || t != Widgets.Taille.S);
            r.setTextViewText(R.id.w_l_sous, l.sous);
            r.setTextColor(R.id.w_l_sous, k.hero && !k.perime ? p.texte : p.texte2);
            r.setViewVisibility(R.id.w_l_sous, avecSous ? View.VISIBLE : View.GONE);
            if (k.hero) {
                r.setTextViewText(R.id.w_l_suite, l.suite);
                r.setTextColor(R.id.w_l_suite, p.texte2);
                r.setViewVisibility(R.id.w_l_suite, l.suite.isEmpty() ? View.GONE : View.VISIBLE);
            }
            if (l.clic != null) r.setOnClickPendingIntent(R.id.w_l_racine, l.clic);
            v.addView(R.id.w_lignes, r);
        }

        v.setTextViewText(R.id.w_statut, k.statut);
        v.setTextColor(R.id.w_statut, p.texte2);
        v.setViewVisibility(R.id.w_statut, k.statut.isEmpty() ? View.GONE : View.VISIBLE);

        v.setTextViewText(R.id.w_pied_texte, k.pied);
        v.setTextColor(R.id.w_pied_texte, p.texte2);
        v.setViewVisibility(R.id.w_frais, k.frais ? View.VISIBLE : View.GONE);
        v.setInt(R.id.w_frais, "setColorFilter", p.menthe);

        if (k.clicTitre != null) v.setOnClickPendingIntent(R.id.w_titre, k.clicTitre);
        if (k.clicRafraichir != null) {
            v.setOnClickPendingIntent(R.id.w_rafraichir, k.clicRafraichir);
            v.setOnClickPendingIntent(R.id.w_pied, k.clicRafraichir);
        }
        return v;
    }

    /** The logo plate: the stored logo, else two letters. Only touches w_l_plaque / _logo / _mono. */
    static void plaque(Context c, RemoteViews r, Ligne l, Palette p, boolean logos, Map<String, Bitmap> memo) {
        r.setInt(R.id.w_l_plaque, "setBackgroundResource", p.plaque);
        Bitmap b = logos ? WidgetLogos.charger(c, l.logo, memo) : null;
        if (b != null) {
            r.setImageViewBitmap(R.id.w_l_logo, b);
            r.setViewVisibility(R.id.w_l_logo, View.VISIBLE);
            r.setViewVisibility(R.id.w_l_mono, View.GONE);
        } else {
            r.setViewVisibility(R.id.w_l_logo, View.GONE);
            r.setTextViewText(R.id.w_l_mono, Widgets.monogramme(l.nom));
            r.setTextColor(R.id.w_l_mono, p.texte2);
            r.setViewVisibility(R.id.w_l_mono, View.VISIBLE);
        }
    }

    /** The state: a red point + LIVE, or a word. Only touches w_l_point / w_l_etat. */
    static void etat(Context c, RemoteViews r, Ligne l, Palette p, boolean perime) {
        if (l.disparue) {
            r.setViewVisibility(R.id.w_l_point, View.GONE);
            r.setTextViewText(R.id.w_l_etat, "");
            r.setViewVisibility(R.id.w_l_etat, View.GONE);
            return;
        }
        r.setViewVisibility(R.id.w_l_etat, View.VISIBLE);
        boolean live = Boolean.TRUE.equals(l.enLigne);
        // A stale "live" is not claimed in red: the word stays, grey, and the footer dates it.
        int encre = live && !perime ? p.live : p.texte2;
        r.setViewVisibility(R.id.w_l_point, live ? View.VISIBLE : View.GONE);
        r.setInt(R.id.w_l_point, "setColorFilter", encre);
        r.setTextViewText(R.id.w_l_etat, c.getString(live ? R.string.w_etat_live
                : l.enLigne == null ? R.string.w_etat_inconnu : R.string.w_etat_hors));
        r.setTextColor(R.id.w_l_etat, encre);
    }

    /** The common footer: "checked 4 min ago", or "Tap to refresh" before any read. */
    static String pied(Context c, long ts, long maintenant) {
        if (ts <= 0) return c.getString(R.string.w_toucher);
        return c.getString(R.string.w_verifie, Widgets.age(c, ts, maintenant));
    }

    /** The state line of the last read ("" when it went well), kit: WidgetBase.texteStatut. */
    static String statut(Context c, String statut, boolean cacheConnu) {
        if (statut == null) statut = "";
        switch (statut) {
            case "ok": return "";
            case "reseau": return c.getString(cacheConnu ? R.string.w_hors_ligne_garde : R.string.w_hors_ligne);
            case "refus": return c.getString(R.string.w_refus);
            case "inattendu": return c.getString(R.string.w_inattendu);
            default: return cacheConnu ? "" : c.getString(R.string.w_chargement);
        }
    }
}

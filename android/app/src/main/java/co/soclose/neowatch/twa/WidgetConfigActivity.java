package co.soclose.neowatch.twa;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The options of a widget, opened by the launcher when it is placed (APPWIDGET_CONFIGURE) and on
 * a long press ("reconfigurable"). Adapted from the Sentinel House widget kit
 * (ChoixWidgetActivity.java): a native screen, built in code, nothing secret to type.
 *
 *   - "My channels" / "Channel shortcut": a search field (GET /api/catalog/channels?q=&limit=20,
 *     a public route; empty = suggestions) and the picked list (8 / 1 at most), stored as
 *     id + channelId + name only;
 *   - every widget: a STYLE (Lunar, Soft, Glass); "Live now": logos or letters only.
 * BACK cancels the placement (RESULT_CANCELED, the default); "Done" validates.
 * Selected choices use the bone primary, never mint (mint is the OK state only).
 */
public class WidgetConfigActivity extends Activity {
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private String genre = "";
    private final List<Widgets.Choix> choisies = new ArrayList<>();
    private Widgets.Style style = Widgets.Style.LUNAIRE;
    private boolean logos = true;

    private LinearLayout listeChoisies, listeResultats, styles, logosLigne;
    private TextView titreChoisies, etat, titreResultats, message;
    private EditText champ;

    private final ExecutorService fil = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private int generation = 0;
    private final Runnable chercher = this::chercherMaintenant;
    private Typeface sans, mono;

    /** A search result: what we show and what we would keep. */
    static final class Resultat {
        final Widgets.Choix choix;
        final String detail;

        Resultat(Widgets.Choix choix, String detail) { this.choix = choix; this.detail = detail; }
    }

    private boolean avecChoix() {
        return Widgets.MES.equals(genre) || Widgets.CHAINE.equals(genre);
    }

    private int maxChoix() {
        return Widgets.CHAINE.equals(genre) ? 1 : Widgets.MAX_CHOISIES;
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setResult(RESULT_CANCELED);
        Intent i = getIntent();
        if (i != null && i.getExtras() != null) widgetId = i.getExtras().getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return; }
        genre = WidgetBase.genreDe(this, widgetId);
        if (genre.isEmpty()) { finish(); return; }
        if (b != null && b.getStringArray(ETAT_IDS) != null) {
            // Recreated (rotation, fold, dark-mode switch) before Done: keep the unsaved choices.
            restaurer(b);
        } else {
            choisies.addAll(Widgets.choisies(this, widgetId));
            style = Widgets.style(this, widgetId);
            logos = Widgets.logos(this, widgetId);
        }
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                sans = getResources().getFont(R.font.plex_sans);
                mono = getResources().getFont(R.font.plex_mono_medium);
            } catch (Exception ignore) {
                // the system font is fine
            }
        }

        int pad = dp(20);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, dp(28), pad, dp(28));
        col.addView(texte(getString(titre()), 24, R.color.w_texte, sans));
        TextView sous = texte(getString(sousTitre()), 15, R.color.w_texte2, sans);
        sous.setPadding(0, dp(6), 0, dp(10));
        col.addView(sous);

        if (avecChoix()) {
            titreChoisies = rubrique("");
            col.addView(titreChoisies);
            listeChoisies = new LinearLayout(this);
            listeChoisies.setOrientation(LinearLayout.VERTICAL);
            col.addView(listeChoisies);

            champ = new EditText(this);
            champ.setHint(R.string.w_cfg_recherche);
            champ.setSingleLine(true);
            champ.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            champ.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
            champ.setTextColor(getColor(R.color.w_texte));
            champ.setHintTextColor(getColor(R.color.w_texte2));
            champ.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            if (sans != null) champ.setTypeface(sans);
            champ.setBackgroundResource(R.drawable.w_champ);
            champ.setPadding(dp(14), dp(12), dp(14), dp(12));
            if (b != null) champ.setText(b.getString(ETAT_Q, ""));   // before the watcher: no extra search
            LinearLayout.LayoutParams lc = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lc.topMargin = dp(18);
            champ.setLayoutParams(lc);
            champ.addTextChangedListener(new TextWatcher() {
                @Override public void beforeTextChanged(CharSequence s, int a, int c, int d) {}
                @Override public void onTextChanged(CharSequence s, int a, int c, int d) {}
                @Override public void afterTextChanged(Editable s) {
                    main.removeCallbacks(chercher);
                    main.postDelayed(chercher, 350);
                }
            });
            champ.setOnEditorActionListener((v, action, ev) -> {
                main.removeCallbacks(chercher);
                chercherMaintenant();
                return false;
            });
            col.addView(champ);

            etat = texte("", 14, R.color.w_texte2, sans);
            etat.setPadding(0, dp(8), 0, 0);
            col.addView(etat);
            titreResultats = rubrique(getString(R.string.w_cfg_suggestions));
            col.addView(titreResultats);
            listeResultats = new LinearLayout(this);
            listeResultats.setOrientation(LinearLayout.VERTICAL);
            col.addView(listeResultats);
        }

        col.addView(rubrique(getString(R.string.w_cfg_style)));
        styles = new LinearLayout(this);
        styles.setOrientation(LinearLayout.HORIZONTAL);
        col.addView(styles);
        dessinerStyles();

        col.addView(rubrique(getString(R.string.w_cfg_logos)));
        logosLigne = new LinearLayout(this);
        logosLigne.setOrientation(LinearLayout.HORIZONTAL);
        col.addView(logosLigne);
        dessinerLogos();

        message = texte("", 14, R.color.w_texte2, sans);
        message.setPadding(0, dp(16), 0, 0);
        message.setVisibility(View.GONE);
        col.addView(message);

        Button ok = bouton(getString(R.string.w_cfg_valider), true);
        ok.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) ok.getLayoutParams();
        lp.topMargin = dp(24);
        ok.setOnClickListener(v -> valider());
        col.addView(ok);

        ScrollView s = new ScrollView(this);
        s.setBackgroundColor(getColor(R.color.w_fond));
        s.setFillViewport(true);
        s.addView(col);
        setContentView(s);

        if (avecChoix()) {
            dessinerChoisies();
            chercherMaintenant();
        }
    }

    // ------------------------------------------------------------------ recreation (no configChanges)

    private static final String ETAT_IDS = "cfg.ids", ETAT_CIDS = "cfg.cids", ETAT_NOMS = "cfg.noms",
            ETAT_STYLE = "cfg.style", ETAT_LOGOS = "cfg.logos", ETAT_Q = "cfg.q";

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        int n = choisies.size();
        String[] ids = new String[n], cids = new String[n], noms = new String[n];
        for (int k = 0; k < n; k++) {
            Widgets.Choix c = choisies.get(k);
            ids[k] = c.id;
            cids[k] = c.channelId;
            noms[k] = c.nom;
        }
        out.putStringArray(ETAT_IDS, ids);
        out.putStringArray(ETAT_CIDS, cids);
        out.putStringArray(ETAT_NOMS, noms);
        out.putString(ETAT_STYLE, style.name());
        out.putBoolean(ETAT_LOGOS, logos);
        if (champ != null) out.putString(ETAT_Q, champ.getText().toString());
    }

    private void restaurer(Bundle b) {
        String[] ids = b.getStringArray(ETAT_IDS), cids = b.getStringArray(ETAT_CIDS), noms = b.getStringArray(ETAT_NOMS);
        for (int k = 0; ids != null && k < ids.length && choisies.size() < maxChoix(); k++) {
            if (!Widgets.idValide(ids[k])) continue;
            choisies.add(new Widgets.Choix(ids[k], cids != null && k < cids.length ? cids[k] : "",
                    noms != null && k < noms.length ? noms[k] : ""));
        }
        try {
            style = Widgets.Style.valueOf(b.getString(ETAT_STYLE, Widgets.Style.LUNAIRE.name()));
        } catch (IllegalArgumentException e) {
            style = Widgets.Style.LUNAIRE;
        }
        logos = b.getBoolean(ETAT_LOGOS, true);
    }

    private int titre() {
        if (Widgets.MES.equals(genre)) return R.string.w_cfg_titre_mes;
        if (Widgets.CHAINE.equals(genre)) return R.string.w_cfg_titre_chaine;
        return R.string.w_cfg_titre_direct;
    }

    private int sousTitre() {
        if (Widgets.MES.equals(genre)) return R.string.w_cfg_sous_mes;
        if (Widgets.CHAINE.equals(genre)) return R.string.w_cfg_sous_chaine;
        return R.string.w_cfg_sous_direct;
    }

    // ------------------------------------------------------------------ search (off the main thread)

    private void chercherMaintenant() {
        if (champ == null || isFinishing()) return;
        final String q = champ.getText().toString().trim();
        final int gen = ++generation;
        etat.setText(R.string.w_cfg_recherche_en_cours);
        etat.setVisibility(View.VISIBLE);
        fil.execute(() -> {
            String chemin = "/api/catalog/channels?limit=20&lang=" + Widgets.langue()
                    + (q.isEmpty() ? "&hideOffline=1" : "&q=" + Uri.encode(Widgets.borne(q, 80)));
            WidgetLecture.Reponse r = WidgetLecture.get(chemin);
            List<Resultat> out = new ArrayList<>();
            String erreur = "";
            if (!r.ok()) {
                erreur = getString(r.sorte == WidgetLecture.Sorte.REFUS ? R.string.w_refus : R.string.w_cfg_erreur);
            } else {
                for (JSONObject c : Widgets.liste(r.json(), "items")) {
                    JSONObject k = Widgets.compacter(c, "");
                    if (k == null) continue;
                    out.add(new Resultat(new Widgets.Choix(Widgets.texte(k, "id"), Widgets.texte(k, "channelId"), Widgets.texte(k, "name")), detail(c)));
                }
            }
            final String e = erreur;
            main.post(() -> {
                if (isFinishing() || gen != generation) return;
                montrerResultats(out, e, q.isEmpty());
            });
        });
    }

    /** "France · Live" -- the country and a state WORD. */
    private String detail(JSONObject c) {
        String pays = Widgets.texte(c, "countryName");
        Boolean en = Widgets.enLigne(c);
        String mot = getString(Boolean.TRUE.equals(en) ? R.string.w_etat_live : en == null ? R.string.w_etat_inconnu : R.string.w_etat_hors);
        return pays.isEmpty() ? mot : pays + " · " + mot;
    }

    private void montrerResultats(List<Resultat> res, String erreur, boolean suggestions) {
        listeResultats.removeAllViews();
        titreResultats.setText(suggestions ? R.string.w_cfg_suggestions : R.string.w_cfg_resultats);
        if (!erreur.isEmpty()) {
            etat.setText(erreur);
        } else if (res.isEmpty()) {
            etat.setText(R.string.w_cfg_aucun_resultat);
        } else {
            etat.setText("");
        }
        etat.setVisibility(etat.getText().length() == 0 ? View.GONE : View.VISIBLE);
        for (Resultat r : res) {
            Button bt = bouton(r.choix.nom + "\n" + r.detail, false);
            bt.setOnClickListener(v -> choisir(r.choix));
            listeResultats.addView(bt);
        }
    }

    // ------------------------------------------------------------------ picked channels

    private void choisir(Widgets.Choix c) {
        for (Widgets.Choix x : choisies) if (x.id.equals(c.id)) return;
        if (maxChoix() == 1) {
            choisies.clear();
        } else if (choisies.size() >= maxChoix()) {
            dire(getString(R.string.w_cfg_complet));
            return;
        }
        choisies.add(new Widgets.Choix(c.id, c.channelId, c.nom));
        dire("");
        dessinerChoisies();
    }

    private void dessinerChoisies() {
        listeChoisies.removeAllViews();
        titreChoisies.setText(Widgets.CHAINE.equals(genre) ? getString(R.string.w_cfg_choisie)
                : getString(R.string.w_cfg_choisies, choisies.size()));
        if (choisies.isEmpty()) {
            TextView vide = texte(getString(R.string.w_cfg_choisir_une), 14, R.color.w_texte2, sans);
            vide.setPadding(0, dp(6), 0, 0);
            listeChoisies.addView(vide);
            return;
        }
        if (!Widgets.CHAINE.equals(genre)) {
            TextView aide = texte(getString(R.string.w_cfg_retirer), 13, R.color.w_texte2, sans);
            aide.setPadding(0, dp(4), 0, 0);
            listeChoisies.addView(aide);
        }
        for (Widgets.Choix c : new ArrayList<>(choisies)) {
            Button bt = bouton(c.nom.isEmpty() ? c.id : c.nom, true);
            bt.setOnClickListener(v -> {
                choisies.remove(c);
                dessinerChoisies();
            });
            listeChoisies.addView(bt);
        }
    }

    // ------------------------------------------------------------------ style and logos

    static int nomStyle(Widgets.Style s) {
        switch (s) {
            case DOUX: return R.string.w_style_doux;
            case VERRE: return R.string.w_style_verre;
            default: return R.string.w_style_lunaire;
        }
    }

    private void dessinerStyles() {
        styles.removeAllViews();
        for (Widgets.Style s : Arrays.asList(Widgets.Style.LUNAIRE, Widgets.Style.DOUX, Widgets.Style.VERRE)) {
            Button bt = bouton(getString(nomStyle(s)), s == style);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.topMargin = dp(8);
            lp.rightMargin = s == Widgets.Style.VERRE ? 0 : dp(8);
            bt.setLayoutParams(lp);
            bt.setGravity(Gravity.CENTER);
            bt.setOnClickListener(v -> { style = s; dessinerStyles(); });
            styles.addView(bt);
        }
    }

    private void dessinerLogos() {
        logosLigne.removeAllViews();
        for (boolean oui : new boolean[]{true, false}) {
            Button bt = bouton(getString(oui ? R.string.w_logos_oui : R.string.w_logos_non), logos == oui);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.topMargin = dp(8);
            lp.rightMargin = oui ? dp(8) : 0;
            bt.setLayoutParams(lp);
            bt.setGravity(Gravity.CENTER);
            bt.setOnClickListener(v -> { logos = oui; dessinerLogos(); });
            logosLigne.addView(bt);
        }
    }

    // ------------------------------------------------------------------ done

    private void valider() {
        if (avecChoix() && choisies.isEmpty()) {
            dire(getString(R.string.w_cfg_choisir_une));
            return;
        }
        if (avecChoix()) Widgets.poserChoisies(this, widgetId, choisies);
        Widgets.poserStyle(this, widgetId, style);
        Widgets.poserLogos(this, widgetId, logos);
        Widgets.poserConfigure(this, widgetId);
        WidgetBase.rendre(this, genre, widgetId);
        WidgetJob.lancer(this, genre, Widgets.DIRECT.equals(genre) ? 0 : widgetId, true);
        WidgetActions.planifierTic(this);
        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        finish();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        fil.shutdownNow();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ small views

    private void dire(String s) {
        message.setText(s);
        message.setVisibility(s.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private TextView rubrique(String s) {
        TextView t = texte(s, 12, R.color.w_texte2, mono);
        t.setAllCaps(true);
        t.setLetterSpacing(0.1f);
        t.setPadding(0, dp(20), 0, dp(2));
        return t;
    }

    private Button bouton(String libelle, boolean choisi) {
        Button bt = new Button(this);
        bt.setAllCaps(false);
        bt.setText(libelle);
        bt.setTextColor(getColor(choisi ? R.color.w_os_encre : R.color.w_texte));
        bt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        if (sans != null) bt.setTypeface(sans);
        bt.setBackgroundResource(choisi ? R.drawable.w_choix_os : R.drawable.w_choix);
        bt.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        bt.setPadding(dp(16), dp(10), dp(16), dp(10));
        bt.setMinHeight(dp(52));
        bt.setStateListAnimator(null);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        bt.setLayoutParams(lp);
        return bt;
    }

    private TextView texte(String s, int sp, int couleur, Typeface tf) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(getColor(couleur));
        if (tf != null) t.setTypeface(tf);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}

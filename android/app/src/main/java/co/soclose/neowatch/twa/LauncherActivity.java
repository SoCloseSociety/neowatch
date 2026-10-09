package co.soclose.neowatch.twa;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * NEOWATCH Android TV shell: one Activity, the system WebView, nothing else.
 *
 * Why not a TWA any more: on TCL Google TVs there is no Chrome, so the v1/v2 TWA fell back
 * to Custom Tabs / com.tcl.browser and showed nothing. The system WebView plays HLS (MSE)
 * fine, so the app now hosts the site itself.
 *
 * Rules:
 *  - only https://neowatch.soclose.co is ever loaded in the main frame; any other host is
 *    handed to the system (ACTION_VIEW), and if nothing can open it we stay put;
 *  - VIEW intents for https://neowatch.soclose.co/... (verified app links) open that exact URL;
 *  - BACK: leave fullscreen, else ask the page (window.__nwBack, 300 ms budget), else WebView
 *    history, then leave the app;
 *  - on a TV, the web app's TV switch (localStorage nw.tv) is set for every page of ours;
 *  - a main-frame load error shows a small dark "No connection" page that retries every 10 s.
 */
public class LauncherActivity extends Activity {

    private static final String TAG = "NeoWatchTV";
    static final String HOST = "neowatch.soclose.co";
    static final String START_URL = "https://" + HOST + "/";
    static final String UA_SUFFIX = " NeoWatchTV/2.0";
    static final int BG = 0xFF05070A;

    private static final long RETRY_MS = 10_000L;
    private static final long KEEP_ON_POLL_MS = 15_000L;
    private static final long BACK_JS_TIMEOUT_MS = 300L;
    private static final String STATE_URL = "neowatch.url";
    private static final String RETRY_URL = "neowatch-shell://retry";
    // The web app's TV switch (web/src/lib/device.ts): localStorage "nw.tv" = "1" turns on the
    // 10-foot layout + D-pad autofocus. A TV WebView user agent does not say "TV", so the shell
    // sets it on a TV, at the start of every page of ours (before the app's deferred scripts).
    private static final String TV_FLAG_JS = "try{localStorage.setItem('nw.tv','1')}catch(e){}";

    private static final String ERROR_HTML =
            "<!doctype html><html><head><meta charset=utf-8>"
            + "<meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<style>"
            + "html,body{margin:0;height:100%;background:#05070a;color:#e6f7fa;"
            + "font-family:'IBM Plex Sans','IBM Plex Sans Fallback',sans-serif}"
            + "body{display:flex;flex-direction:column;align-items:center;justify-content:center;"
            + "gap:28px;text-align:center;padding:24px;box-sizing:border-box}"
            + "p{margin:0;font-size:26px;letter-spacing:.01em}"
            + "button{font:inherit;font-size:20px;padding:12px 36px;border-radius:999px;"
            + "border:2px solid #22d3ee;background:transparent;color:#e6f7fa;cursor:pointer}"
            + "button:focus{background:#22d3ee;color:#05070a;outline:none}"
            + "</style></head><body>"
            + "<p>No connection. Retrying...</p>"
            + "<button id=r autofocus onclick=\"location.href='" + RETRY_URL + "'\">Retry</button>"
            + "<script>document.getElementById('r').focus()</script>"
            + "</body></html>";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable retryTask = this::retryNow;
    private final Runnable keepOnTask = this::updateKeepScreenOn;

    private FrameLayout root;
    private WebView web;
    private WebView errorView;          // created lazily, only on the first error
    private View customView;            // fullscreen <video>
    private WebChromeClient.CustomViewCallback customCallback;
    private ShellChrome chrome;         // kept: WebView.getWebChromeClient() is API 26+

    private String currentUrl = START_URL;
    private String failedUrl;
    private boolean mainFrameFailed;
    private boolean showingError;
    private boolean resumed;
    private boolean isTv;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawable(new ColorDrawable(BG));

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        isTv = isTelevision();

        String saved = savedInstanceState == null ? null : savedInstanceState.getString(STATE_URL);
        String fromIntent = urlFromIntent(getIntent());
        String start = saved != null && isOwnUrl(Uri.parse(saved)) ? saved
                : fromIntent != null ? fromIntent : START_URL;

        createWebView();
        load(start);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // A deep link while running (singleTask): open that exact URL. A plain launcher
        // intent (no URL) just brings the app back where it was.
        String url = urlFromIntent(intent);
        if (url != null) {
            exitFullscreen();
            load(url);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (web != null) web.onResume();
        hideSystemUi();
        if (showingError) retryNow();
        handler.removeCallbacks(keepOnTask);
        handler.post(keepOnTask);
    }

    @Override
    protected void onPause() {
        resumed = false;
        handler.removeCallbacks(retryTask);
        handler.removeCallbacks(keepOnTask);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (web != null) web.onPause();          // stops playback when the user leaves
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (currentUrl != null) out.putString(STATE_URL, currentUrl);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        destroyWebView(web);
        web = null;
        destroyWebView(errorView);
        errorView = null;
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    // ------------------------------------------------------------------ WebView

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(BG);              // before any load: no white flash
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // autoplay
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);             // target=_blank goes through the allowlist
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);                             // system font scale must not break the TV layout
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);  // YouTube embeds inside the site

        web.setWebViewClient(new ShellClient());
        chrome = new ShellChrome();
        web.setWebChromeClient(chrome);
        web.setDownloadListener((url, ua, disposition, mime, length) -> openExternally(Uri.parse(url)));

        root.addView(web, 0, matchParent());
        web.requestFocus();
    }

    private void destroyWebView(WebView w) {
        if (w == null) return;
        try {
            ViewGroup parent = (ViewGroup) w.getParent();
            if (parent != null) parent.removeView(w);
            w.stopLoading();
            w.destroy();
        } catch (RuntimeException e) {
            Log.w(TAG, "WebView destroy failed", e);
        }
    }

    private void load(String url) {
        mainFrameFailed = false;
        currentUrl = url;
        web.loadUrl(url);
    }

    /** Only https://neowatch.soclose.co (exact host) is loaded in the shell. */
    static boolean isOwnUrl(Uri uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && HOST.equalsIgnoreCase(uri.getHost());
    }

    /** The URL a VIEW intent asks for, if it is ours (http is upgraded to https), else null. */
    static String urlFromIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        Uri data = intent.getData();
        if (data == null || !HOST.equalsIgnoreCase(data.getHost())) return null;
        if ("http".equalsIgnoreCase(data.getScheme())) data = data.buildUpon().scheme("https").build();
        return isOwnUrl(data) ? data.toString() : null;
    }

    /**
     * Decides a main-frame navigation: ours -> load in place; http on our host -> upgrade;
     * anything else -> hand it to the system and stay where we are.
     */
    private boolean routeNavigation(WebView view, Uri uri) {
        if (isOwnUrl(uri)) return false;
        if (uri != null && "http".equalsIgnoreCase(uri.getScheme()) && HOST.equalsIgnoreCase(uri.getHost())) {
            view.loadUrl(uri.buildUpon().scheme("https").build().toString());
            return true;
        }
        openExternally(uri);
        return true;
    }

    private void openExternally(Uri uri) {
        if (uri == null || uri.getScheme() == null) return;
        String scheme = uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (scheme.equals("javascript") || scheme.equals("file") || scheme.equals("content")
                || scheme.equals("data") || scheme.equals("about") || scheme.equals("blob")) {
            return;
        }
        Intent intent;
        try {
            if (scheme.equals("intent")) {
                intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                // A page must never be able to target a specific (possibly non-exported) component.
                intent.setComponent(null);
                intent.setSelector(null);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, uri);
            }
        } catch (java.net.URISyntaxException e) {
            return;
        }
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    private class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Sub-frames (e.g. a YouTube embed) are the page's business, not the allowlist's.
            if (!request.isForMainFrame()) return false;
            return routeNavigation(view, request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            // API 23 only (the WebResourceRequest overload exists from API 24).
            return routeNavigation(view, Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            // mainFrameFailed is NOT reset here: an HTTP error can be reported before
            // onPageStarted. It is reset where WE start a navigation (load/reload/goBack);
            // while the offline page covers the site nothing else can navigate.
            if (url != null && isOwnUrl(Uri.parse(url))) {
                currentUrl = url;
                if (isTv) view.evaluateJavascript(TV_FLAG_JS, null);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!mainFrameFailed && showingError) hideError();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            // SPA navigations (pushState) land here, not in onPageStarted.
            if (url != null && isOwnUrl(Uri.parse(url))) currentUrl = url;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            Log.w(TAG, "main frame error " + error.getErrorCode() + " " + error.getDescription());
            showError(request.getUrl().toString());
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            // A gateway error on the page itself (deploy in progress, VPS down): same offline page.
            if (!request.isForMainFrame()) return;
            int code = response.getStatusCode();
            if (code == 502 || code == 503 || code == 504) {
                Log.w(TAG, "main frame HTTP " + code);
                showError(request.getUrl().toString());
            }
        }

        @Override
        @TargetApi(26)  // the callback only exists (and is only called) from API 26
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // By default a renderer crash (OOM on a small TV chip) kills the whole app.
            // Rebuild the WebView instead and reopen the page we were on.
            Log.w(TAG, "renderer gone (crash=" + (detail != null && detail.didCrash()) + "), rebuilding");
            exitFullscreen();
            if (view == errorView) {
                destroyWebView(errorView);
                errorView = null;
                showingError = false;
                return true;
            }
            destroyWebView(web);
            createWebView();
            load(currentUrl != null ? currentUrl : START_URL);
            return true;
        }
    }

    private class ShellChrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customCallback = callback;
            view.setBackgroundColor(Color.BLACK);
            root.addView(view, matchParent());
            web.setVisibility(View.INVISIBLE);
            view.requestFocus();
            hideSystemUi();
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            root.removeView(customView);
            customView = null;
            web.setVisibility(View.VISIBLE);
            web.requestFocus();
            WebChromeClient.CustomViewCallback cb = customCallback;
            customCallback = null;
            if (cb != null) cb.onCustomViewHidden();
            hideSystemUi();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            // Some WebViews draw a grey "play" poster before the first frame: draw nothing.
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        }
    }

    private void exitFullscreen() {
        if (customView != null && chrome != null) chrome.onHideCustomView();
    }

    // ------------------------------------------------------------------ offline / error page

    private void showError(String url) {
        mainFrameFailed = true;
        if (url != null && isOwnUrl(Uri.parse(url))) failedUrl = url;
        else if (failedUrl == null) failedUrl = currentUrl != null ? currentUrl : START_URL;
        exitFullscreen();
        if (errorView == null) createErrorView();
        if (!showingError) {
            showingError = true;
            errorView.loadDataWithBaseURL(null, ERROR_HTML, "text/html", "utf-8", null);
            errorView.setVisibility(View.VISIBLE);
        }
        errorView.requestFocus();
        handler.removeCallbacks(retryTask);
        if (resumed) handler.postDelayed(retryTask, RETRY_MS);
    }

    private void hideError() {
        showingError = false;
        failedUrl = null;
        handler.removeCallbacks(retryTask);
        if (errorView != null) errorView.setVisibility(View.GONE);
        web.requestFocus();
    }

    private void retryNow() {
        handler.removeCallbacks(retryTask);
        if (!showingError || web == null) return;
        String url = failedUrl != null ? failedUrl : START_URL;
        // reload() keeps the history clean when the failed entry is the current one.
        if (url.equals(web.getUrl())) {
            mainFrameFailed = false;
            web.reload();
        } else {
            load(url);
        }
        // If this attempt fails too, showError() re-arms the timer; if it hangs, re-arm anyway.
        if (resumed) handler.postDelayed(retryTask, RETRY_MS);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createErrorView() {
        // A separate WebView, so the offline page never enters the site's back history.
        errorView = new WebView(this);
        errorView.setBackgroundColor(BG);
        errorView.setFocusable(true);
        errorView.setFocusableInTouchMode(true);
        WebSettings s = errorView.getSettings();
        s.setJavaScriptEnabled(true);           // only to focus the Retry button (static HTML)
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        errorView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (RETRY_URL.equals(request.getUrl().toString())) retryNow();
                return true;
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (RETRY_URL.equals(url)) retryNow();
                return true;
            }
        });
        errorView.setVisibility(View.GONE);
        root.addView(errorView, matchParent());
    }

    // ------------------------------------------------------------------ keys

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE && web != null && !showingError
                && customView == null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                // The player toggles play/pause on Space (window keydown, capture phase).
                // Dispatched on document, so focused cards never see it; only when a video exists.
                web.evaluateJavascript("(function(){if(!document.querySelector('video'))return;"
                        + "document.dispatchEvent(new KeyboardEvent('keydown',"
                        + "{key:' ',code:'Space',keyCode:32,bubbles:true,cancelable:true}));})()", null);
            }
            return true;
        }
        // Everything else (D-pad, Enter, digits...) goes to the focused view: the page.
        return super.dispatchKeyEvent(event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (customView != null) {
            exitFullscreen();
            return;
        }
        if (web != null && !showingError) {
            // The web app's ONE Back contract (spatialNav.ts window.__nwBack): closes the top
            // layer, goes back a page, or from a deep link with no history (a widget opening
            // /chaine/<id>) goes to the home page instead of leaving. true = handled, false =
            // "nothing left here" (second Back on the home page): leave. No hook (an older
            // site, a page still loading): the plain history Back below.
            // evaluateJavascript is asynchronous: if the page does not answer within
            // BACK_JS_TIMEOUT_MS (busy renderer, hung page), fall back to history so Back
            // never feels dead; a late answer for that press is then ignored.
            final WebView target = web;
            final boolean[] settled = {false};   // per press: first of (answer, timeout) wins
            final Runnable fallback = () -> {
                if (settled[0]) return;
                settled[0] = true;
                if (web != target || isFinishing()) return;
                Log.w(TAG, "__nwBack did not answer in " + BACK_JS_TIMEOUT_MS + " ms, history back");
                historyBack();
            };
            handler.postDelayed(fallback, BACK_JS_TIMEOUT_MS);
            target.evaluateJavascript("(function(){try{return window.__nwBack?!!window.__nwBack():null;}"
                    + "catch(e){return null;}})()", v -> {
                handler.removeCallbacks(fallback);
                if (settled[0]) return;
                settled[0] = true;
                if (web != target || isFinishing()) return;
                if ("true".equals(v)) return;
                if ("false".equals(v)) finish();
                else historyBack();
            });
            return;
        }
        historyBack();
    }

    private void historyBack() {
        if (web != null && web.canGoBack()) {
            mainFrameFailed = false;
            web.goBack();
            return;
        }
        finish();
    }

    // ------------------------------------------------------------------ screen

    /** Android TV / Google TV (leanback) as opposed to a phone or tablet. */
    private boolean isTelevision() {
        UiModeManager ui = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        if (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        return getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    /** Keep the TV awake only while something is actually playing (polled), so an idle
     *  NEOWATCH home screen still lets the screensaver / standby kick in. */
    private void updateKeepScreenOn() {
        if (!resumed) return;
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        boolean playing = customView != null || (am != null && am.isMusicActive());
        if (playing) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        handler.postDelayed(keepOnTask, KEEP_ON_POLL_MS);
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    private static FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }
}

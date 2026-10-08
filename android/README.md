# NEOWATCH for Android TV -- WebView shell (v2.0.0)

A minimal native Android app that shows `https://neowatch.soclose.co` full-screen in the
device's **system WebView**. One Activity (`LauncherActivity.java`), zero third-party
dependencies, a ~120 kB APK.

- Package: **`co.soclose.neowatch.twa`** (FROZEN: Sentinel House launches the app by this
  package, and `web/public/.well-known/assetlinks.json` is bound to it). The `.twa` suffix is
  historical; the app is no longer a TWA.
- versionCode **3**, versionName **2.0.0**, minSdk 23, targetSdk 34, compileSdk 35.
- Signed with the **existing** NEOWATCH key (alias `my-key-alias`, SHA-256
  `C8:6E:CD:...:F2:61`), so it installs over v1/v2 and the verified deep links keep working.

## Why not a TWA any more

v1/v2 were Bubblewrap Trusted Web Activities. A TWA does not render anything itself: it asks
Chrome (or another Custom Tabs browser) to show the site. **TCL Google TVs ship no Chrome**,
so the TWA fell back to Custom Tabs / `com.tcl.browser` and showed nothing (measured on the
two TCL sets on 04/10/2026). The TCL **system WebView** (v153) does play HLS (native + MSE),
so the app now hosts the site in its own WebView. Same package, same key, same deep links.

## What the shell does

| Area | Behaviour |
|---|---|
| Start URL | `https://neowatch.soclose.co/` |
| Deep links | `VIEW https://neowatch.soclose.co/*` (`autoVerify`, verified by the existing assetlinks.json) opens that exact URL, e.g. `/chaine/<id>`. `singleTask`: a deep link while running reuses the same WebView. `http://` on our host is upgraded to https. |
| Host allowlist | Only `https://neowatch.soclose.co` loads in the main frame. Any other host / scheme is handed to the system with `ACTION_VIEW` (`intent:` URIs are sanitized: no component, no selector, BROWSABLE). If nothing resolves, a toast and we stay put. Sub-frames (YouTube embeds) are not filtered. |
| Launcher | `MAIN` + `LAUNCHER` + `LEANBACK_LAUNCHER`; 320x180 banner; leanback + touchscreen `required=false` (still installs on phones). Activity class name kept as `co.soclose.neowatch.twa.LauncherActivity` (same as the TWA) so pinned entries and `am start -n` still resolve. |
| WebView | JS, DOM storage, database, autoplay (`mediaPlaybackRequiresUserGesture=false`), mixed content NEVER_ALLOW, no file/content access, Safe Browsing on, third-party cookies on (YouTube embeds), text zoom pinned to 100%, hardware accelerated. |
| User agent | default WebView UA + `" NeoWatchTV/2.0"`: the web app can detect the shell with `/NeoWatchTV\//.test(navigator.userAgent)`. |
| Look | No action bar, fullscreen/immersive, `#05070a` window + WebView background set before the first load (no white flash). |
| Fullscreen video | `onShowCustomView` / `onHideCustomView`; Back leaves fullscreen first. |
| Screen | `FLAG_KEEP_SCREEN_ON` only while audio/video is actually playing (polled every 15 s), so an idle home screen still lets the TV screensaver / standby kick in. |
| Keys | D-pad / Enter go to the page (the web app has its own spatial navigation). **Back**: leave fullscreen, else `WebView.goBack()` if possible, else `finish()`. **Play/Pause** (remote media key): a Space keydown is dispatched to the page (the player toggles on Space) only when a `<video>` exists. |
| Offline | A main-frame network error (or 502/503/504 on the page itself) shows a tiny dark page "No connection. Retrying..." with a focused Retry button, in a separate WebView so it never enters the site's back history. Retries 10 s after each failed attempt (immediately on Retry; paused while the app is in the background). |
| Robustness | Renderer crash (`onRenderProcessGone`, low-RAM TV chips) rebuilds the WebView and reopens the current page instead of killing the app. |

Known limit: closing a modal (Settings, Login, Pricing...) or the multi-screen mosaic is wired to
**Escape** in the web app, not to history. In the shell the remote's Back key does history-back
(or leaves the app) and is not delivered to the page as Escape. If that matters, the web app can
push a history entry when a modal opens (then Back closes it here and in every browser).

Emulator check (08/10/2026, Android TV API 34 emulator, WebView 113, release APK): launches
from the leanback intent, `pm get-app-links` = `neowatch.soclose.co: verified`, cold and warm
deep links to `/chaine/<id>` open the channel in the shell (warm = same process, `onNewIntent`),
Back = history then exit, HLS plays, the Play/Pause key freezes/resumes the picture,
`KEEP_SCREEN_ON` is set while playing and cleared ~15 s after, the offline page shows with Retry
focused on `ERR_NAME_NOT_RESOLVED` and retries. Not checked there: a real TCL, a YouTube channel,
recovery from offline (the emulator could not drop its network).

Web-app finding from that run (not a shell issue): on a `/chaine/<id>` page the D-pad never lands
on the **Regarder** button (Down goes from the logo straight to the "Chaines similaires" row, Up
goes back to the top bar). This is the "fiche_ok_a_donner" limit Sentinel House already knows about.

## Build

Toolchain: JDK 17, Android SDK (`platforms;android-35`, `build-tools;35.0.0`), Gradle 8.11.1 via
the wrapper, AGP 8.9.3 (same as Sentinel House Android; already in `~/.gradle` on the Mac).

```bash
cd android
cp keystore.properties.example keystore.properties   # gitignored; edit paths if needed
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew clean assembleRelease
# -> app/build/outputs/apk/release/app-release.apk (signed, zipaligned)
```

### Signing (never commit a secret)

- The key is the existing one in `~/Documents/VsCodeN30/neowatch-signing/` (`signing.keystore`,
  alias `my-key-alias`; passwords in `signing-key-info.txt` next to it). It is NOT in the repo.
- `app/build.gradle` reads `android/keystore.properties` (gitignored) or env vars:
  `NEOWATCH_KEYSTORE`, `NEOWATCH_KEY_ALIAS`, and either `NEOWATCH_SIGNING_INFO` (path to the
  PWABuilder `signing-key-info.txt`, parsed for "Key store password:" / "Key password:") or
  `NEOWATCH_KEYSTORE_PASSWORD` + `NEOWATCH_KEY_PASSWORD`.
- A release build without a signing config **fails on purpose** (an unsigned or debug-signed
  APK would not install over the current app and would break the verified links).
- Do NOT use `neowatch-signing/android.keystore` (alias `android`): that is a different key
  (SHA-256 `6E:B5:70:...`) that does not match the deployed assetlinks.json.

### Verify before shipping

```bash
BT=$ANDROID_HOME/build-tools/35.0.0
APK=app/build/outputs/apk/release/app-release.apk
$BT/apksigner verify --print-certs $APK | grep SHA-256
#   must equal (lowercase, no colons) the fingerprint in web/public/.well-known/assetlinks.json:
#   c86ecdaa204c1161ae1d72b7378a0d4de545370e07284eb1eb164feac9e8f261
$BT/aapt2 dump badging $APK | grep -E "package:|launchable-activity|banner"
#   package co.soclose.neowatch.twa versionCode 3, launchable-activity AND
#   leanback-launchable-activity = co.soclose.neowatch.twa.LauncherActivity, banner present
```

Icons/banner are generated from `web/public/icon-512.png`: `python3 -I android/tools/make_icons.py`
(needs Pillow).

## Publish (only with the owner's go-ahead)

1. Bump `versionCode` / `versionName` in `app/build.gradle` for every new release.
2. Build + verify as above.
3. Upload: `scp app/build/outputs/apk/release/app-release.apk helper-vps:/var/www/neowatch/app.apk`
   (NOT via `deploy.sh`, which excludes `app.apk` on purpose to preserve it).
4. Tell **Sentinel House** the app is now a WebView shell, so it drops the TWA-browser
   assumptions:
   - `sentinel_home/adaptateurs/androidtv.py`: `NAVIGATEURS_DE_TWA["co.soclose.neowatch.twa"]`
     (`com.tcl.browser`) is no longer needed: NEOWATCH itself is the foreground package, and it
     takes audio focus under its own package.
   - `sentinel_home/media.py`: the `twa_sans_chrome` limit (`LIMITE_TWA`) no longer applies once
     v3 (2.0.0) is installed on a TV; the NeoWatch fallback can be considered a working path.
     The `fiche_ok_a_donner` limit is a web-app question, unchanged by the shell.
   - Optional: Sentinel can read the installed version (`dumpsys package co.soclose.neowatch.twa`
     -> `versionCode=3`) to tell a TWA (1-2) from the shell (3+).

## Test checklist (on a real TV, by the owner)

- [ ] **Install over v2**: `adb install -r neowatch-tv-2.0.0.apk` succeeds (no
      `INSTALL_FAILED_UPDATE_INCOMPATIBLE`); `dumpsys package co.soclose.neowatch.twa` shows
      `versionCode=3`. (Logins made in the TWA's browser do not carry over: sign in once.)
- [ ] **Google TV row**: NEOWATCH appears in Apps with the banner; it opens from the row and from
      the Android launcher on a phone.
- [ ] **No white flash** at start; the home page renders; D-pad focus rings move; Enter opens a channel.
- [ ] **App links verified**: `adb shell pm get-app-links co.soclose.neowatch.twa` -> `neowatch.soclose.co: verified`
      (if not: `adb shell pm verify-app-links --re-verify co.soclose.neowatch.twa`).
- [ ] **Deep link**: `adb shell am start -a android.intent.action.VIEW -d https://neowatch.soclose.co/chaine/<id>`
      opens that channel inside NEOWATCH (not a browser), both cold and while the app is running.
      Same from Sentinel House (app link launch).
- [ ] **Autoplay**: the channel starts playing without an extra click (HLS and a YouTube channel).
- [ ] **Fullscreen**: the player's fullscreen button fills the screen; Back leaves fullscreen.
- [ ] **Back**: from a channel opened in-app, Back returns to the previous page; from the first
      page (or a cold deep link), Back leaves the app.
- [ ] **Play/Pause** media key toggles the HLS player.
- [ ] **Foreign link** (e.g. a footer link to another site): opens the TV browser or nothing,
      never inside NEOWATCH.
- [ ] **Offline**: unplug the network -> "No connection. Retrying..." with Retry focused; replug ->
      the page comes back within 10 s (or press Retry).
- [ ] **Screensaver**: idle on the home page, the TV screensaver still starts; while a channel
      plays, it does not.
- [ ] **Sentinel House**: foreground detection reports `co.soclose.neowatch.twa` (not `com.tcl.browser`).

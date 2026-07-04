# NEOWATCH -- Android / Android TV / Play Store (TWA)

NEOWATCH is an installable PWA, so it wraps into a native Android app via a
**Trusted Web Activity (TWA)** -- the app is a thin shell that loads
`https://neowatch.soclose.co` full-screen (no browser URL bar once verified).

## Quick install (no build, for users) -- already shipped
In the app, the **Installer** button (TopBar) shows a **QR code** + steps:
- Phone/tablet: scan -> open -> "Add to home screen" (PWA, full-screen).
- Android/Smart TV: open the link in the TV browser; D-pad navigation works.
- Desktop: browser "Install" button.

## Native APK/AAB for the Play Store (TWA)

### Option A -- PWABuilder (easiest, no local Android SDK)
1. Go to https://www.pwabuilder.com, enter `https://neowatch.soclose.co`.
2. Package For Stores -> **Android** -> Generate. It produces a signed `.aab` + `.apk`
   and an `assetlinks.json` snippet containing your **SHA-256 signing fingerprint**.
3. Put that fingerprint into `web/public/.well-known/assetlinks.json`
   (replace `REPLACE_WITH_YOUR_APP_SIGNING_SHA256_FINGERPRINT`) and redeploy
   (rsync `web/dist/` -> `/var/www/neowatch/`). This removes the URL bar.
4. Upload the `.aab` to Google Play Console (or sideload the `.apk` on a TV).

### Option B -- Bubblewrap (CLI, full control)
```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest=https://neowatch.soclose.co/manifest.webmanifest
# (or use the committed ./twa-manifest.json as a reference)
bubblewrap build          # prompts to create/sign a keystore -> app-release-signed.apk + .aab
bubblewrap fingerprint    # prints the SHA-256 -> paste into assetlinks.json + redeploy
```

### Android TV / Google TV (e.g. TCL) specifics

**Reality check first.** The single most reliable way to run NEOWATCH on a Google TV
(TCL etc.) is the **browser PWA**: install a TV browser (TV Bro, or Chrome if present),
open `https://neowatch.soclose.co`, navigate with the remote (D-pad nav + focus rings
are built in). A TWA in the leanback launcher is nicer but depends on a Chrome/WebView
provider being present on the TV (not guaranteed on Google TV) -- so treat it as a bonus,
not the primary path.

**To make the APK appear in the Google TV app row (leanback):** the TWA's generated
`app/src/main/AndroidManifest.xml` (Bubblewrap) or the PWABuilder Android package must
declare leanback. Edit and rebuild:
```xml
<!-- inside <manifest> -->
<uses-feature android:name="android.software.leanback" android:required="false" />
<uses-feature android:name="android.hardware.touchscreen" android:required="false" />

<!-- on the main <activity>, add a second launcher category -->
<intent-filter>
  <action android:name="android.intent.action.MAIN" />
  <category android:name="android.intent.category.LAUNCHER" />
  <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
</intent-filter>
```
Then add `android:banner="@drawable/banner"` (a 320x180 PNG) on `<application>`, rebuild
(`./gradlew assembleRelease`), re-sign with the same keystore (the signing SHA-256 in
`assetlinks.json` must not change), and redeploy the APK to `/var/www/neowatch/app.apk`.

**Built leanback APK -- verified working recipe (Bubblewrap + JDK 17 + Android SDK):**
The hosted `app.apk` (versionCode 2) is a leanback TWA built locally. To rebuild:
```bash
# 1. Point bubblewrap at JDK 17. GOTCHA (macOS): bubblewrap APPENDS /Contents/Home to
#    jdkPath, so give it the .jdk BUNDLE ROOT, not the .../Contents/Home dir:
#    ~/.bubblewrap/config.json -> { "jdkPath": ".../openjdk@17/libexec/openjdk.jdk",
#                                   "androidSdkPath": "~/Library/Android/sdk" }
bubblewrap doctor                       # must say "valid"
# 2. In a build dir with twa-manifest.json (+ signingKey {path,alias}) and signing.keystore:
BUBBLEWRAP_KEYSTORE_PASSWORD=... BUBBLEWRAP_KEY_PASSWORD=... bubblewrap update --skipVersionUpgrade
# 3. Edit app/src/main/AndroidManifest.xml: add the leanback uses-feature lines +
#    LEANBACK_LAUNCHER category + android:banner on <application> (see snippet above).
#    Fix the empty `splashScreenFadeOutDuration:` in app/build.gradle -> 300. Bump versionCode.
# 4. Build (do NOT re-run `bubblewrap build` -- it regenerates the manifest):
JAVA_HOME=.../openjdk@17/.../Contents/Home ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleRelease --no-daemon
# 5. zipalign + apksigner sign with signing.keystore (alias my-key-alias). Verify the
#    SHA-256 == the assetlinks fingerprint (C8:6E:CD:...F2:61) so DAL verification holds.
# 6. scp the signed APK to helper-vps:/var/www/neowatch/app.apk (NOT via deploy.sh, which
#    excludes app.apk to preserve it).
```
Alternatively regenerate via **PWABuilder** and apply the same manifest edit in its project.
- The web UI already has D-pad/arrow-key grid navigation + visible focus rings + the
  fast WebP hero/tiles, so the in-browser TV experience is smooth on low-power TV chips.

## Digital Asset Links
- Served at `https://neowatch.soclose.co/.well-known/assetlinks.json` (static, via nginx).
- Verifies the app<->domain link so the TWA opens chrome-less. Must contain the
  exact `package_name` (`co.soclose.neowatch`) + your signing-key SHA-256.

## Note on icons
- The PWA currently ships SVG icons. PWABuilder/Bubblewrap auto-generate the
  required PNG densities (48-512) + the maskable + TV banner from a source image.
  For best results provide a 512x512 PNG source if asked.

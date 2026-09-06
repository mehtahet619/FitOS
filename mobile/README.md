# Adaptive Fit — Flutter mobile app

A native Android/iOS client for the same backend the web version uses —
same 5 screens (Today, Workout, Diet, Vision, Gym), same REST API, real
camera-based pose detection and QR check-in.

## Honesty check before you start

This code was written without a Flutter SDK available to compile or run it
against (this environment has no Flutter/Dart tooling and no access to
pub.dev). Every non-trivial package API used here (`camera`'s
`takePicture()`, `google_mlkit_pose_detection`'s `PoseDetectorOptions` /
`PoseLandmark` fields, `mobile_scanner`'s `onDetect`/`BarcodeCapture`) was
individually checked against current package documentation to minimize
the chance of a mismatch, but it has never actually been run. Budget for
the possibility of fixing a small error on first run — that's normal for
any first `flutter run`, not a sign something is fundamentally wrong.

## Fastest path: run it on web first

Before dealing with Android/iOS SDKs, emulators, and permissions, get it
running in a browser — same Flutter app, same backend, works from this
`mobile/` folder as-is:

```bash
cd mobile
flutter create --platforms=web .
flutter pub get
```

`flutter create` on a folder that already has `lib/` and `pubspec.yaml`
**repairs/adds missing platform scaffolding without touching your existing
code** (this is explicitly what the Flutter CLI's own help text describes)
— it just adds the `web/` folder needed to run in a browser. `--platforms=web`
means you don't need Android Studio or Xcode installed at all for this.

In a separate terminal, start the backend (see the top-level `README.md`
if you haven't already):

```bash
cd backend
npm install
cp .env.example .env      # Windows PowerShell: copy .env.example .env
npm run migrate
npm run seed
npm run dev
```

Then, back in `mobile/`:

```bash
flutter run -d chrome
```

It should open in Chrome and hit your locally running backend
automatically — `lib/api/api_client.dart` auto-detects web and points at
`localhost:4000` with no config needed.

**One real limitation on web:** the **Vision Coach** tab (camera-based rep
counting) won't work in a browser — Google's ML Kit pose detection library
has no web implementation at all, mobile-only. The screen will tell you
this clearly rather than silently failing. Everything else (auth,
onboarding, Today, Workout with equipment substitution, Diet with nearby
food, Gym check-in including QR scanning — `mobile_scanner` *does* support
web) works the same as on a phone.

Once this works, the native Android/iOS build (below) is the same code,
just targeting a different platform.

## Native Android/iOS build

## 1. Install Flutter

Follow [docs.flutter.dev/get-started/install](https://docs.flutter.dev/get-started/install)
for your OS. Then verify:

```bash
flutter doctor
```

Resolve anything it flags (Android toolchain / Xcode) before continuing.

## 2. Add the native platform scaffolding

If you already ran the web setup above, you can just add Android/iOS to
the same folder in place:

```bash
cd mobile
flutter create --platforms=android,ios --org com.yourname .
flutter pub get
```

Same as the web step — this only adds the missing `android/` and `ios/`
folders and does **not** touch your existing `lib/` or `pubspec.yaml`.
(If this is your first time running `flutter create` here, skip
`--platforms=web` and just include all three: `--platforms=android,ios,web`.)

## 3. Add permissions

**Android** — in `android/app/src/main/AndroidManifest.xml`, add inside
the `<manifest>` tag (above `<application>`):

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

Also set `minSdkVersion 23` or higher in `android/app/build.gradle`
(required by ML Kit pose detection).

**iOS** — in `ios/Runner/Info.plist`, add:

```xml
<key>NSCameraUsageDescription</key>
<string>Used to scan gym equipment and analyze exercise form.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Required by the camera plugin, even though this app doesn't record audio.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>Used to find nearby restaurants for your meal plan.</string>
```

## 4. Point the app at your backend

Web and the Android emulator already work with no changes (`lib/api/api_client.dart`
auto-detects web -> `localhost`, and defaults to `10.0.2.2` -> the
emulator's alias for your host machine's `localhost`). You only need to
edit anything for a **physical phone**: open `lib/api/api_client.dart` and
change `_physicalDeviceOrEmulatorBaseUrl` to your computer's LAN IP, e.g.
`http://192.168.1.23:4000` — find it via `ipconfig` (Windows) / `ifconfig`
or System Settings → Wi-Fi → Details (Mac) / `hostname -I` (Linux). Your
phone and computer must be on the same Wi-Fi network, and the backend
(`cd backend && npm run dev`) must be running.

## 5. Run it

With your phone connected via USB (with Developer Mode / USB debugging
enabled) or an emulator running:

```bash
flutter devices        # confirm your device is detected
flutter run
```

To get an installable file you can keep on your phone without staying
connected to a computer:

```bash
flutter build apk --release
# output: build/app/outputs/flutter-apk/app-release.apk
```

Transfer that `.apk` to your phone (email, cloud drive, USB) and open it
to install — you'll need to allow "install from unknown sources" once,
since it's not from the Play Store.

## What's here

```
lib/
  main.dart                        boot flow (auth -> onboarding -> home)
  api/api_client.dart               REST client, mirrors frontend/api.js
  theme/app_theme.dart              cream/mint design system, reusable widgets
  screens/
    auth_screen.dart                login / register
    onboarding_screen.dart          profile + equipment (chips or camera scan)
    home_shell.dart                 bottom nav across the 5 tabs
    today_screen.dart               dashboard summary
    workout_screen.dart             generate/view workout, swap exercises
    diet_screen.dart                nutrition plan + nearby food
    vision_screen.dart              camera rep counter (see note below)
    gym_screen.dart                 QR scan / manual check-in, one per day
    equipment_scan_screen.dart      shared camera->equipment-detection flow
```

## Vision screen implementation note

ML Kit's *live video stream* pipeline (raw `CameraImage` frames ->
`InputImage`, with per-platform pixel-format and sensor-rotation handling)
is the most fragile, most frequently-broken part of the Flutter camera/ML
Kit ecosystem — small mismatches here are the #1 cause of crashes in
real-world apps. Since this couldn't be tested against a device, the
vision screen instead takes rapid still photos (`takePicture()` ->
`InputImage.fromFilePath()`) in a loop — roughly 2-4 checks/second
depending on the device. You lose true 30fps smoothness and a live
skeleton overlay on the preview; you gain a much more stable,
well-documented code path. If you want true live-stream tracking later,
google_mlkit_pose_detection's example app has the reference
`CameraImage` -> `InputImage` conversion helper to swap in.

## Equipment vision + nearby food need the same backend setup

Camera-based equipment detection (Roboflow) and "find this near me"
(Places) both depend on the backend's `.env` configuration — see the
top-level `README.md`. Without those keys, the app still works and shows
an honest "not configured" message rather than fake data, matching the
web frontend's behavior exactly.

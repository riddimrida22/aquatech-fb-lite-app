# Aquatech Timesheets Mobile (iOS + Android)

This app is a native wrapper for the production timesheet experience:

- URL: `https://app.aquatechpc.com/?timesheet_only=1`
- Platform: Expo + React Native + WebView
- Targets: Apple App Store and Google Play Store

## Local Run

```bash
cd mobile-timesheet
npm install
npx expo start
```

## Build for Stores (EAS)

1. Install EAS CLI:

```bash
npm install -g eas-cli
```

2. Login and configure:

```bash
cd mobile-timesheet
eas login
eas build:configure
```

3. Create production builds:

```bash
eas build --platform ios --profile production
eas build --platform android --profile production
```

4. Submit to stores:

```bash
eas submit --platform ios --profile production
eas submit --platform android --profile production
```

## Store Metadata You Must Set

- App icon and splash assets.
- Privacy policy URL.
- Support URL.
- App Store/Play screenshots.
- App descriptions and age ratings.

## IDs used in this project

- iOS bundle ID: `com.aquatech.timesheets`
- Android package: `com.aquatech.timesheets`

If those IDs are already taken in your Apple/Google accounts, update them in `app.json` before building.

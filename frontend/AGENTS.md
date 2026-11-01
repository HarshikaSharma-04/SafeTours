# Expo SDK 54

This app uses **Expo SDK 54** (`expo ~54.0.x`, React Native 0.81). Use the docs for THAT version, not the latest:

https://docs.expo.dev/versions/v54.0.0/

- Install native modules with `npx expo install <package>` so versions match SDK 54.
- `expo-notifications` remote push and `expo-task-manager` / background location do not work in Expo Go: use an EAS development build.
- The `TextDecoder` Expo installs is UTF-8 only, and h3-js needs `utf-16le` as soon as it loads. `src/polyfills/textDecoder.js` adds it and must stay the first local import in `index.js`.
- Notification handler fields in SDK 54: `shouldShowBanner`, `shouldShowList` (not `shouldShowAlert`).

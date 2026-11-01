import { registerRootComponent } from 'expo';

// Must stay before everything below: h3-js crashes on load without it.
import './src/polyfills/textDecoder';

import './src/utils/expoGoLogs';

// Must be imported at the top level so the background task is defined in the global scope
// (expo-task-manager requirement); it also runs when the app is woken in the background.
import './src/utils/backgroundGeofence';

import App from './App';

registerRootComponent(App);

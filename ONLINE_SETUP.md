# Online setup

The new 2v2 entry point deliberately has placeholder configuration. It does not use the older project's `data_channel/firebase_config.js`. Until you supply your new Firebase Web app configuration, room creation displays a setup error.

## New Firebase project

1. Create a Firebase project and register a Web app. Copy its public Web app configuration.
2. In Authentication → Sign-in method, enable Anonymous sign-in. See [Firebase anonymous authentication](https://firebase.google.com/docs/auth/web/anonymous-auth).
3. Create a Cloud Firestore database. Publish the contents of `firestore.2v2.rules` in its Rules tab. These rules are intended for this new project's room schema. See [Firestore security rules](https://firebase.google.com/docs/firestore/security/get-started).
4. Replace the re-export in `src/resources/js/online_2v2/config.js` with your actual configuration, for example:

```js
export const firebaseConfig = {
  apiKey: 'YOUR_WEB_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  appId: 'YOUR_WEB_APP_ID',
};
```

Use your Firebase console's actual values. These are browser configuration values; never put service-account credentials here. Register your published domain in Authentication's authorized domains as required by your project settings.

Install dependencies with `npm ci`, then use `npm start` and open `/en/` or `/ko/`. A room code is required to discover a room; there is no public room directory. Guests must remain connected before the host starts the match. WebRTC needs HTTPS on a published site (localhost works for development).

## Connectivity

`src/resources/js/data_channel/rtc_configuration.js` supplies the existing STUN configuration. Add your TURN service to its `iceServers` if direct connections fail across restrictive networks. Use short-lived TURN credentials supplied by an appropriate backend for a public deployment; static browser code cannot keep a long-lived TURN password secret.

Four-browser rooms default to a full mesh (six connections); the host can choose a three-connection star instead. Two-browser local pairs always use one connection. Mesh lockstep sends inputs directly between every pair; star lockstep relays complete input frames through the host. Host-only physics uses host snapshots in either layout. Mesh control events use full simulation/RNG checkpoints; this can produce a small position correction. Changing topology returns everyone to the lobby and rebuilds links after an acknowledgment handshake. A guest-to-guest failure returns to the lobby for retry or a host-selected star layout; actual guest departures use AI. Host departure ends the room. Abrupt closure can leave stale Firestore documents because cleanup is best effort.

## Local Firestore rules tests

Install a Firebase CLI compatible with your Node version and Java, then run:

```powershell
firebase emulators:exec --project demo-pikavolley-2v2 --config firebase.2v2.json --only firestore,auth "node tests/firestore-rules.cjs"
```

This starts only local Auth/Firestore emulators, uses a demo project, and exercises real SDK transactions and allow/deny cases. It does not publish rules or contact your live Firestore database. See [Firebase emulator setup](https://firebase.google.com/docs/emulator-suite/install_and_configure).

## GitHub Pages

Run `npm run build` to produce `dist/`. `npm run deploy` runs that build and uses `gh-pages -d dist` to push the generated site to the current Git remote's `gh-pages` branch. **Check `git remote -v` first:** the repository's existing origin was `ilesejin/pikachu-volleyball-p2p-online`, which differs from the sibling folder name. Choose your intended remote before deploying.

In the intended GitHub repository, configure Pages to publish from `gh-pages` at `/` (root). The page is then `https://ilesejin.github.io/REPOSITORY/en/` or `/ko/`. GitHub Pages serves the frontend; your configured Firebase project handles signaling. Deploying the frontend does not install Firestore rules or enable Anonymous Authentication. No deployment is performed by the implementation or test commands.

## Optional Quick Match backend

The sibling `pikachu-volleyball-2v2-online-quick-match-server-main` server now implements this client's `/v1/match` protocol. It verifies Firebase tokens from the same project and reads advertised room documents using Admin SDK credentials. See its README for environment variables and deployment. It does not run physics or relay gameplay.

After deploying that server, edit `src/resources/js/online_2v2/quick_match_config.js`:

```js
export const quickMatchServerURL = 'https://YOUR_MATCHMAKING_SERVER';
```

For local development use `http://localhost:3000`. Published HTTPS pages need an HTTPS backend. The server's `ALLOWED_ORIGINS` must include your frontend origin (for example `https://ilesejin.github.io`, without the repository path). Rebuild the frontend after changing its configuration. Keep the matchmaking server at one instance while it uses an in-memory registry. Invitation rooms work independently when Quick Match is disabled.

To run the combined local browser/server integration tests, build with `npx webpack --config webpack.dev.js`, set `PIKA_QUICK_MATCH_SERVER` to the absolute sibling server directory, then run `npm run test:browser`. These tests use the actual server matchmaker/HTTP handler, a local signaling fixture, and real WebRTC, without live Firebase requests.

## Lobby and synchronization update (protocol v4)

Publish the current `firestore.2v2.rules` and update the Quick Match backend together with the frontend. The new rules allow unassigned lobby members, atomic free-slot selection/release, own-player name editing, and deny starting while a joined human is unassigned. Player names and slots are locked during matches. This uses `pikavolley-2v2-v4`; create new rooms after upgrading. Version-1/version-2/version-3 clients cannot join version-4 rooms. The Quick Match server and Firestore rules also need this protocol update; npm run deploy publishes only the frontend.

Separate tabs/windows in the same browser profile can join independently. Authentication uses a private in-memory anonymous session per page; reloading leaves the match and creates a new participant session. The duplicate-entry check only prevents joining twice from the same tab.

To verify the real Firebase Auth SDK's tab identity and token behavior locally:

```powershell
firebase emulators:exec --project demo-pikavolley-2v2 --config firebase.2v2.json --only auth "node tests/auth-tabs.cjs"
```

This uses a demo project and the local Authentication emulator, without reading the frontend's real Firebase configuration.

The v4 rules authorize signaling using the connection’s two endpoints and its network revision. Guest-to-guest links are allowed only in mesh rooms. Offers, answers and ICE have separate endpoint permissions; stale revisions are rejected. Publish these rules before using the updated frontend. Old connection paths are incompatible.

## Offline engine source

Keep the offline checkout at `../pikachu-volleyball-2v2`, or set `$env:PIKA_OFFLINE_ROOT='C:\path\to\pikachu-volleyball-2v2'` in PowerShell. Shared engine code is synchronized automatically before webpack builds and `npm test`; webpack watch also follows offline edits. Use `npm run sync:offline` to update the vendored snapshot and `npm run check:offline` for a read-only parity check. Commit `src/resources/js/offline_2v2/` and `offline-engine.manifest.json` together.

Without the default sibling checkout, a fresh clone or CI build verifies the manifest and builds the committed snapshot. It cannot fetch future offline edits automatically. A configured-but-missing source or a corrupt snapshot stops the build. Redeploy the frontend after engine changes; this synchronization does not publish anything or modify Firebase configuration.

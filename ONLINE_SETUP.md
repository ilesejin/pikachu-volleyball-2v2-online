# Online setup

The 2v2 entry point reads its Firebase Web app configuration from `src/resources/js/online_2v2/config.js`. Supply your project's configuration there; missing configuration causes room creation to display a setup error. The retired live P2P implementation and its configuration template have been removed. Legacy 1v1 replay playback requires no Firebase configuration.

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

## Signaling-only update (protocol v5)

Deploy these changes in this order:

1. Publish the complete `firestore.2v2.rules` in your Firebase project's Firestore Rules tab. It denies all retired `/rooms` access and permits authenticated v5 `/rendezvous` signaling. Do not replace it with the original public P2P rules.
2. Update/redeploy `pikachu-volleyball-2v2-online-quick-match-server-main`. Current clients use `/v2/match`; `/v1/match` now returns HTTP 410 (`CLIENT_VERSION_RETIRED`) with a reload instruction and never accesses Firestore. The v2 queue authenticates Firebase tokens but performs no Firestore reads or writes. Keep one server instance because advertisements and reservations are in memory.
3. Run `npm run deploy` in this online frontend repository. This builds and publishes the frontend only; it does not deploy rules or the matchmaking server. All participants should reload and create/join a new room after upgrading.

Older clients must reload the deployed frontend and create or join new rooms. Existing v4 rooms are not migrated. Publishing rules blocks their database access; it does not delete stored documents. Old documents can be removed separately using an administrator account after verifying they are no longer needed. These changes do not modify the original 1v1 P2P project. `npm run deploy` publishes the frontend only; it does not deploy server code or Firestore rules.

Firestore now stores only a small join entry (`schema`, `hostId`, `layout`, `status`) and temporary host/guest signaling. The host validates admission, names, free-slot changes, random assignment, readiness, settings, and start requests in memory and broadcasts authoritative lobby updates over reliable WebRTC channels. Guests cannot modify another participant or change host-only settings. Each browser still has its own anonymous identity, including separate tabs.

A guest reads the join entry and creates its own authenticated signaling request. After the host connection opens, it requests admission over WebRTC. Both endpoints acknowledge opening and finish pending candidate writes before the host removes the temporary offers, answers, candidates, and listeners. Only the three host links in a four-browser room use Firestore; guest-to-guest mesh signaling is relayed through the host over WebRTC. Pair rooms need one Firestore-assisted link. Topology changes keep host links open and rebuild guest links without Firestore signaling. The physics engine, lockstep and snapshot modes, checkpoint rules, and chat are unchanged.

Starting a match removes its join entry. Returning to the lobby recreates the same room code, so new guests can join again. Refreshing requires rejoining; host departure ends the room. Abrupt browser closure or a network failure can still leave temporary signaling/entries because cleanup is best effort. Older v4 rooms and v5 rooms cannot connect to each other.

The host keeps its request listener while the room is open, but unchanged listeners do not generate periodic document reads. Quick Match still sends HTTP heartbeats every two seconds; its v2 server keeps advertisements and capacity reservations in memory instead of fetching rooms from Firestore. Advertisements are advisory: the authenticated host makes the final admission decision, and the joining client checks that the advertised host matches the Firestore entry.

To verify the new rules locally:

```powershell
firebase emulators:exec --project demo-pikavolley-2v2 --config firebase.2v2.json --only firestore,auth "node tests/signaling-rules.cjs"
```

The compatibility command `tests/firestore-rules.cjs` runs the same current signaling tests, including denied access to retired rooms. No test or build command publishes to a live Firebase project.

## Connectivity

`src/resources/js/data_channel/rtc_configuration.js` supplies the existing STUN configuration. Add your TURN service to its `iceServers` if direct connections fail across restrictive networks. Use short-lived TURN credentials supplied by an appropriate backend for a public deployment; static browser code cannot keep a long-lived TURN password secret.

Four-browser rooms default to a full mesh (six connections); the host can choose a three-connection star instead. Two-browser local pairs always use one connection. Mesh lockstep sends inputs directly between every pair; star lockstep relays complete input frames through the host. Host-only physics uses host snapshots in either layout. Mesh control events use full simulation/RNG checkpoints; this can produce a small position correction. Changing topology returns everyone to the lobby and rebuilds links after an acknowledgment handshake. A guest-to-guest failure returns to the lobby for retry or a host-selected star layout; actual guest departures use AI. Host departure ends the room. Abrupt closure can leave stale Firestore documents because cleanup is best effort.

## Local Firestore rules tests

Install a Firebase CLI compatible with your Node version and Java, then run:

```powershell
firebase emulators:exec --project demo-pikavolley-2v2 --config firebase.2v2.json --only firestore,auth "node tests/firestore-rules.cjs"
```

This starts only local Auth/Firestore emulators, uses a demo project, and exercises real SDK signaling operations and allow/deny cases. It does not publish rules or contact your live Firestore database. See [Firebase emulator setup](https://firebase.google.com/docs/emulator-suite/install_and_configure).

## GitHub Pages

Run `npm run build` to produce `dist/`. `npm run deploy` runs that build and uses `gh-pages -d dist` to push the generated site to the current Git remote's `gh-pages` branch. **Check `git remote -v` first:** the repository's existing origin was `ilesejin/pikachu-volleyball-p2p-online`, which differs from the sibling folder name. Choose your intended remote before deploying.

In the intended GitHub repository, configure Pages to publish from `gh-pages` at `/` (root). The page is then `https://ilesejin.github.io/REPOSITORY/en/` or `/ko/`. GitHub Pages serves the frontend; your configured Firebase project handles signaling. Deploying the frontend does not install Firestore rules or enable Anonymous Authentication. No deployment is performed by the implementation or test commands.

## Optional Quick Match backend

The sibling `pikachu-volleyball-2v2-online-quick-match-server-main` server implements this client's `/v2/match` protocol. It verifies Firebase tokens from the same project using Google's public signing keys and keeps the queue in memory. No service-account JSON, Google Application Default Credentials, or Firebase Admin SDK is required. The retired `/v1/match` endpoint only returns HTTP 410; the server has no active Firestore access. See its README for environment variables and deployment. It does not run physics or relay gameplay.

After deploying that server, edit `src/resources/js/online_2v2/quick_match_config.js`:

```js
export const quickMatchServerURL = 'https://YOUR_MATCHMAKING_SERVER';
```

For local development use `http://localhost:3000`. Published HTTPS pages need an HTTPS backend. The server's `ALLOWED_ORIGINS` must include your frontend origin (for example `https://ilesejin.github.io`, without the repository path). Rebuild the frontend after changing its configuration. Keep the matchmaking server at one instance while it uses an in-memory registry. Invitation rooms work independently when Quick Match is disabled.

To run the combined local browser/server integration tests, build with `npx webpack --config webpack.dev.js`, set `PIKA_QUICK_MATCH_SERVER` to the absolute sibling server directory, then run `npm run test:browser`. These tests use the actual server matchmaker/HTTP handler, a local signaling fixture, and real WebRTC, without live Firebase requests.

## Independent browser tabs

Separate tabs/windows in the same browser profile can join independently. Authentication uses a private in-memory anonymous session per page; reloading leaves the match and creates a new participant session. The duplicate-entry check only prevents joining twice from the same tab.

To verify the real Firebase Auth SDK's tab identity and token behavior locally:

```powershell
firebase emulators:exec --project demo-pikavolley-2v2 --config firebase.2v2.json --only auth "node tests/auth-tabs.cjs"
```

This uses a demo project and the local Authentication emulator, without reading the frontend's real Firebase configuration.

## Offline engine source

Keep the offline checkout at `../pikachu-volleyball-2v2`, or set `$env:PIKA_OFFLINE_ROOT='C:\path\to\pikachu-volleyball-2v2'` in PowerShell. Shared engine code is synchronized automatically before webpack builds and `npm test`; webpack watch also follows offline edits. Use `npm run sync:offline` to update the vendored snapshot and `npm run check:offline` for a read-only parity check. Commit `src/resources/js/offline_2v2/` and `offline-engine.manifest.json` together.

Without the default sibling checkout, a fresh clone or CI build verifies the manifest and builds the committed snapshot. It cannot fetch future offline edits automatically. A configured-but-missing source or a corrupt snapshot stops the build. Redeploy the frontend after engine changes; this synchronization does not publish anything or modify Firebase configuration.

Page templates: edit `src/en/index.html`, `src/ko/index.html`, or `src/zh/index.html` for the English, Korean, or Traditional Chinese online UI. `npm run build` creates the corresponding language directories in `dist/`.

## Publishing client compatibility updates

Run `npm run deploy` from the online repository to build and publish the whole frontend, including root `version.json`. The version file and JavaScript must come from the same build. Its protocol and engine metadata are exchanged over WebRTC, so the Quick Match server and Firestore rules do not need changes for this feature.

Participants must reload after this first upgrade: pre-feature tabs cannot detect updates themselves. New clients reject older clients with missing compatibility metadata. Future stale tabs display an update notice and block new rooms/starts; active games are preserved. A failed version-file request blocks the attempted connection/start until a successful retry. Reloading retains local names and preferences. GitHub Pages propagation can briefly expose different release files; wait and reload if the update notice persists immediately after deployment.

## Manual host handoff

1. In the Firebase project used by `online_2v2/config.js`, open Firestore Database → Rules.
2. Replace the rules with this repository's updated `firestore.2v2.rules` and publish them. The only added rendezvous permission lets its current authenticated owner change `hostId` without changing other fields. Guests and outsiders cannot take ownership.
3. Deploy the rebuilt frontend and reload every participant before creating a room. No new configuration keys or service-account files are required, and the Quick Match server needs no additional change for this feature.
4. In a connected lobby, use **Make host / 방장 위임 / 移交房主** next to another participant. The former host remains in the same room. During transfer the lobby is temporarily locked; controls return when the new connections are ready.

The ownership update is atomic and keeps the same room code. A rejected write leaves the old host in place and displays an error. The new host receives the prior authoritative replay before ownership changes, and chat sequence numbers continue across the handoff. Host transfer is available only in the lobby, for solo and local-pair arrangements.

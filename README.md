# Pikachu Volleyball 2v2 Online

[한국어](README.ko.md) · [Firebase and deployment setup](ONLINE_SETUP.md)

The current offline 2v2 game, playable through WebRTC rooms. Choose four browsers with one player each, or two browsers with two local players each. English, Korean, and Traditional Chinese pages are included.

By default, every browser runs the preserved offline physics and AI in deterministic lockstep. Four-browser rooms default to a full mesh: six WebRTC connections, with each browser sending its own numbered inputs directly to the other three. All browsers wait for every participant’s inputs before simulating the frame with the same seeded randomness. The host can select a three-connection star instead, collecting inputs and relaying complete frames. A host-controlled setting also supports host-only physics, where guests send controls and display snapshots without simulating. Local-pair matches use one connection between their two browsers. The connection layout and physics mode are separate settings; host-only physics uses the host links even when mesh links are present. Firebase Anonymous Authentication identifies participants, and Firestore handles only room discovery and temporary guest-to-host signaling. The host manages lobby state over WebRTC and relays guest-to-guest mesh signaling over its existing connections. Gameplay inputs and snapshots do not pass through Firestore. Neither layout needs a dedicated game server.

Protocol v5 reduces Firestore usage: lobby changes do not write documents, Quick Match waiting does not poll Firestore, and successful connection setup deletes its temporary signaling. Starting removes the join entry; returning to the lobby recreates the same room code. Deploy the updated rules and Quick Match backend before the frontend; see [upgrade steps](ONLINE_SETUP.md#signaling-only-update-protocol-v5). The v4 Firestore lobby is retired: `/rooms` access is denied and `/v1/match` returns HTTP 410 with a reload message. Older clients must reload and create or join a new room.

## Playing

1. Configure your new Firebase project using [ONLINE_SETUP.md](ONLINE_SETUP.md), install dependencies, then run `npm start`.
2. Open `/en/` or `/ko/`, enter player names and choose the browser arrangement. Choose **With your friends → create room**, or use **Quick Match**.
3. Share the invitation link. Guests join the lobby without selecting a position.
4. Each browser selects an empty slot (solo) or an entire team (pairs) in the lobby. Selection can be cancelled or switched to another empty position. The host can press **Randomize positions** to reassign everyone in the lobby: solo players shuffle across P1–P4; local pairs take either P1+P2 or P3+P4 while keeping their local player order. Names and connections are preserved; remaining seats stay open for AI.
5. The host starts from **Game → Start / restart** once every joined human is assigned and connected. Remaining empty positions may use AI.

The host controls start/restart, pause, return to lobby, court width, serve mode, synchronization mode, game speed, and winning score. The interface uses the original P2P page, menu bar, Options submenus, theme switch, and chat bar. In the lobby, match options apply on the next start. During a match, the host confirms shared option changes in the original-style dialog. Speed and Practice mode apply immediately while preserving scores, serving rotation, the current rally and pause state. Changes to court width, serve mode, winning score or synchronization restart the match. In solo-browser rooms, a disconnected guest is replaced with AI and the room closes if the host leaves. Duo matches require two connected clients. If either duo leaves or disconnects during a match, the match ends and the remaining duo returns to the lobby. If the departing duo was the host, the remaining duo becomes host under the same room code, preserving its names, team and settings. This is lobby takeover, not migration of an ongoing match. Return to the lobby to admit new players.

The default court width is 340 per side. Fixed starting positions run P1–P2–P3–P4 from left to right; P4 serves first on the right. Teammates pass through one another. Computers use front/back midpoint zones determined by their round-start positions. The shared 2v2 AI forecasts attacks with the real collision rules, avoids net/own-side failures when a safe shot exists, and aims away from both defenders. Unsafe low smashes fall back to upward returns; original movement and collision helpers remain unchanged.

Serve choices:

1. Ball at the back; teammates alternate positions.
2. Fixed player positions; ball alternates above teammates (default).
3. Fixed player positions and ball above the back player.

## Controls

By default, one local player can use both arrows/Enter and R/D/F/G/V/Z (jump/left/down+toward-net/right/down/hit). Both key sets work simultaneously for the same player. For two local players, the first uses R/D/F/G/V/Z (jump/left/down+toward-net/right/down/hit), and the second uses arrows and Enter. The local controls panel can instead use the original slot-specific bindings:

| Slot | Jump | Left | Down      | Right | Hit   | Down-right   |
| ---- | ---- | ---- | --------- | ----- | ----- | ------------ |
| P1   | W    | A    | X         | D     | Z     | S            |
| P2   | Y    | G    | B         | J     | V     | H            |
| P3   | P    | L    | Semicolon | Quote | Comma | Down + Right |
| P4   | Up   | Left | Down      | Right | Enter | Down + Right |

Use the physical punctuation keys without Shift.

## Chat and in-game options

Press **Space** or click **Chat** to type a room-wide message. Press **Enter** to send, **Escape** to close, or **Disable chat** to suppress chat on this browser. All connected browsers receive messages in both the lobby and during play. In local pairs, each player has an editable name. Choose which local player speaks using **Chat as**. Names can be edited by their own browser in the lobby and follow local player order when switching teams. Messages use reliable WebRTC through the host; they are not stored in Firestore. The browser keeps the latest 100 messages while the room is open and displays temporary messages over the court. Solo-browser rooms split the court into four equal horizontal chat areas in P1–P2–P3–P4 order. Each assigned player’s message appears at a random position within their own quarter, with responsive wrapping and sizing to keep the bubble inside its area. The full message remains available in the chat log. Local pairs keep the original random side-based placement; unassigned players remain centered. Each message replaces that player’s previous message and uses a speech bubble only in menus/dialogs. The host sends the chosen coordinates so every browser sees the same placement; this randomness never uses the physics RNG.

**Options** restores Graphic (sharp/soft), BGM (on/off), SFX (stereo/mono/off), Speed, Winning score, and Practice mode submenus, plus Reset to defaults. Court / serve opens a matching dialog for width, serving rules, connection layout (six-link mesh by default or three-link star for four browsers), and physics synchronization: **All browsers (lockstep)** (default) or **Host only (snapshots)**. Switching synchronization during play requires confirmation and restarts the same lineup. Match options are host-only; graphics, sound, theme, and controls are local to each browser. During a match, shared option changes ask for confirmation. Speed and Practice mode keep the current match. Court/serve/score/physics changes restart the same lineup; connection-layout changes return everyone to the lobby. Mesh pauses, live changes and AI takeover use a host checkpoint containing complete simulation state and RNG state. This can make a small position correction; normal frame inputs are still exchanged directly. Star mode uses ordered frame-boundary controls. **Game** contains start/restart, pause/resume, and return to lobby; **Exit** leaves the room. Escape hides/shows the menu bar when no dialog is open. Practice mode uses the existing offline behavior: scoreboards are hidden and winning-score termination is disabled. Reset restores options while keeping player names and slot assignments.

## Replays

Use **Save replay** to download a `.txt` file (the original P2P extension; existing `.pvreplay` files are still supported) containing the whole current room session, including rematches and restarts. Saving does not reset the recording. **Auto-save on leaving** is enabled by default and its saved preference survives reopening the site; browser-close downloads are best effort. The last recording remains manually savable after disconnection until joining/creating another room.

Downloads use the original P2P FileSaver path without a site-provided save dialog. Browser-level download-location prompts still follow the browser settings. The viewer link is in the introduction and replay instructions, as in the original P2P page. The auto-save checkbox is in the pre-game Options section, and Save replay is beside Options above the court.

The host records the authoritative simulation. A guest can obtain that full recording with Save while the host is paused, finished, or in the lobby. The download uses a separate, buffered WebRTC data channel and stops if play resumes. During play or after losing the host, Save exports the guest's available local recording instead, clearly marked **partial**. Lockstep guests retain their local simulation; host-only guests retain received visual states. Joining late cannot recover earlier frames without the host copy. Guest auto-save uses the local recording.

The viewer uses four original-style arrow/Enter keypads with pressed-key highlighting and preserves the original controls: file selection/drag-and-drop, play/pause, seeking, 5 FPS / half / normal / double speed, custom FPS, input display, chat/name toggles, graphics and audio. English, Korean and Traditional Chinese are at `/en/replay/`, `/ko/replay/`, and `/zh/replay/`. The `/replay/` shortcut redirects to the English viewer. Slashless language URLs are normalized so relative viewer links resolve correctly; restart `npm start` after webpack configuration changes. Existing original P2P `.txt` replays keep their original 1v1 playback path, including their original IP-display option. New recordings contain no IP addresses.

2v2 playback records actual consumed inputs and random draws, settings, human/AI roles, chat positions, and state checkpoints every 150 simulated steps or at control/match boundaries. Seeking restores a nearby checkpoint and simulates the remaining inputs without sound. Lobby waits, network stalls, and real-time pauses are omitted from playback duration; their ordered settings/roster events remain in the file. Chat bubbles use recorded coordinates and assigned areas; older recordings without area metadata retain their original placement. Bubbles follow the live five-second fade in replay time, freeze while paused, and replace the previous message from the same local player. Seeking restores the same visible messages and fade progress as continuous playback. This does not change the shared physics or RNG outcomes and adds no Firestore operations.

The format includes an engine fingerprint and corruption checksum. A different shared-engine version is rejected rather than silently playing inaccurate physics; retain a matching viewer build for long-term archival. The checksum detects accidental damage, not proof of authorship. The file/transfer limit is 128 MiB. Seeking and replay downloads do not publish files to any server.

Run `npm run test:replay` to build the development viewer and run muted browser checks for exact lockstep/host-only states, intermediate seeking, multiple matches, both player arrangements, guest transfer/fallback, chat placement, auto-save and original 1v1 compatibility. `npm test` also checks the codec and that recording preserves RNG and input behavior.

## Implementation and physics preservation

- `src/resources/js/offline_2v2/`: copied offline game, rendering, audio, and physics.
- `src/resources/js/online_2v2/`: original P2P UI integration, lobby, authenticated Firestore signaling, WebRTC mesh/star connections, validated numbered frame inputs, deterministic lockstep, optional snapshot rendering, and room-wide chat.
- `src/resources/js/main_online_2v2.js`: current entry point. Older online/replay modules remain in the repository.
- `firestore.2v2.rules`: rules for the new Firebase project, with no public room listing and per-participant signaling access.

The original `physics.js` is unchanged in the copied core. The separate `doubles_physics.js` retains movement, ball collisions, and their existing quirks, adapting court geometry and four-player orchestration. Hits are processed in P1/P2/P3/P4 order with individual collision latches. This can make simultaneous overlapping hits order-dependent; it is intentionally preserved. The ball advances once per simulation step. Neither synchronization mode changes these physics rules. Lockstep uses the existing custom-RNG hook; no physics code is modified.

Lockstep never predicts missing inputs: slow or backgrounded browsers can stall the match until their input arrives or they disconnect. At most three input frames are pipelined; a disconnected guest’s players become AI with a synchronized checkpoint in mesh mode. Pause/resume discards queued inputs using a new generation number. In host-only mode, guests have no prediction or interpolation: a remote control must reach the host before its result returns in a snapshot. Internet latency and the selected simulation rate determine responsiveness; completion within one frame is not guaranteed. Existing STUN configuration may not connect every network; configure TURN for restrictive networks (see setup).

## Validation

- `npm test`: preservation, 2v2 behavior, lobby ownership, input validation, lockstep ordering/stalls/pause/disconnects, and snapshot tests.
- `npx webpack --config webpack.dev.js` then `npm run test:browser`: local real-WebRTC tests with four isolated browsers and two-browser local pairs. Requires Chrome and Node 22; optionally set `PIKA_CHROME` to its executable. Uses a local signaling fixture, not a live Firebase project.
- Firebase emulator tests and production/deployment steps are in [ONLINE_SETUP.md](ONLINE_SETUP.md).
- `npm run build`: production output in `dist/`. Building does not publish it.

## Credits

Original Windows game (1997): SACHI SOFT / SAWAYAKAN Programmers and Satoshi Takenouchi. JavaScript reverse engineering and original web/P2P implementation: [Kyutae Lee (gorisanson)](https://github.com/gorisanson/pikachu-volleyball), [original P2P project](https://github.com/gorisanson/pikachu-volleyball-p2p-online). This repository extends the offline 2v2 adaptation.

## Quick Match server

The sibling `pikachu-volleyball-2v2-online-quick-match-server-main` project now supports the new 2v2 lobby. Configure it with the same new Firebase project, then set `quickMatchServerURL` in `src/resources/js/online_2v2/quick_match_config.js` to its HTTPS origin. Quick Match is disabled while that URL is empty. No service-account JSON or Admin credentials are required; token verification uses Google's public keys. See the server README for project configuration, CORS, local running, and deployment.

Choose an arrangement and region, then press **Quick Match**. The first browser creates and advertises a room; later searches reserve browser capacity in that lobby. Everyone arrives unassigned and chooses a free slot or whole team there. The host may start early with AI. Running matches accept no new Quick Match players. To search again after a match, leave the room first. Invitation rooms continue to work without this server.

## Updating an existing deployment

The current protocol is `pikavolley-2v2-v5`. Publish the updated `firestore.2v2.rules`, deploy the Quick Match server, then deploy the frontend. Previous clients must reload and create or join fresh rooms. No live Firebase rules or server changes are published by the build or tests.

Separate tabs/windows in the same browser profile can join independently. Authentication uses a private in-memory anonymous session per page; reloading leaves the match and creates a new participant session. The duplicate-entry check only prevents joining twice from the same tab.

## Connection layout

For four solo browsers, the host selects **Full mesh · 6 connections** (default) or **Through host · 3 connections** in Options → Court / serve. With fewer browsers, only the necessary links are created; AI has no connection. Pair matches always need one link. All required links must be ready before starting. Changing layout during a match returns everyone to the lobby, preserving names and slots, and rebuilds connections after all browsers acknowledge the transition.

If a guest-to-guest link fails while both browsers still reach the host, everyone returns to the lobby; neither player is removed. The host can press **Retry connections** or select the three-link layout. An actual guest departure still replaces its players with AI. Host departure closes the room. Signaling documents include both endpoints and a network revision, so obsolete offers and ICE candidates cannot be used after a layout change.

## Keeping the offline engine synchronized

The sibling `../pikachu-volleyball-2v2` project is the source of truth for the shared engine. Online `npm start`, `npm run build` (including deploy), and `npm test` synchronize it automatically. The development server also watches the offline source and rebuilds when it changes. Direct webpack commands use the same synchronization plugin.

`npm run sync:offline` synchronizes immediately. `npm run check:offline` checks without changing files and fails if the copy has drifted. To use another checkout, set `PIKA_OFFLINE_ROOT` to its project directory before running these commands. Shared entry points and their relative imports are copied into `src/resources/js/offline_2v2/`; new imported helper modules are included automatically. Edit shared behavior in the offline project, since edits to the online copy are replaced by the next synchronization. Online entry points, lobby, networking and settings integration remain in their own files.

Commit the synchronized files and `offline-engine.manifest.json` together. If the default sibling checkout is absent, builds verify and use that bundled snapshot, so the online repository can build independently. A missing explicitly configured checkout, incomplete source, or a modified bundled snapshot fails instead of silently using stale code. Hashes ignore checkout line-ending differences. Published games get offline changes after rebuilding and deploying the frontend; they cannot read files from your local offline checkout.

Automated browser tests launch Chrome with audio muted.

Submitting an empty or whitespace-only chat closes the chat input without sending a message. Player position labels hide with the Game start! message by default. Use **Options → Player position labels → Always show** to keep them visible; this preference is saved locally and does not affect other players or restart the match. Clouds travel across the full configured court width.

The active page templates are `src/en/index.html`, `src/ko/index.html`, and `src/zh/index.html`. The build publishes them as `/en/`, `/ko/`, and `/zh/`; the old duplicate templates have been removed. Credits, related-version links, source links, release placeholders, and update-history pages match the offline 2v2 edition.

The default game speed is **Fast (30 FPS)**. Each browser remembers its first nickname using the original P2P `myNickname` localStorage key and its second local-player name using `mySecondNickname`. Names restore after reopening, including names saved in the lobby. Room membership and per-tab identity are not restored.

## Client updates and compatibility

Each build emits `version.json` and embeds the same build ID, protocol, and SHA-256 engine fingerprint in the client. The ID includes the Git revision and a content hash, so uncommitted source changes also produce a different build. The small build label appears below the connection status; its tooltip includes the engine fingerprint.

The client checks the deployed manifest at startup, periodically while visible, when returning to the tab, and before creating/joining rooms or starting/restarting a match. Checks bypass browser caching and use a unique query string. An outdated client shows **Reload to update** and blocks new admission/start; if the manifest cannot be checked, the attempted action fails with a retry message. Existing matches continue. Reloading from a room requires confirmation, leaves the room, and requests a fresh page without deleting saved names/settings.

WebRTC admission requires matching build, protocol and engine metadata, including all human participants before match start. Missing metadata from older v5 clients is rejected in both directions. Compatibility is a client consistency check, not anti-cheat protection. Already-open clients from before this feature cannot gain the check until reloaded. Publish the complete frontend build, including `version.json`, and ask everyone to reload and create/join fresh rooms for this upgrade. No server redeployment or Firestore rule changes are required; these checks add no Firestore operations.

Run the muted version integration checks after a development build with `$env:PIKA_VERSION_ONLY='1'; node tests/browser-online.cjs`. They use local signaling and version fixtures only.

## Ping and connection diagnostics

The lobby opens an original-style black diagnostics panel without a mandatory countdown. During play it collapses to a clickable ping indicator near the game menu. Five initial probes are spaced one second apart; later probes run every two seconds. Each connection retains up to ten RTT samples. The table shows their average and range, Direct/TURN/Unknown route, UDP/TCP when available, and missing/stale measurement status. Names and player positions identify browsers; local pairs share one link.

Four-browser mesh rooms report all six links, using small WebRTC summaries through the host for links this browser cannot measure itself. Star guest-to-guest paths are labelled Via host and are not assigned invented direct RTT values. In host-only physics, unused guest-to-guest links remain visible but do not affect the slowest-required-link indicator. Missing responses are not treated as zero ping or packet-loss percentages. Selected ICE statistics determine route labels; IP addresses are not displayed or shared.

Ping is an application round trip, including channel queues and browser scheduling, not exact keyboard-to-screen delay. A separate observer reports sustained missing-input waits (sampled every 100 ms, excluding pauses and ordinary pacing); star guests can identify waiting for a host frame, not which remote input the host lacks. Background tabs may respond slowly. Diagnostics do not affect physics/RNG, are excluded from replay recordings, and add no Firestore or Quick Match operations.

For muted local WebRTC checks, build development assets, set `$env:PIKA_DIAGNOSTICS_ONLY='1'`, and run `node tests/browser-online.cjs`.

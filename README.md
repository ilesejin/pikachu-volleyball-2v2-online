# Pikachu Volleyball 2v2 Online

[한국어](README.ko.md) · [Firebase and deployment setup](ONLINE_SETUP.md)

The current offline 2v2 game, playable through WebRTC rooms. Choose four browsers with one player each, or two browsers with two local players each. English and Korean pages are included.

By default, every browser runs the preserved offline physics and AI in deterministic lockstep. The host collects numbered inputs from each browser and relays the complete input frame; all browsers wait for that frame before simulating it, using the same seeded random sequence. A host-controlled setting also supports host-only physics, where guests send controls and display snapshots without simulating. Each guest connects directly to the host through a WebRTC data channel. Firebase Anonymous Authentication identifies participants, and Firestore handles rooms and WebRTC signaling. Gameplay inputs and snapshots do not pass through Firestore. Both modes use peer-to-peer networking with a host-to-guest star topology and no dedicated game server.

## Playing

1. Configure your new Firebase project using [ONLINE_SETUP.md](ONLINE_SETUP.md), install dependencies, then run `npm start`.
2. Open `/en/` or `/ko/`, enter player names and choose the browser arrangement. Choose **With your friends → create room**, or use **Quick Match**.
3. Share the invitation link. Guests join the lobby without selecting a position.
4. Each browser selects an empty slot (solo) or an entire team (pairs) in the lobby. Selection can be cancelled or switched to another empty position. The host can press **Randomize positions** to reassign everyone in the lobby: solo players shuffle across P1–P4; local pairs take either P1+P2 or P3+P4 while keeping their local player order. Names and connections are preserved; remaining seats stay open for AI.
5. The host starts from **Game → Start / restart** once every joined human is assigned and connected. Remaining empty positions may use AI.

The host controls start/restart, pause, return to lobby, court width, serve mode, synchronization mode, game speed, and winning score. The interface uses the original P2P page, menu bar, Options submenus, theme switch, and chat bar. In the lobby, match options apply on the next start. During a match, the host confirms shared option changes in the original-style dialog. Speed and Practice mode apply immediately while preserving scores, serving rotation, the current rally and pause state. Changes to court width, serve mode, winning score or synchronization restart the match. A disconnected guest is replaced with AI. If the host leaves, the room closes; host migration is not implemented. Return to the lobby to admit new players.

The default court width is 384 per side. Fixed starting positions run P1–P2–P3–P4 from left to right; P4 serves first on the right. Teammates pass through one another. Computers use front/back midpoint zones determined by their round-start positions.

Serve choices:

1. Ball at the back; teammates alternate positions.
2. Fixed player positions; ball alternates above teammates (default).
3. Fixed player positions and ball above the back player.

## Controls

By default, one local player can use both arrows/Enter and R/D/F/G/V/Z (jump/left/down-right/right/down/hit). Both key sets work simultaneously for the same player. For two local players, the first uses R/D/F/G/V/Z (jump/left/down-right/right/down/hit), and the second uses arrows and Enter. The local controls panel can instead use the original slot-specific bindings:

| Slot | Jump | Left | Down      | Right | Hit   | Down-right   |
| ---- | ---- | ---- | --------- | ----- | ----- | ------------ |
| P1   | W    | A    | X         | D     | Z     | S            |
| P2   | Y    | G    | B         | J     | V     | H            |
| P3   | P    | L    | Semicolon | Quote | Comma | Down + Right |
| P4   | Up   | Left | Down      | Right | Enter | Down + Right |

Use the physical punctuation keys without Shift.

## Chat and in-game options

Press **Space** or click **Chat** to type a room-wide message. Press **Enter** to send, **Escape** to close, or **Disable chat** to suppress chat on this browser. All connected browsers receive messages in both the lobby and during play. In local pairs, each player has an editable name. Choose which local player speaks using **Chat as**. Names can be edited by their own browser in the lobby and follow local player order when switching teams. Messages use reliable WebRTC through the host; they are not stored in Firestore. The browser keeps the latest 100 messages while the room is open and displays temporary messages over the court. Like the original, each message gets random coordinates on its sender’s side, replaces that player’s previous message, and uses a speech bubble only in menus/dialogs. The host sends the chosen coordinates so every browser sees the same placement; this randomness never uses the physics RNG.

**Options** restores Graphic (sharp/soft), BGM (on/off), SFX (stereo/mono/off), Speed, Winning score, and Practice mode submenus, plus Reset to defaults. Court / serve opens a matching dialog for width, serving rules, and physics synchronization: **All browsers (lockstep)** (default) or **Host only (snapshots)**. Switching synchronization during play requires confirmation and restarts the same lineup. Match options are host-only; graphics, sound, theme, and controls are local to each browser. During a match, shared option changes ask for confirmation. Speed and Practice mode keep the current match; other match options restart the same lineup. Live changes are synchronized at a shared frame boundary in lockstep mode. **Game** contains start/restart, pause/resume, and return to lobby; **Exit** leaves the room. Escape hides/shows the menu bar when no dialog is open. Practice mode uses the existing offline behavior: scoreboards are hidden and winning-score termination is disabled. Reset restores options while keeping player names and slot assignments.

## Implementation and physics preservation

- `src/resources/js/offline_2v2/`: copied offline game, rendering, audio, and physics.
- `src/resources/js/online_2v2/`: original P2P UI integration, lobby, authenticated Firestore signaling, WebRTC host connections, validated numbered frame inputs, deterministic lockstep, optional snapshot rendering, and room-wide chat.
- `src/resources/js/main_online_2v2.js`: current entry point. Older online/replay modules remain in the repository.
- `firestore.2v2.rules`: rules for the new Firebase project, with no public room listing and per-participant signaling access.

The original `physics.js` is unchanged in the copied core. The separate `doubles_physics.js` retains movement, ball collisions, and their existing quirks, adapting court geometry and four-player orchestration. Hits are processed in P1/P2/P3/P4 order with individual collision latches. This can make simultaneous overlapping hits order-dependent; it is intentionally preserved. The ball advances once per simulation step. Neither synchronization mode changes these physics rules. Lockstep uses the existing custom-RNG hook; no physics code is modified.

Lockstep never predicts missing inputs: slow or backgrounded browsers can stall the match until their input arrives or they disconnect. At most three input frames are pipelined; a disconnected guest is removed at a shared frame boundary and its players become AI. Pause/resume discards queued inputs using a new generation number. In host-only mode, guests have no prediction or interpolation: a remote control must reach the host before its result returns in a snapshot. Internet latency and the selected simulation rate determine responsiveness; completion within one frame is not guaranteed. Existing STUN configuration may not connect every network; configure TURN for restrictive networks (see setup).

## Validation

- `npm test`: preservation, 2v2 behavior, lobby ownership, input validation, lockstep ordering/stalls/pause/disconnects, and snapshot tests.
- `npx webpack --config webpack.dev.js` then `npm run test:browser`: local real-WebRTC tests with four isolated browsers and two-browser local pairs. Requires Chrome and Node 22; optionally set `PIKA_CHROME` to its executable. Uses a local signaling fixture, not a live Firebase project.
- Firebase emulator tests and production/deployment steps are in [ONLINE_SETUP.md](ONLINE_SETUP.md).
- `npm run build`: production output in `dist/`. Building does not publish it.

## Credits

Original Windows game (1997): SACHI SOFT / SAWAYAKAN Programmers and Satoshi Takenouchi. JavaScript reverse engineering and original web/P2P implementation: [Kyutae Lee (gorisanson)](https://github.com/gorisanson/pikachu-volleyball), [original P2P project](https://github.com/gorisanson/pikachu-volleyball-p2p-online). This repository extends the offline 2v2 adaptation.

## Quick Match server

The sibling `pikachu-volleyball-2v2-online-quick-match-server-main` project now supports the new 2v2 lobby. Configure it with the same new Firebase project, then set `quickMatchServerURL` in `src/resources/js/online_2v2/quick_match_config.js` to its HTTPS origin. Quick Match is disabled while that URL is empty. See the server README for credentials, CORS, local running, and deployment.

Choose an arrangement and region, then press **Quick Match**. The first browser creates and advertises a room; later searches reserve browser capacity in that lobby. Everyone arrives unassigned and chooses a free slot or whole team there. The host may start early with AI. Running matches accept no new Quick Match players. To search again after a match, leave the room first. Invitation rooms continue to work without this server.

## Updating an existing deployment

Selectable physics synchronization uses protocol `pikavolley-2v2-v3`. Update both the frontend and Quick Match server, and publish the updated `firestore.2v2.rules` before creating new rooms. Old version-1/version-2 rooms are not compatible; finish those games and create fresh rooms after upgrading. No live Firebase rules are published by the build or tests.

Separate tabs/windows in the same browser profile can join independently. Authentication uses a private in-memory anonymous session per page; reloading leaves the match and creates a new participant session. The duplicate-entry check only prevents joining twice from the same tab.

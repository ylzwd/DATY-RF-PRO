# MQTT.js 5.10.4

Local browser distribution with a reproducible FAshe timer-scope adapter (stability2).
No install or lifecycle scripts were executed. No protocol or stream implementation was rewritten.

- Source: https://unpkg.com/mqtt@5.10.4/dist/mqtt.min.js
- SHA-256: `0D5D035815D2A462E6EDF0F86AB91F7A5D563A36B40E9760E4EE452618F7C45E`
- License: MIT; original notice preserved in `LICENSE.md`.
- Retrieved 2026-09-12. The application no longer loads remote executable JavaScript at runtime.

`mqtt.upstream.min.js` contains the exact upstream bytes with the SHA above.
`mqtt.min.js` wraps those bytes in a lexical scope using `FasheNetworkTimers`.
Only this library's timers use the communication scheduler; global page timers are untouched.
Zero-delay stream/nextTick work uses MessageChannel; positive communication timers use a
same-origin dedicated worker. This removes the minute-long page timer dependency from
CONNECT, incoming packet dispatch, writes and timeout handling. It cannot keep a frozen
browser process or a sleeping/offline computer connected.

Rebuild: `node scripts/build-mqtt-scheduler.cjs`; verify: append `--check`.
Both operations verify the upstream SHA before accepting the generated artifact.
The original MIT and bundled license notices remain intact.

Credentials remain in page memory; a future native client must implement the same `daty-pairing-v1` boundary using platform TLS and an OS-protected secret store.

# XiaoC Voice Call Phase 0 — media checkpoint

Status: **Checkpoints A and B PASS. Phase 0 is PAUSED; next gate is Checkpoint C (STT).**

The A/B media foundation has completed its acceptance gate. The project is intentionally paused before adding STT, LLM, TTS, or barge-in behavior. The setup and test procedure below are retained as the Phase 0 implementation record; they are not the current blocker.

This is a media-only development probe. It receives and counts microphone frames
and sends a quiet generated tone (one second on, one second off). It does not echo
the microphone, call any model, write to Supabase, or persist audio/transcripts.
No production deployment or native build has been started.

## Adjustments to the Phase 0 request

- Keep the A → B → C → D → E → F → G gates. Do not implement STT/LLM/TTS until
  the iPhone media gate passes. Generation epochs and automatic barge-in belong
  to the later model checkpoint; they are not implemented or claimed here.
- Keep Persona/Relationship/Core intact in the later prompt; bound dynamic
  context instead of promising that the entire identity prompt is tiny.
- Distinguish track subscription/SDK completion from actual audible playback.
  No physical playback or speech-start latency is measurable from this probe.
  P50/P95 must remain N/A until independently observable endpoints exist.
- Use a separate development bundle ID (`com.hxj.xiaoc.voicepoc`) and a dedicated
  `voice-poc` EAS profile. Ordinary production configuration is unchanged.
- For A/B only, host the short `/session` bootstrap on this independent Worker.
  This avoids changing Vercel or deploying a production API merely to test media.
- The PoC app skips ordinary welcome/cloud-sync/push startup, and its ordinary
  API helper rejects production requests. The test page opens directly.
- Start with rtc-node, not the Agents framework: A/B only need raw media. Add
  Agents only if the next checkpoint benefits from it.

## Dependencies checked on 2026-09-06

Mobile remains Expo `~54.0.37`, React Native `0.81.5`, React `19.1.0`, expo-av
`~16.0.8`. Added exact versions:

| Package | Version |
| --- | --- |
| @livekit/react-native | 2.12.0 |
| @livekit/react-native-webrtc | 144.1.2 |
| livekit-client | 2.19.0 |
| @livekit/react-native-expo-plugin | 1.0.2 |
| @config-plugins/react-native-webrtc | 13.0.0 |
| expo-dev-client | 6.0.21 |

Worker: `@livekit/rtc-node@0.13.34`, `livekit-server-sdk@2.18.0`.
No expo-audio and no second upstream react-native-webrtc.

Evidence:
- [Expo SDK 54](https://docs.expo.dev/versions/v54.0.0/)
- [Config plugin compatibility table](https://github.com/expo/config-plugins/tree/main/packages/react-native-webrtc)
- [LiveKit Expo setup](https://docs.livekit.io/transport/sdk-platforms/expo/)
- [LiveKit 2.12 release](https://github.com/livekit/client-sdk-react-native/releases)

The plugin table maps Expo 54 to plugin 13. LiveKit 2.12 declares WebRTC ^144.1.2
and client ^2.19.0. These package constraints and Expo config resolve locally.
This is NOT proof of the complete iOS combination: the table's upstream WebRTC
version is different from LiveKit's fork. Native compilation and hardware remain
the acceptance gate. Do not upgrade Expo to satisfy a newer plugin.

## Required user setup

### 1. LiveKit test project

1. Sign in at [LiveKit Cloud](https://cloud.livekit.io/) and create a separate
   project, for example `xiaoc-voice-poc`. No telephony or model inference setup
   is needed for this checkpoint.
2. Locate the project's WebSocket URL and API key/secret. Configure them ONLY
   in the repository root `.env.local` (ignored by Git), or the test Worker host's
   secret settings. Do not paste secrets in chat or configure them as Expo public
   variables. Do not reuse a production project.
3. Generate a separate random development bootstrap password (at least 32
   characters) in a password manager. Store it as `VOICE_POC_BOOTSTRAP_TOKEN`.
   This is test access authentication, not a provider API key. Enter it locally
   in the PoC page when connecting; the page does not persist it.

Required Worker variable names (values intentionally omitted):

```text
VOICE_POC_ENABLED=true
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
VOICE_POC_BOOTSTRAP_TOKEN
```

Optional: `VOICE_POC_HOST` (default 127.0.0.1), `VOICE_POC_PORT` (default 8788).
The Worker deliberately refuses `NODE_ENV=production`. No LLM/STT/TTS keys are
needed yet. Missing config fails closed without printing values.

### 2. Register the iPhone with EAS

From `/Users/hxj/Documents/memory-api/mobile/XiaoC`, use the existing EAS CLI:

```sh
eas device:list
eas device:create
```

If the phone is not listed, select the website/QR registration method, open the
generated link in Safari on that iPhone, and follow the device registration
steps. TestFlight installation does not register an ad-hoc development device.
Do not send the UDID or Apple credentials in chat.

Once registration is complete, build interactively so the new device is included:

```sh
eas build --platform ios --profile voice-poc
```

Approve the separate PoC app identifier/provisioning profile in EAS's flow.
Install using the development build link, NOT TestFlight. Enable iPhone Developer
Mode if prompted. No Production build or submit command is needed.

If `eas` is not on PATH, the existing local CLI discovered during investigation is:
`/Users/hxj/.npm/_npx/6bc7bae5c2059953/node_modules/eas-cli/bin/run`
(invoke with `node`; npm cache paths can change).

[Official internal distribution instructions](https://docs.expo.dev/build/internal-distribution/)

### 3. Run the media probe after those prerequisites

Worker, from `/Users/hxj/Documents/memory-api/services/voice-call`:

```sh
npm run start:local
```

Expose this local Worker through an authenticated test HTTPS reverse proxy/tunnel,
or deploy it to a separate test host. A public HTTPS address is required by the
phone client; localhost on the phone is not this Mac. No tunnel or cloud Worker
has been provisioned by this change. Choose/configure that route before testing.

Metro, from `/Users/hxj/Documents/memory-api/mobile/XiaoC`:

```sh
EXPO_NO_DOTENV=1 XIAOC_VOICE_POC_BUILD=1 npx expo start --dev-client
```

This intentionally avoids loading ordinary .env files. Open the Metro project
in the PoC development client. The app should open the test page directly.
Enter the HTTPS Worker address and the test bootstrap password locally. The
Worker returns a 60-second room-scoped credential, never its LiveKit secret.

## Checkpoint B procedure — user assisted, no fabricated measurements

1. Start at low volume. Grant microphone access. If the iOS permission dialog
   interrupts the app, grant permission and start again (no automatic mic resume).
2. Verify the remote test tone is audible while speaking continuously. Verify
   Worker frame/audio-duration counters grow at the same time.
3. Test system/earpiece routing, forced speaker and AirPods. Check that the
   selected route is physically the one heard; the button alone is not evidence.
4. During tone playback, compare microphone meter activity during silence and
   speech. Sustained output-driven input or audible feedback fails the gate.
   A tone is only a basic media test; speech-echo tests must be repeated with TTS.
5. Mute: the microphone track must stop, and the system microphone indicator
   must clear. Unmute must publish again. Verify on hardware.
6. Test hangup, page exit, background, lock, network loss and system phone-call
   interruption. Check the iOS indicator and LiveKit participant departure.
7. Run for 5–10 minutes and record iPhone/iOS/build/network/route and observed
   outcome. Do not record or upload private audio.

The initial probe terminates on reconnect rather than resuming an unverified
microphone state. Native interruption/route behavior and physical output drain
are still unverified. Do not claim local VAD, barge-in or playback timing from
LiveKit's server speaker updates or remote-track subscription events.

## Verification and current status

Local checks: targeted mobile/voice tests, Worker control/auth/lifecycle tests,
native Worker in-memory audio frame smoke test, mobile TypeScript, Expo config
resolution, `git diff --check`, API function count. The Worker smoke test checks
the Mac SDK binding only; it is not a network or iPhone audio test.

Recorded results on baseline `664b65a`: mobile/voice targeted tests **34/34**,
Worker tests **6/6**, mobile `tsc --noEmit` passed, Worker syntax passed,
`git diff --check` passed, **12 API Functions**. Expo prebuild-config resolution
passed; `expo install --check` used the local SDK map in offline mode, so it is
not an independent online/native compatibility certification. No full project
audit, EAS build, production calls, database changes, commit or push was done.

| Checkpoint | Status |
| --- | --- |
| A dependencies + skeleton + runnable development build | PASS |
| B true iPhone duplex | PASS |
| C STT | NOT STARTED; next checkpoint |
| D LLM | NOT STARTED, waiting for C |
| E MiniMax | NOT STARTED, waiting for D |
| F automatic barge-in/epoch cancellation | NOT STARTED, waiting for E |
| G full voice conversation + measured P50/P95 | NOT RUN |

**PAUSED after Checkpoint B.** Resume only with an explicit Checkpoint C scope.
Passing A/B authorizes evaluation of STT next; it does not implicitly authorize
LLM, TTS, automatic barge-in, production deployment, or later checkpoints.

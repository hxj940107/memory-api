# XiaoC Private iOS Release

## Security rollout order

Private API authentication is deliberately fail-open until the production flag is enabled. Keep this order so the currently installed development client is not locked out.

1. Generate one random token of at least 32 bytes. Never commit it.
2. Set the same value as `XIAOC_APP_TOKEN` in Vercel Production and as `EXPO_PUBLIC_XIAOC_APP_TOKEN` in the EAS `preview` environment.
3. Deploy the backend with `XIAOC_APP_AUTH_ENABLED` missing or `false`.
4. Build and install the `preview` iOS app. Confirm chat, history, settings, images, Push registration, and proactive worker execution.
5. Set Vercel Production `XIAOC_APP_AUTH_ENABLED=true` and redeploy.
6. Confirm an authenticated App request succeeds, an unauthenticated request returns `401`, and Vercel Cron continues to execute with `CRON_SECRET`.

`EXPO_PUBLIC_XIAOC_APP_TOKEN` is embedded in the private binary. It protects the public API from casual unauthenticated access but is not hardware attestation. This tradeoff is intentional for one privately distributed device. Rotate both environment values and rebuild the App if the device or IPA is exposed.

## Push rollout order

1. Apply `supabase_push_notifications.sql`.
2. Let EAS create or reuse the Apple Push Notification key during the first iOS build.
3. Install the build on the registered iPhone and enable notifications in XiaoC Settings.
4. Verify `user_state.push_token_updated_at` is populated without logging the token itself.
5. Trigger one eligible proactive message and verify the persisted assistant message contains `metadata.pushNotification` with an Expo ticket or an explicit rejection reason.
6. Test visible-preview and private-preview modes, notification tap routing, foreground behavior, and duplicate task replay.

## Face ID checks

1. Set a six-digit fallback password, then enable Face ID in Settings.
2. Verify cold launch, cancellation to password, successful biometric unlock, and return after more than 60 seconds in the background.
3. Verify the app switcher shows the privacy cover rather than conversation content.
4. Verify a notification tap cannot bypass unlock and opens its conversation after authentication.

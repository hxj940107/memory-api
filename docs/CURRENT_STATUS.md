# XiaoC Current Status

## Current Phase

XiaoC is in an early mobile-first stabilization phase.

The main goal is not to add many features, but to make the core companion loop feel stable, continuous, and personal:

- Chat should be reliable.
- Conversation history should be easy to restore and browse.
- Memory should help XiaoC understand the user, not store everything.
- Mobile experience is the priority.
- Web remains a historical prototype.

## Product Direction

XiaoC is a private, single-user AI companion.

Do not design for multi-user switching, teams, organizations, SaaS, billing, or public product workflows unless the project direction is explicitly changed.

The highest principle is Experience First. Every change should be judged by whether it makes XiaoC feel more continuous, familiar, trustworthy, and emotionally present.

## Current Architecture Snapshot

- Root project: Vercel-style API and historical web prototype.
- `api/`: chat, history, conversation, summary, memory-related endpoints.
- `lib/`: centralized AI/model/context configuration and shared helpers.
- `prompt/system.md`: XiaoC identity, relationship continuity, and speaking style.
- `mobile/XiaoC/`: Expo React Native mobile app, currently the primary experience.

## Main Working Areas

1. Stabilize mobile chat.
2. Keep conversation restore/history reliable.
3. Improve memory quality and context selection.
4. Control token and external model call cost.
5. Keep configuration centralized.
6. Avoid large refactors unless they clearly reduce risk.

## Known Risks

- Memory judging logic exists in multiple places and may drift.
- `api/chat.js` currently owns many responsibilities and may need small, careful extraction over time.

## Attribution Boundary

- `user_id` means the single user's data space.
- Message authorship is represented by `role`: `user` is the user, `assistant` is XiaoC.
- `small_c`/XiaoC should be treated as companion identity, not as the default `user_id`.
- Summaries and memories must not turn XiaoC's own words into user facts.

## Development Notes For Future Codex Sessions

Before making code changes, read:

- `AGENTS.md`
- `docs/PRODUCT_VISION.md`
- `docs/DEVELOPMENT_PRINCIPLES.md`
- `docs/CURRENT_STATUS.md`
- `docs/MOBILE_UI_DIRECTION.md` when changing mobile UI or product modules

When switching computers or Codex tasks, use Git as the source of truth:

- Pull before starting work.
- Commit and push before switching machines.
- Use clear commit messages, especially for WIP work.

Prefer small, reversible changes that protect XiaoC's continuity, memory, and mobile chat experience.

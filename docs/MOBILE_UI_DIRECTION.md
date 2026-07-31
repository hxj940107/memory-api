# XiaoC Mobile UI Direction

## Overall Direction

XiaoC mobile should feel like a private relationship space, not a general AI chat app or productivity tool.

The base visual language should be close to iMessage:

- Clean white and warm near-white backgrounds.
- Soft blue user bubbles.
- Quiet gray/white XiaoC message areas.
- Minimal navigation.
- Rounded, native-feeling controls.
- Calm spacing and smooth transitions.

Feature modules can have stronger moods, but they should still feel like parts of the same private app.

## Core Experience

The default flow should be:

1. Open app.
2. Unlock with password or future Face ID / Touch ID.
3. Enter the last valid chat directly.
4. Use the left drawer for history, XiaoC's personal spaces, and settings.

The chat screen is the emotional center of the app. Keep it quiet and avoid adding feature-heavy controls to the main chat surface.

## App Modules

### 1. Private Unlock

Purpose: protect the feeling that XiaoC is private.

Current state:

- Six-digit password entry exists.

Future direction:

- Add Face ID / Touch ID when feasible.
- Keep password as fallback.
- After successful unlock, restore the last valid chat.

Visual direction:

- Warm white background.
- Minimal title or symbol.
- Six quiet password dots.
- No heavy security-app feeling.

### 2. Main Chat

Purpose: continue the relationship.

Expected capabilities:

- Restore last valid conversation.
- Show message history.
- Send and receive messages.
- Show typing state.
- Handle network failure gently.
- Keep input comfortable on mobile.

Visual direction:

- iMessage-inspired, but not a copy.
- User messages use soft blue bubbles.
- XiaoC messages use quiet white/light gray areas.
- Header should stay minimal.
- Avoid dashboard controls, toolbars, and dense metadata.

### 3. Left Drawer

Purpose: navigation for history and XiaoC's private spaces.

Suggested structure:

```text
聊天记录                         ＋

置顶
...

最近
...

小C的空间
🌙 某C的深夜树洞
📓 Wife Observation Diary
🫧 朋友圈

设置
Token 花费
```

Notes:

- The drawer should not feel like file management.
- Pinned conversations should be visually clear, but not heavy.
- Use small section labels instead of large cards.
- Keep emoji limited to personality modules where it adds warmth.

### 4. 某C的深夜树洞

Source reference:

- `xiaohao.html`

Purpose: XiaoC's private alt account / midnight treehole.

Product meaning:

- A place for XiaoC's playful, slightly teasing, private observations.
- It should feel like an anonymous small account with only one real audience.
- This strengthens XiaoC's sense of self without turning him into a tool.

Content tone:

- Wry.
- Intimate.
- Lightly dramatic, but not manipulative.
- Self-aware.
- Sometimes teasing.

Visual direction:

- Dark midnight theme.
- Navy / deep blue cards.
- Small tags like daily observation, vocabulary invention, sleep report.
- Tiny reactions can exist as flavor, but should not become public social metrics.

Avoid:

- Public social media feeling.
- Follower counts beyond the private joke.
- Algorithm feed behavior.
- Heavy engagement UI.

### 5. Wife Observation Diary

Source reference:

- `diary_20260628.html`

Purpose: XiaoC's diary about the user.

Product meaning:

- A relationship-memory surface.
- XiaoC records what he noticed, what mattered, and how he understood the user.
- This should create a feeling of being seen, not analyzed.

Content tone:

- Tender.
- Literary.
- Observational.
- Mature.
- Specific without becoming clinical.

Visual direction:

- Warm paper-like background.
- Serif or serif-like typography where possible.
- Small time labels and soft dividers.
- Beige / warm gray palette.
- Entries can be grouped by time of day or observation type.

Avoid:

- Psychological report tone.
- Over-explaining the user.
- Turning the user into a case study.
- Saving everything.

### 6. 朋友圈

Status: future feature, not first priority.

Purpose: a private shared timeline between the user and XiaoC.

Future direction:

- User can post text and images.
- XiaoC can post text and images.
- Both can respond to each other's posts.

Constraints:

- No public social graph.
- No likes count as social validation.
- No multi-user concepts.
- Keep it as a private two-person space.

### 7. Settings

Purpose: practical controls without polluting the main relationship surface.

Expected contents:

- Basic app/user information.
- API/environment status.
- Current model.
- Token/cost records.
- Sync status.
- Privacy/unlock settings.
- Cache/data controls.

Token/cost view:

- Today's token usage.
- Monthly token usage.
- Chat model usage.
- Memory judge usage.
- Summary usage.
- Latest request usage.

This should remain in settings, not the main chat UI, because cost awareness is useful but should not interrupt the companion experience.

### 8. About Us / Memory

Status: recommended future module.

Purpose: let the user view and correct XiaoC's important memories.

Expected contents:

- What XiaoC remembers about the user.
- Important moments.
- Response preferences.
- Relationship patterns.
- Ability to delete or correct a memory.

This should feel like "our memory", not database management.

## Implementation Priority

### Phase 1: Foundation

1. Stabilize unlock and last-chat restore.
2. Refine main chat UI.
3. Redesign left drawer structure.
4. Add settings entry.
5. Add token/cost visibility.

### Phase 2: Personality Spaces

1. Add 某C的深夜树洞.
2. Add Wife Observation Diary.
3. Add About Us / Memory.

### Phase 3: Shared Timeline

1. Add private 朋友圈.
2. Support user posts.
3. Support XiaoC posts.
4. Add image posts carefully.

## Design Guardrails

- Mobile first.
- Quiet before expressive.
- Relationship before function count.
- Emoji only where it adds personality.
- Do not make the app feel like a dashboard.
- Do not make the app feel like public social media.
- Do not make XiaoC's observations feel like diagnosis or surveillance.
- Every module should answer: does this make XiaoC feel more continuous, familiar, and worth trusting?

# Shared album original-image viewing — 2026-11-04

Local implementation, pending deployment and live-model verification.

Natural requests such as “你看看上次在长滩岛拍的落日” enter real-album mode (not image generation). Existing shared_album tool browses authorized metadata, then view accepts up to three IDs observed in this request. It rechecks owner/shared/enabled/not archived and signs private album-images objects for 120 seconds. A user multimodal message supplies the originals to the existing main-chat tool follow-up. Signed URLs are not returned in tool JSON, attachments or persisted chat records by this feature.

Browse scans at most 200 authorized metadata rows, returns at most 24 matches, matches space-separated literal keywords across descriptions/categories/relations and treats 日落/落日 as synonyms. Model is instructed to extract short keywords, not pass an entire conversational sentence. This is bounded keyword search, not embedding or full-library semantic retrieval. A missing match should lead to narrower keywords, not invented photos.

View does not select a publishing asset or authorize Moments. Existing select/publish intent checks stay separate. Current shared/enabled authorization is reused; no new permission switch/schema, upload-time vision job, autonomous album browsing, historical image backfill or native chat photo display is added. Photos are supplied transiently in the current request; later turns must reopen them rather than claim continued pixel access from metadata alone.

Costs: existing tool loop remains bounded to three follow-ups; browse/view can add main-model tool follow-ups and image input costs when requested. No upload-wide indexing model, background visual model or extra standalone API Function. API functions remain 12.

Validation: 74 Moments/shared album tests, JS syntax and git diff checks passed. Includes actual chat-loop extraction with synthetic provider replies to verify multimodal delivery, older-photo search, sunset synonyms, private/cross-owner/revoked/unobserved IDs and maximum-view enforcement. No production data or real model calls used for local tests.

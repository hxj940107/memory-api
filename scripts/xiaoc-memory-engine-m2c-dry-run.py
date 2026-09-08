#!/usr/bin/env python3
"""Offline, deterministic M2C legacy shadow-import rehearsal.

This program reads the verified M0 archive, writes a content-free mapping manifest,
and never connects to Railway, Supabase, Ombre, or an embedding provider.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import tarfile
import unicodedata
import uuid
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any


EXPECTED_ARCHIVE_SHA256 = "a96b8d211899e6a00dbcd40d42639293fb7ddc0a31a1430f44866e44876d3178"
LEGACY_UUID_NAMESPACE = uuid.UUID("f1c7e436-ff13-5d2c-8e4a-5de7386b6db7")
IDENTITY_USER_ID = "user"
SOURCE_SYSTEM = "ombre"
POLICY_VERSION = "xiaoc-legacy-shadow-dry-run-v1"
CANONICAL_GROUPS = {"permanent", "dynamic", "feel", "archive"}
LOW_RISK_DYNAMIC_DOMAINS = {"创作", "游戏", "兴趣", "编程", "学习", "饮食", "手工"}
HIGH_RISK_OR_AMBIGUOUS_DOMAINS = {
    "AI", "恋爱", "情绪", "心理", "财务", "工作", "人际", "家庭",
    "友谊", "计划", "出行", "未分类",
}
REQUIRED_METADATA = {
    "activation_count", "arousal", "created", "domain", "id", "importance",
    "last_active", "name", "tags", "type", "valence",
}
ID_RE = re.compile(r"^[0-9a-f]{12}$")
FILENAME_ID_RE = re.compile(r"(?:^|_)([0-9a-f]{12})\.md$")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_scalar(raw: str) -> Any:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "~", ""}:
        return None
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(part) for part in inner.split(",")]
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def parse_markdown_record(raw: bytes) -> tuple[dict[str, Any], bytes]:
    text = raw.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValueError("FRONTMATTER_MISSING")
    metadata: dict[str, Any] = {}
    closing_index = None
    for index, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            closing_index = index
            break
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$", line)
        if match:
            key, raw_value = match.groups()
            metadata[key] = raw_value.strip("'\"") if key == "id" else parse_scalar(raw_value)
    if closing_index is None:
        raise ValueError("FRONTMATTER_UNTERMINATED")
    body = "".join(lines[closing_index + 1 :]).encode("utf-8")
    if not body.strip():
        raise ValueError("CONTENT_EMPTY")
    return metadata, body


def normalized_content_hash(body: bytes) -> str:
    text = body.decode("utf-8")
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return sha256_bytes(normalized.encode("utf-8"))


def deterministic_memory_id(user_id: str, source_system: str, legacy_external_id: str) -> str:
    identity = "\x1f".join((user_id, source_system, legacy_external_id))
    return str(uuid.uuid5(LEGACY_UUID_NAMESPACE, identity))


def valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def classify(group: str, domain: str, metadata: dict[str, Any]) -> tuple[str, str, str, list[str]]:
    reasons = ["LEGACY_UNVERIFIED", "NO_NATIVE_PROVENANCE", f"SOURCE_GROUP_{group.upper()}"]
    if group == "archive":
        return "archived", "disabled", "none", reasons + ["SOURCE_ARCHIVED", "ORDINARY_RETRIEVAL_DISABLED"]
    if metadata.get("resolved") is True:
        return "active", "disabled", "none", reasons + ["EXPLICIT_RESOLVED_HINT", "ORDINARY_RETRIEVAL_DISABLED"]
    if metadata.get("pinned") is True:
        return "active", "shadow_only", "none", reasons + ["LEGACY_PIN_REVIEW_REQUIRED", "NO_NATIVE_PIN_PROMOTION"]
    if group == "permanent":
        return "active", "shadow_only", "none", reasons + ["LEGACY_PERMANENT_HIGH_AUTHORITY_REVIEW"]
    if group == "feel":
        return "active", "shadow_only", "none", reasons + ["SENSITIVE_AFFECTIVE_CONTEXT_REVIEW"]
    if group == "dynamic" and domain in LOW_RISK_DYNAMIC_DOMAINS:
        return "active", "low_authority", "legacy_limited", reasons + ["LOW_RISK_DYNAMIC_DOMAIN", "STRONG_RELEVANCE_REQUIRED"]
    if group == "dynamic" and domain in HIGH_RISK_OR_AMBIGUOUS_DOMAINS:
        return "active", "shadow_only", "none", reasons + ["HIGH_RISK_OR_AMBIGUOUS_DOMAIN_REVIEW"]
    return "active", "shadow_only", "none", reasons + ["UNKNOWN_DOMAIN_FAIL_CLOSED"]


def build_manifest(archive: Path) -> dict[str, Any]:
    archive_hash = sha256_file(archive)
    if archive_hash != EXPECTED_ARCHIVE_SHA256:
        raise RuntimeError(f"SNAPSHOT_SHA256_MISMATCH:{archive_hash}")

    entries: list[dict[str, Any]] = []
    parse_failures = 0
    identity_failures = 0
    seen_ids: set[str] = set()
    normalized_groups: dict[str, list[int]] = collections.defaultdict(list)

    with tarfile.open(archive, "r:gz") as bundle:
        members = sorted(bundle.getmembers(), key=lambda item: item.name)
        for member in members:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.suffix != ".md" or path.name.startswith("._"):
                continue
            parts = path.parts
            if len(parts) < 3 or parts[1] not in CANONICAL_GROUPS:
                continue
            relative_path = str(PurePosixPath(*parts[1:]))
            group = parts[1]
            domain = parts[2] if len(parts) > 3 else "未分类"
            raw = bundle.extractfile(member).read()
            reasons: list[str] = []
            try:
                metadata, body = parse_markdown_record(raw)
            except (UnicodeDecodeError, ValueError) as error:
                parse_failures += 1
                metadata, body = {}, raw
                reasons.append(str(error))

            external_id = str(metadata.get("id") or "").strip().lower()
            filename_match = FILENAME_ID_RE.search(path.name)
            identity_valid = bool(
                ID_RE.fullmatch(external_id)
                and filename_match
                and filename_match.group(1) == external_id
                and external_id not in seen_ids
            )
            if not identity_valid:
                identity_failures += 1
                reasons.append("IDENTITY_INVALID_OR_AMBIGUOUS")
            else:
                seen_ids.add(external_id)

            missing_metadata = sorted(REQUIRED_METADATA.difference(metadata))
            timestamps_valid = valid_timestamp(metadata.get("created")) and valid_timestamp(metadata.get("last_active"))
            structure_valid = not reasons and not missing_metadata and timestamps_valid
            content_hash = sha256_bytes(body)
            memory_id = deterministic_memory_id(IDENTITY_USER_ID, SOURCE_SYSTEM, external_id) if identity_valid else None

            if not structure_valid:
                lifecycle, retrieval, authority = "active", "quarantined", "none"
                reasons.extend(["STRUCTURE_INVALID", "ORDINARY_RETRIEVAL_QUARANTINED"])
                if missing_metadata:
                    reasons.append("REQUIRED_METADATA_MISSING")
                if not timestamps_valid:
                    reasons.append("TIMESTAMP_INVALID")
            else:
                lifecycle, retrieval, authority, classification_reasons = classify(group, domain, metadata)
                reasons.extend(classification_reasons)

            resolved_at = metadata.get("last_active") if metadata.get("resolved") is True and valid_timestamp(metadata.get("last_active")) else None
            entry = {
                "legacy_external_id": external_id or None,
                "source_system": SOURCE_SYSTEM,
                "relative_path": relative_path,
                "content_hash": content_hash,
                "deterministic_memory_id": memory_id,
                "provenance_status": "legacy_unverified",
                "lifecycle_status": lifecycle,
                "retrieval_tier": retrieval,
                "authority_tier": authority,
                "memory_class": "observation",
                "category": f"legacy_{domain}",
                "claim_key": None,
                "valid_from": None,
                "valid_until": None,
                "resolved_at": resolved_at,
                "legacy_pin_candidate": metadata.get("pinned") is True,
                "duplicate_cluster_id": None,
                "classification_reason_codes": sorted(set(reasons)),
                "source_group": group,
                "archive_state": "archived" if group == "archive" else "live",
                "original_type": metadata.get("type"),
                "original_domain": metadata.get("domain"),
                "importance_hint": metadata.get("importance"),
                "created_hint": metadata.get("created"),
                "last_active_hint": metadata.get("last_active"),
                "activation_count_hint": metadata.get("activation_count"),
                "protected_hint": metadata.get("protected"),
                "resolved_hint": metadata.get("resolved"),
                "digested_hint": metadata.get("digested"),
                "original_metadata": metadata,
                "original_lifecycle_hints": {
                    "source_group": group,
                    "archive_state": "archived" if group == "archive" else "live",
                    "pinned": metadata.get("pinned"),
                    "protected": metadata.get("protected"),
                    "resolved": metadata.get("resolved"),
                    "digested": metadata.get("digested"),
                },
                "original_metadata_hash": sha256_bytes(json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")),
                "normalized_content_hash": normalized_content_hash(body),
            }
            entries.append(entry)
            normalized_groups[entry["normalized_content_hash"]].append(len(entries) - 1)

    duplicate_cluster_count = 0
    for normalized_hash, indexes in sorted(normalized_groups.items()):
        if len(indexes) < 2:
            continue
        duplicate_cluster_count += 1
        cluster_id = "ombre-exact-v1-" + normalized_hash[:20]
        for index in indexes:
            entries[index]["duplicate_cluster_id"] = cluster_id
            entries[index]["classification_reason_codes"].append("EXACT_NORMALIZED_DUPLICATE_CLUSTER")

    group_counts = collections.Counter(entry["source_group"] for entry in entries)
    tier_counts = collections.Counter(entry["retrieval_tier"] for entry in entries)
    stats = {
        "total_canonical_records": len(entries),
        "manifest_entries": len(entries),
        "coverage_percent": 100.0 if entries else 0.0,
        "source_groups": {key: group_counts.get(key, 0) for key in sorted(CANONICAL_GROUPS)},
        "retrieval_tiers": {key: tier_counts.get(key, 0) for key in ["active_legacy", "low_authority", "shadow_only", "quarantined", "disabled"]},
        "legacy_pin_candidates": sum(entry["legacy_pin_candidate"] for entry in entries),
        "duplicate_clusters": duplicate_cluster_count,
        "duplicate_cluster_members": sum(entry["duplicate_cluster_id"] is not None for entry in entries),
        "claim_keys_assigned": sum(entry["claim_key"] is not None for entry in entries),
        "temporal_validity_assigned": sum(any(entry[key] is not None for key in ["valid_from", "valid_until", "resolved_at"]) for entry in entries),
        "parse_failures": parse_failures,
        "identity_failures": identity_failures,
    }
    manifest = {
        "manifest_version": "1",
        "policy_version": POLICY_VERSION,
        "dry_run_only": True,
        "source_archive": archive.name,
        "source_archive_sha256": archive_hash,
        "identity": {
            "user_id": IDENTITY_USER_ID,
            "source_system": SOURCE_SYSTEM,
            "uuid_namespace": str(LEGACY_UUID_NAMESPACE),
            "separator_codepoint": 31,
            "algorithm": "UUIDv5(namespace, user_id + chr(31) + source_system + chr(31) + legacy_external_id)",
        },
        "statistics": stats,
        "entries": entries,
    }
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> None:
    entries = manifest["entries"]
    stats = manifest["statistics"]
    assert len(entries) == stats["total_canonical_records"] == stats["manifest_entries"]
    assert len({entry["relative_path"] for entry in entries}) == len(entries)
    ids = [entry["deterministic_memory_id"] for entry in entries if entry["deterministic_memory_id"]]
    assert len(ids) == len(set(ids))
    assert all(entry["provenance_status"] == "legacy_unverified" for entry in entries)
    assert all(entry["memory_class"] == "observation" for entry in entries)
    assert all(not entry.get("native_pin_created", False) for entry in entries)
    assert all(entry["authority_tier"] == "legacy_limited" for entry in entries if entry["retrieval_tier"] in {"active_legacy", "low_authority"})
    assert all(entry["authority_tier"] == "none" for entry in entries if entry["retrieval_tier"] in {"shadow_only", "quarantined", "disabled"})
    assert all(entry["retrieval_tier"] not in {"active_legacy", "low_authority"} for entry in entries if entry["lifecycle_status"] == "archived")
    assert all(entry["deterministic_memory_id"] == deterministic_memory_id(IDENTITY_USER_ID, SOURCE_SYSTEM, entry["legacy_external_id"]) for entry in entries if entry["legacy_external_id"])
    forbidden = {"canonical_content", "content", "body", "evidence_text", "source_message_id", "source_role", "conversation_id"}
    assert all(not forbidden.intersection(entry) for entry in entries)


def self_test(foundation: Path) -> None:
    sql = foundation.read_text(encoding="utf-8")
    assert str(LEGACY_UUID_NAMESPACE) in sql
    assert "p_user_id || chr(31) || p_source_system || chr(31) || p_legacy_external_id" in sql
    assert deterministic_memory_id("user", "ombre", "000000000000") == "8947b557-8cde-530d-bd83-fd65cc0e21ce"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--foundation", type=Path, required=True)
    args = parser.parse_args()
    self_test(args.foundation)
    manifest = build_manifest(args.archive)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["statistics"], ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()

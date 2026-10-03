"""Bounded production record cleanup; never removes active accounts or managed releases."""

import logging
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, or_
from sqlalchemy.orm import Session

from .invites import expire_pro_trials
from .models import (
    AIBucketReservation,
    AIBucketUsage,
    AIReservation,
    AIUsageDaily,
    AnnouncementCache,
    AuditEvent,
    AuthRequest,
    FeatureUsageEvent,
    RefreshSession,
)
from .telemetry import DEVICE_IDENTIFIER_KEYS


def cleanup_records(engine, settings, *, now=None, discord=None):
    now = now or datetime.now(UTC)
    totals = {}
    with Session(engine) as db:
        statements = {
            "auth_requests": delete(AuthRequest).where(
                AuthRequest.expires_at < now - timedelta(days=1)
            ),
            "refresh_sessions": delete(RefreshSession).where(
                or_(
                    RefreshSession.expires_at
                    < now - timedelta(days=settings.expired_session_retention_days),
                    RefreshSession.revoked_at
                    < now - timedelta(days=settings.expired_session_retention_days),
                )
            ),
            "audit_events": delete(AuditEvent).where(
                AuditEvent.timestamp < now - timedelta(days=settings.audit_retention_days)
            ),
            "announcement_cache": delete(AnnouncementCache).where(
                AnnouncementCache.cached_at
                < now - timedelta(days=settings.announcement_cache_retention_days)
            ),
            "ai_reservations": delete(AIReservation).where(AIReservation.expires_at < now),
            "ai_bucket_reservations": delete(AIBucketReservation).where(
                AIBucketReservation.expires_at < now
            ),
            "ai_usage": delete(AIUsageDaily).where(
                AIUsageDaily.utc_date
                < date.fromordinal(now.date().toordinal() - settings.ai_usage_retention_days)
            ),
            "ai_bucket_usage": delete(AIBucketUsage).where(
                AIBucketUsage.utc_date
                < date.fromordinal(now.date().toordinal() - settings.ai_usage_retention_days)
            ),
            # Device/network identifier rows written by releases before telemetry was
            # narrowed. Nothing writes these keys now, so every match is historical.
            "device_identifier_events": delete(FeatureUsageEvent).where(
                FeatureUsageEvent.feature_key.in_(sorted(DEVICE_IDENTIFIER_KEYS))
            ),
        }
        for name, statement in statements.items():
            totals[name] = db.execute(statement).rowcount or 0
        db.commit()
    if discord is not None:
        try:
            totals["pro_trials"] = expire_pro_trials(engine, discord, settings, now=now)
        except Exception:
            logging.getLogger("ii_api").exception("pro_trial_expiry failed")
            totals["pro_trials"] = 0
    logging.getLogger("ii_api").info("retention_cleanup completed removed=%s", sum(totals.values()))
    return totals

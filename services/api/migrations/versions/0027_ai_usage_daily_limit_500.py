"""Raise AI usage hard ceilings to 500 for uncapped staff allowances.

Revision ID: 0027_ai_usage_daily_limit_500
Revises: 0026_tracker_sighting_search
Create Date: 2026-10-02
"""

from __future__ import annotations

from alembic import op

revision = "0027_ai_usage_daily_limit_500"
down_revision = "0026_tracker_sighting_search"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE ai_usage_daily DROP CONSTRAINT IF EXISTS ai_usage_daily_request_count_check")
    op.execute(
        "ALTER TABLE ai_usage_daily DROP CONSTRAINT IF EXISTS ck_ai_usage_daily_request_count"
    )
    op.create_check_constraint(
        "ck_ai_usage_daily_request_count",
        "ai_usage_daily",
        "request_count >= 0 AND request_count <= 500",
    )

    op.execute(
        "ALTER TABLE ai_bucket_usage DROP CONSTRAINT IF EXISTS ai_bucket_usage_request_count_check"
    )
    op.execute(
        "ALTER TABLE ai_bucket_usage DROP CONSTRAINT IF EXISTS ck_ai_bucket_usage_request_count"
    )
    op.create_check_constraint(
        "ck_ai_bucket_usage_request_count",
        "ai_bucket_usage",
        "request_count >= 0 AND request_count <= 500",
    )


def downgrade() -> None:
    op.drop_constraint("ck_ai_usage_daily_request_count", "ai_usage_daily", type_="check")
    op.create_check_constraint(
        "ck_ai_usage_daily_request_count",
        "ai_usage_daily",
        "request_count >= 0 AND request_count <= 100",
    )
    op.drop_constraint("ck_ai_bucket_usage_request_count", "ai_bucket_usage", type_="check")
    op.create_check_constraint(
        "ck_ai_bucket_usage_request_count",
        "ai_bucket_usage",
        "request_count >= 0 AND request_count <= 100",
    )

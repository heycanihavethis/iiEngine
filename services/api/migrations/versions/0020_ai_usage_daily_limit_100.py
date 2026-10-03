"""Raise ai_usage_daily request_count ceiling to 100 for 50/day shared AI."""

import sqlalchemy as sa
from alembic import op

revision = "0020_ai_usage_daily_limit_100"
down_revision = "0019_invite_code_plain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the legacy <= 10 check (name may be auto-generated on PostgreSQL).
    op.execute("ALTER TABLE ai_usage_daily DROP CONSTRAINT IF EXISTS ai_usage_daily_request_count_check")
    op.execute(
        "ALTER TABLE ai_usage_daily DROP CONSTRAINT IF EXISTS ck_ai_usage_daily_request_count"
    )
    op.create_check_constraint(
        "ck_ai_usage_daily_request_count",
        "ai_usage_daily",
        "request_count >= 0 AND request_count <= 100",
    )


def downgrade() -> None:
    op.drop_constraint("ck_ai_usage_daily_request_count", "ai_usage_daily", type_="check")
    op.create_check_constraint(
        "ck_ai_usage_daily_request_count",
        "ai_usage_daily",
        "request_count >= 0 AND request_count <= 10",
    )

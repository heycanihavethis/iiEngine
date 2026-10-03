"""Persist Discord entitlement snapshots on role grants for outage fallback."""

import sqlalchemy as sa
from alembic import op

revision = "0021_role_grant_membership_snapshot"
down_revision = "0020_ai_usage_daily_limit_100"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("role_grants", sa.Column("entitlements", sa.JSON(), nullable=True))
    op.add_column("role_grants", sa.Column("role_ids", sa.JSON(), nullable=True))
    op.add_column("role_grants", sa.Column("roles", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("role_grants", "roles")
    op.drop_column("role_grants", "role_ids")
    op.drop_column("role_grants", "entitlements")

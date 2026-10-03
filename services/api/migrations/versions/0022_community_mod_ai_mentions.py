"""Community mod AI info reviews and chat mention targets."""

import sqlalchemy as sa
from alembic import op

revision = "0022_community_mod_ai_mentions"
down_revision = "0021_role_grant_membership_snapshot"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "community_mods",
        sa.Column("ai_info_status", sa.String(length=20), server_default="idle", nullable=False),
    )
    op.add_column("community_mods", sa.Column("ai_info_report", sa.Text(), nullable=True))
    op.add_column(
        "community_mods", sa.Column("ai_info_error", sa.String(length=300), server_default="", nullable=False)
    )
    op.add_column(
        "community_mods",
        sa.Column("ai_info_updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("community_messages", sa.Column("mentioned_user_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("community_messages", "mentioned_user_ids")
    op.drop_column("community_mods", "ai_info_updated_at")
    op.drop_column("community_mods", "ai_info_error")
    op.drop_column("community_mods", "ai_info_report")
    op.drop_column("community_mods", "ai_info_status")

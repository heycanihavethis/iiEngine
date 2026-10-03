"""Mod upvote/downvote table for trusted and community mods."""

import sqlalchemy as sa
from alembic import op

revision = "0023_mod_votes"
down_revision = "0022_community_mod_ai_mentions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mod_votes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_type", sa.String(length=20), nullable=False),
        sa.Column("target_id", sa.String(length=36), nullable=False),
        sa.Column("value", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "target_type", "target_id", name="uq_mod_votes_user_target"),
    )
    op.create_index("ix_mod_votes_target", "mod_votes", ["target_type", "target_id"])
    op.create_index("ix_mod_votes_user_id", "mod_votes", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_mod_votes_user_id", table_name="mod_votes")
    op.drop_index("ix_mod_votes_target", table_name="mod_votes")
    op.drop_table("mod_votes")

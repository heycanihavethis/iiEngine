"""Community mod review status."""

from alembic import op
import sqlalchemy as sa

revision = "0012_community_mod_review"
down_revision = "0011_clear_community_chat"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "community_mods",
        sa.Column("status", sa.String(length=20), nullable=False, server_default="approved"),
    )
    op.add_column(
        "community_mods",
        sa.Column("review_note", sa.String(length=500), nullable=False, server_default=""),
    )
    op.create_index("ix_community_mods_status", "community_mods", ["status"])


def downgrade() -> None:
    op.drop_index("ix_community_mods_status", table_name="community_mods")
    op.drop_column("community_mods", "review_note")
    op.drop_column("community_mods", "status")

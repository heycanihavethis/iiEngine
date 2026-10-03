"""Short share codes for Customize appearance presets."""

from alembic import op
import sqlalchemy as sa

revision = "0016_appearance_preset_shares"
down_revision = "0015_ai_buckets_and_assistant_flags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "appearance_preset_shares",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("code", sa.String(length=16), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("code"),
    )
    op.create_index("ix_appearance_preset_shares_code", "appearance_preset_shares", ["code"])
    op.create_index("ix_appearance_preset_shares_user_id", "appearance_preset_shares", ["user_id"])
    op.create_index(
        "ix_appearance_preset_shares_expires_at", "appearance_preset_shares", ["expires_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_appearance_preset_shares_expires_at", table_name="appearance_preset_shares")
    op.drop_index("ix_appearance_preset_shares_user_id", table_name="appearance_preset_shares")
    op.drop_index("ix_appearance_preset_shares_code", table_name="appearance_preset_shares")
    op.drop_table("appearance_preset_shares")

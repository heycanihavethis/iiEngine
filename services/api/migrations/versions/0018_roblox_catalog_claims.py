"""Roblox catalog claims for automated Engine Pro grants."""

import sqlalchemy as sa
from alembic import op

revision = "0018_roblox_catalog_claims"
down_revision = "0017_background_tracks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "roblox_gamepass_claims" in inspector.get_table_names():
        # Table already created by the production 0014_roblox bridge / main deploy.
        return
    op.create_table(
        "roblox_gamepass_claims",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("roblox_user_id", sa.String(length=20), nullable=False),
        sa.Column("roblox_username", sa.String(length=40), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id"),
        sa.UniqueConstraint("roblox_user_id"),
    )
    op.create_index(
        "ix_roblox_gamepass_claims_user_id", "roblox_gamepass_claims", ["user_id"]
    )
    op.create_index(
        "ix_roblox_gamepass_claims_roblox_user_id",
        "roblox_gamepass_claims",
        ["roblox_user_id"],
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "roblox_gamepass_claims" not in inspector.get_table_names():
        return
    op.drop_index(
        "ix_roblox_gamepass_claims_roblox_user_id", table_name="roblox_gamepass_claims"
    )
    op.drop_index("ix_roblox_gamepass_claims_user_id", table_name="roblox_gamepass_claims")
    op.drop_table("roblox_gamepass_claims")

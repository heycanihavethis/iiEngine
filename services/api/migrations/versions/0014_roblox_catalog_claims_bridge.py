"""Bridge production stamp 0014_roblox_catalog_claims into the current chain.

Main briefly shipped Roblox claims as revision 0014. Later branches renumbered
Roblox to 0018 and used 0014 for tracker. Production DBs that already applied
the old 0014 need this revision id present so alembic can walk forward.
"""

import sqlalchemy as sa
from alembic import op

revision = "0014_roblox_catalog_claims"
down_revision = "0013_invites_and_trials"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "roblox_gamepass_claims" in inspector.get_table_names():
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

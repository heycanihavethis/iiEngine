"""Invite campaigns and Pro trial expiry tracking."""

from alembic import op
import sqlalchemy as sa

revision = "0013_invites_and_trials"
down_revision = "0012_community_mod_review"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "invite_campaigns",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("inviter_user_id", sa.String(length=36), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("code_prefix", sa.String(length=8), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["inviter_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("inviter_user_id"),
        sa.UniqueConstraint("code_hash"),
    )
    op.create_index("ix_invite_campaigns_inviter_user_id", "invite_campaigns", ["inviter_user_id"])
    op.create_index("ix_invite_campaigns_code_hash", "invite_campaigns", ["code_hash"])

    op.create_table(
        "invite_redemptions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("campaign_id", sa.String(length=36), nullable=False),
        sa.Column("invitee_user_id", sa.String(length=36), nullable=False),
        sa.Column("authorized_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["campaign_id"], ["invite_campaigns.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invitee_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("invitee_user_id"),
    )
    op.create_index("ix_invite_redemptions_campaign_id", "invite_redemptions", ["campaign_id"])

    op.create_table(
        "pro_trials",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("source", sa.String(length=40), nullable=False),
        sa.Column("role_id", sa.String(length=20), nullable=False),
        sa.Column("had_pro_before", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_pro_trials_user_id", "pro_trials", ["user_id"])
    op.create_index("ix_pro_trials_expires_at", "pro_trials", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_pro_trials_expires_at", table_name="pro_trials")
    op.drop_index("ix_pro_trials_user_id", table_name="pro_trials")
    op.drop_table("pro_trials")
    op.drop_index("ix_invite_redemptions_campaign_id", table_name="invite_redemptions")
    op.drop_table("invite_redemptions")
    op.drop_index("ix_invite_campaigns_code_hash", table_name="invite_campaigns")
    op.drop_index("ix_invite_campaigns_inviter_user_id", table_name="invite_campaigns")
    op.drop_table("invite_campaigns")

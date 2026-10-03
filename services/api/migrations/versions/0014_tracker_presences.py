"""Self Tracker presence rows for opted-in players."""

import sqlalchemy as sa
from alembic import op

revision = "0014_tracker_presences"
down_revision = "0014_roblox_catalog_claims"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "tracker_presences",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("username", sa.String(length=100), nullable=False),
        sa.Column("room_code", sa.String(length=32), nullable=False),
        sa.Column("in_room", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_index(
        op.f("ix_tracker_presences_updated_at"),
        "tracker_presences",
        ["updated_at"],
        unique=False,
    )


def downgrade():
    op.drop_index(op.f("ix_tracker_presences_updated_at"), table_name="tracker_presences")
    op.drop_table("tracker_presences")

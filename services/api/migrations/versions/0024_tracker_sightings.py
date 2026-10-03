"""Persist Discord tracker sightings for up to 3 days."""

import sqlalchemy as sa
from alembic import op

revision = "0024_tracker_sightings"
down_revision = "0023_mod_votes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tracker_sightings",
        sa.Column("id", sa.String(length=120), primary_key=True),
        sa.Column("player_id", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("username", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("room", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("region", sa.String(length=16), nullable=False, server_default=""),
        sa.Column("cosmetic", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("color", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("platform", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("track_kind", sa.String(length=16), nullable=False, server_default="player"),
        sa.Column("author", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("avatar", sa.String(length=300), nullable=True),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("embed_title", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_tracker_sightings_player_id", "tracker_sightings", ["player_id"])
    op.create_index("ix_tracker_sightings_track_kind", "tracker_sightings", ["track_kind"])
    op.create_index("ix_tracker_sightings_seen_at", "tracker_sightings", ["seen_at"])


def downgrade() -> None:
    op.drop_index("ix_tracker_sightings_seen_at", table_name="tracker_sightings")
    op.drop_index("ix_tracker_sightings_track_kind", table_name="tracker_sightings")
    op.drop_index("ix_tracker_sightings_player_id", table_name="tracker_sightings")
    op.drop_table("tracker_sightings")

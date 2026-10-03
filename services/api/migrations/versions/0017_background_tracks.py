"""Staff background music presets for quiet Engine playback."""

import sqlalchemy as sa
from alembic import op

revision = "0017_background_tracks"
down_revision = "0016_appearance_preset_shares"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "background_tracks",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("artist", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("filename", sa.String(length=180), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("artifact", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_by", sa.String(length=36), sa.ForeignKey("users.id", ondelete="SET NULL")
        ),
        sa.UniqueConstraint("filename"),
    )


def downgrade() -> None:
    op.drop_table("background_tracks")

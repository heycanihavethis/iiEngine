"""Published managed menu releases and changelogs."""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "release_candidates",
        sa.Column("display_name", sa.String(120), nullable=False, server_default=""),
    )
    op.add_column(
        "release_candidates",
        sa.Column("changelog", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column(
        "release_candidates",
        sa.Column("release_notes", sa.String(6000), nullable=False, server_default=""),
    )
    op.add_column(
        "release_candidates", sa.Column("published_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "release_candidates",
        sa.Column(
            "published_by",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_release_candidates_published_at", "release_candidates", ["published_at"])


def downgrade():
    op.drop_index("ix_release_candidates_published_at", table_name="release_candidates")
    op.drop_column("release_candidates", "published_by")
    op.drop_column("release_candidates", "published_at")
    op.drop_column("release_candidates", "release_notes")
    op.drop_column("release_candidates", "changelog")
    op.drop_column("release_candidates", "display_name")

"""Widen alembic_version.version_num for long revision ids."""

import sqlalchemy as sa
from alembic import op

# Keep this revision id <= 32 chars — production column is varchar(32) until this runs.
revision = "0015_widen_alembic_ver"
down_revision = "0014_tracker_presences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "alembic_version",
        "version_num",
        existing_type=sa.String(length=32),
        type_=sa.String(length=64),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "alembic_version",
        "version_num",
        existing_type=sa.String(length=64),
        type_=sa.String(length=32),
        existing_nullable=False,
    )

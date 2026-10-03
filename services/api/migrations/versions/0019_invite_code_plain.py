"""Persist invite codes so creators can re-open them in Settings."""

import sqlalchemy as sa
from alembic import op

revision = "0019_invite_code_plain"
down_revision = "0018_roblox_catalog_claims"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "invite_campaigns",
        sa.Column("code_plain", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("invite_campaigns", "code_plain")

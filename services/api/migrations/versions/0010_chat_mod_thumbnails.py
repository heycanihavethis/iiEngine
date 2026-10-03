"""Chat anonymity/roles, message moderation fields, and mod thumbnails."""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("community_messages") as batch:
        batch.add_column(
            sa.Column("anonymous", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.add_column(sa.Column("author_role_name", sa.String(100), nullable=True))
        batch.add_column(sa.Column("author_role_color", sa.String(7), nullable=True))

    with op.batch_alter_table("trusted_mods") as batch:
        batch.add_column(sa.Column("thumbnail", sa.LargeBinary(), nullable=True))
        batch.add_column(sa.Column("thumbnail_mime", sa.String(40), nullable=True))

    with op.batch_alter_table("community_mods") as batch:
        batch.add_column(sa.Column("thumbnail", sa.LargeBinary(), nullable=True))
        batch.add_column(sa.Column("thumbnail_mime", sa.String(40), nullable=True))


def downgrade():
    with op.batch_alter_table("community_mods") as batch:
        batch.drop_column("thumbnail_mime")
        batch.drop_column("thumbnail")
    with op.batch_alter_table("trusted_mods") as batch:
        batch.drop_column("thumbnail_mime")
        batch.drop_column("thumbnail")
    with op.batch_alter_table("community_messages") as batch:
        batch.drop_column("author_role_color")
        batch.drop_column("author_role_name")
        batch.drop_column("anonymous")

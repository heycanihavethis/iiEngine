"""Clear legacy community chat messages for a clean Community relaunch."""

from alembic import op
import sqlalchemy as sa

revision = "0011_clear_community_chat"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "community_messages" in inspector.get_table_names():
        op.execute(sa.text("DELETE FROM community_messages"))


def downgrade() -> None:
    # Irreversible data wipe.
    pass

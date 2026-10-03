"""AI bucket usage and community assistant message flag."""

from alembic import op
import sqlalchemy as sa

revision = "0015_ai_buckets_and_assistant_flags"
down_revision = "0015_widen_alembic_ver"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_bucket_usage",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("utc_date", sa.Date(), nullable=False),
        sa.Column("bucket", sa.String(length=40), nullable=False),
        sa.Column("request_count", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint(
            "request_count >= 0 AND request_count <= 100",
            name="ck_ai_bucket_usage_request_count",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "utc_date", "bucket"),
    )
    op.create_index("ix_ai_bucket_usage_bucket", "ai_bucket_usage", ["bucket"])

    op.create_table(
        "ai_bucket_reservations",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("utc_date", sa.Date(), nullable=False),
        sa.Column("bucket", sa.String(length=40), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_ai_bucket_reservations_user_id", "ai_bucket_reservations", ["user_id"])
    op.create_index("ix_ai_bucket_reservations_bucket", "ai_bucket_reservations", ["bucket"])

    with op.batch_alter_table("community_messages") as batch:
        batch.add_column(
            sa.Column("is_assistant", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("community_messages") as batch:
        batch.drop_column("is_assistant")
    op.drop_index("ix_ai_bucket_reservations_bucket", table_name="ai_bucket_reservations")
    op.drop_index("ix_ai_bucket_reservations_user_id", table_name="ai_bucket_reservations")
    op.drop_table("ai_bucket_reservations")
    op.drop_index("ix_ai_bucket_usage_bucket", table_name="ai_bucket_usage")
    op.drop_table("ai_bucket_usage")

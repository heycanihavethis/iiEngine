"""Add tracker sighting search indexes and note 5-day retention.

Revision ID: 0026_tracker_sighting_search
Revises: 0025_widen_audit_result
Create Date: 2026-10-01
"""

from __future__ import annotations

from alembic import op

revision = "0026_tracker_sighting_search"
down_revision = "0025_widen_audit_result"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_tracker_sightings_username", "tracker_sightings", ["username"])
    op.create_index("ix_tracker_sightings_room", "tracker_sightings", ["room"])


def downgrade() -> None:
    op.drop_index("ix_tracker_sightings_room", table_name="tracker_sightings")
    op.drop_index("ix_tracker_sightings_username", table_name="tracker_sightings")

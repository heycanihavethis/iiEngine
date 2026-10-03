"""Delete telemetry rows that stored PC usernames, hostnames and IP addresses.

Engine telemetry no longer collects device or network identifiers. This removes the
rows earlier releases wrote; the keys are not written by any current code path, so
every matching row is historical. The data is not recoverable on downgrade.

Revision ID: 0028_purge_device_identifier_telemetry
Revises: 0027_ai_usage_daily_limit_500
Create Date: 2026-10-03
"""

from __future__ import annotations

from alembic import op

revision = "0028_purge_device_identifier_telemetry"
down_revision = "0027_ai_usage_daily_limit_500"
branch_labels = None
depends_on = None

IDENTIFIER_KEYS = (
    "client_ip",
    "direct_ip",
    "egress_ip",
    "host",
    "hostname",
    "ip",
    "ipv4",
    "ipv6",
    "local_ip",
    "mac",
    "mac_address",
    "machine",
    "machine_name",
    "pc_name",
    "pc_username",
    "public_ip",
    "root_ip",
    "username",
    "vpn_ip",
    "vpn_suspected",
)


def upgrade() -> None:
    keys = ", ".join(f"'{key}'" for key in IDENTIFIER_KEYS)
    op.execute(f"DELETE FROM feature_usage_events WHERE feature_key IN ({keys})")


def downgrade() -> None:
    """Deleted identifier rows are intentionally not restored."""

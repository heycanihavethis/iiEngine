from ii_api.access import DEFAULT_UNCAPPED_ROLE_ID, member_has_uncapped_limits


def test_member_has_uncapped_limits_for_owner_admin_and_role():
    assert member_has_uncapped_limits({"entitlements": ["user", "owner"], "role_ids": []})
    assert member_has_uncapped_limits({"entitlements": ["user", "admin"], "role_ids": []})
    assert member_has_uncapped_limits({"entitlements": ["user", "uncapped"], "role_ids": []})
    assert member_has_uncapped_limits(
        {"entitlements": ["user"], "role_ids": [DEFAULT_UNCAPPED_ROLE_ID]}
    )
    assert not member_has_uncapped_limits({"entitlements": ["user", "developer"], "role_ids": []})
    assert not member_has_uncapped_limits({"entitlements": ["user", "pro"], "role_ids": []})
    assert not member_has_uncapped_limits(None)

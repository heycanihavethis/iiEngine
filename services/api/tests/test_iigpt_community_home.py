from conftest import login
from test_identity import authorization

from ii_api.menu_features import (
    catalog_for_prompt,
    lookup_catalog_feature,
    query_is_mod_browse,
    query_needs_menu_catalog,
    retrieve_menu_features,
    structured_catalog,
    tokens,
)


class FakeAI:
    response = "Favorite Mods opens from Main — favorite with left grip."
    last_prompt = ""
    last_system = ""

    async def complete(self, prompt, *, system="", max_tokens=1024):
        FakeAI.last_prompt = prompt
        FakeAI.last_system = system
        return self.response

    async def stream(self, message, *, system="", max_tokens=1024):
        FakeAI.last_prompt = message
        FakeAI.last_system = system
        yield self.response

    async def close(self):
        pass


def test_menu_feature_retrieval_finds_favorites():
    keys = tokens("how do I open favorite mods")
    assert "favorite" in keys or "mods" in keys
    text = retrieve_menu_features("favorite mods left grip")
    assert "Favorite" in text or "favorite" in text.casefold()


def test_catalog_only_for_mod_questions():
    assert query_needs_menu_catalog("which mods are best for movement?")
    assert query_needs_menu_catalog("is fly in the menu?")
    assert query_needs_menu_catalog("does the menu have Favorite Mods?")
    assert query_needs_menu_catalog("what are some cool mods on the menu")
    assert not query_needs_menu_catalog("how do I install BepInEx on Steam?")
    assert not query_needs_menu_catalog("why does Gorilla Tag crash on launch?")
    assert catalog_for_prompt("install BepInEx please", always=False) == ""
    assert "full ii reborn menu feature catalog" in catalog_for_prompt(
        "install BepInEx please", always=True
    ).casefold()
    assert "platforms" in catalog_for_prompt("best mods for tagging").casefold()


def test_catalog_prompt_fits_model_context_budget():
    """SiliconFlow Qwen2.5-7B rejects >32K input tokens; keep grounded prompts well under."""
    from ii_api.menu_features import CATALOG_PROMPT_CHAR_BUDGET, _feature_lines

    for question in ("how do i enable speed boost", "what are some cool mods", "hi"):
        catalog = catalog_for_prompt(question, always=True)
        assert len(catalog) <= CATALOG_PROMPT_CHAR_BUDGET
        assert CATALOG_PROMPT_CHAR_BUDGET <= 80_000  # ~20K tokens at 4 chars/token
        lowered = catalog.casefold()
        assert "full ii reborn menu feature catalog" in lowered
    # Every feature title stays reachable even when descriptions are budgeted out.
    catalog = catalog_for_prompt("speed boost", always=True)
    assert len(_feature_lines()) > 0
    assert "speed" in catalog.casefold()


def test_browse_query_uses_real_highlight_mods():
    question = "what are some cool mods on the menu"
    assert query_is_mod_browse(question)
    text = retrieve_menu_features(question, limit=24)
    lowered = text.casefold()
    assert "platforms" in lowered
    assert "fly [a]" in lowered or "iron man" in lowered
    assert "gorilla tag: ultimate" not in lowered
    catalog = catalog_for_prompt(question)
    assert "full ii reborn menu feature catalog" in catalog.casefold()
    assert "platforms" in catalog.casefold()
    assert "broad browse" in catalog.casefold()


def test_chat_attaches_menu_catalog_for_mod_questions(identity_client):
    client, _discord = identity_client
    FakeAI.last_prompt = ""
    FakeAI.last_system = ""
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/ai/chat",
        headers=headers,
        json={"message": "what are some cool mods on the menu", "share_telemetry": False},
    )
    assert response.status_code == 200
    assert "event: token" in response.text
    assert "feature catalog" in FakeAI.last_prompt.casefold()
    assert "platforms" in FakeAI.last_prompt.casefold()
    assert (
        "only cite mod/feature titles" in FakeAI.last_system.casefold()
        or "authoritative" in FakeAI.last_system.casefold()
    )


def test_chat_attaches_catalog_for_install_help(identity_client):
    client, _discord = identity_client
    FakeAI.last_prompt = ""
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/ai/chat",
        headers=headers,
        json={"message": "How do I install BepInEx on SteamVR?", "share_telemetry": False},
    )
    assert response.status_code == 200
    assert "feature catalog" in FakeAI.last_prompt.casefold()
    assert "full ii reborn menu feature catalog" in FakeAI.last_prompt.casefold()


def test_community_ai_requires_pro(identity_client):
    client, _discord = identity_client
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/community/ai",
        headers=headers,
        json={"prompt": "how do I fly", "category": "chat", "share_telemetry": False},
    )
    assert response.status_code == 403


def test_community_ai_pro_posts_reply(identity_client):
    client, discord = identity_client
    discord.extra_entitlements = ["pro"]
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/community/ai",
        headers=headers,
        json={"prompt": "What is Favorite Mods?", "category": "chat", "share_telemetry": False},
    )
    assert response.status_code == 201, response.text
    items = response.json()["items"]
    assert len(items) == 2
    assert items[0]["body"].startswith("/ai ")
    assert items[1]["is_assistant"] is True
    assert items[1]["author"]["display_name"] == "iiGPT"
    assert "feature catalog" in FakeAI.last_prompt.casefold()


def test_community_ai_always_attaches_catalog(identity_client):
    client, discord = identity_client
    discord.extra_entitlements = ["pro"]
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/community/ai",
        headers=headers,
        json={
            "prompt": "How do I install BepInEx on SteamVR?",
            "category": "chat",
            "share_telemetry": False,
        },
    )
    assert response.status_code == 201, response.text
    assert "feature catalog" in FakeAI.last_prompt.casefold()


def test_home_assistant_answers(identity_client):
    client, _discord = identity_client
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/ai/home-assistant",
        headers=headers,
        json={"message": "What is Favorite Mods?", "share_telemetry": False},
    )
    assert response.status_code == 200
    body = response.json()
    assert "Favorite" in body["answer"] or "favorite" in body["answer"].casefold()
    assert body["catalog_attached"] is True
    assert "remaining" in body


def test_home_assistant_always_attaches_catalog(identity_client):
    client, _discord = identity_client
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/ai/home-assistant",
        headers=headers,
        json={"message": "Why won't Engine launch Gorilla Tag?", "share_telemetry": False},
    )
    assert response.status_code == 200
    assert response.json()["catalog_attached"] is True
    assert "feature catalog" in FakeAI.last_prompt.casefold()
    assert "drifted" in FakeAI.last_system.casefold() or "head admin" in FakeAI.last_system.casefold()


def test_community_ai_daily_limit(identity_client):
    client, discord = identity_client
    discord.extra_entitlements = ["pro"]
    client.app.state.ai_provider = FakeAI()
    client.app.state.settings.ai_daily_request_limit = 2
    headers = authorization(login(client))
    for _ in range(2):
        assert (
            client.post(
                "/v1/community/ai",
                headers=headers,
                json={"prompt": "ping", "share_telemetry": False},
            ).status_code
            == 201
        )
    blocked = client.post(
        "/v1/community/ai",
        headers=headers,
        json={"prompt": "again", "share_telemetry": False},
    )
    assert blocked.status_code == 429


def test_structured_catalog_groups_features():
    catalog = structured_catalog()
    assert catalog["total"] > 1000
    names = {category["name"] for category in catalog["categories"]}
    assert "Movement Mods" in names
    assert "Menu Settings" in names
    platforms = lookup_catalog_feature("Platforms")
    assert platforms is not None
    assert platforms["category"] == "Movement Mods"
    assert "grip" in str(platforms["description"]).casefold()


def test_menu_catalog_endpoint(identity_client):
    client, _discord = identity_client
    headers = authorization(login(client))
    response = client.get("/v1/ai/menu-catalog", headers=headers)
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] > 1000
    assert any(category["name"] == "Fun Mods" for category in payload["categories"])


def test_catalog_explain_requires_pro(identity_client):
    client, _discord = identity_client
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/ai/catalog-explain",
        headers=headers,
        json={"name": "Platforms", "share_telemetry": False},
    )
    assert response.status_code == 403


def test_catalog_explain_pro_is_informational(identity_client):
    client, discord = identity_client
    discord.extra_entitlements = ["pro"]

    class ExplainAI(FakeAI):
        response = (
            "**What it is**\nPlatforms spawn blocks under your hands.\n"
            "**What it does**\n- Hold grip to spawn platforms\n"
            "**Where to find it**\n- Movement Mods\n"
            "**Notes**\n- Toggle\n"
            "**Footnote**\nAI explanations can be wrong and are not perfect. "
            "This is informational only — not a safety rating."
        )

    client.app.state.ai_provider = ExplainAI()
    headers = authorization(login(client))
    response = client.post(
        "/v1/ai/catalog-explain",
        headers=headers,
        json={"name": "Platforms", "share_telemetry": False},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Platforms"
    assert "risk score" not in body["answer"].casefold()
    assert "wrong" in body["disclaimer"].casefold()
    assert "risk" not in ExplainAI.last_system.casefold() or "not a risk" in ExplainAI.last_system.casefold()
    assert "not a malware scanner" in ExplainAI.last_system.casefold()

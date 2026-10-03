--[[
  OPTIONAL helper for a Roblox experience that wants to nudge Engine after a
  catalog purchase. Primary Pro grant path is Plans → link Roblox → claim,
  which verifies Asset ownership against catalog id 93620103303755.

  Engine Pro product (Marketplace catalog item):
    https://www.roblox.com/catalog/93620103303755/ii-Engine-Pro-Lifetime

  Ownership is checked by the API (Open Cloud inventory filter or public
  is-owned). A place script is not required for Discord Pro grants.
]]

local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")

-- Classic clothing / catalog Asset id (not a GamePass).
local CATALOG_ASSET_ID = 93620103303755

local function playerOwnsPro(userId)
	local owns = false
	local ok = pcall(function()
		owns = MarketplaceService:PlayerOwnsAsset(userId, CATALOG_ASSET_ID)
	end)
	return ok and owns
end

Players.PlayerAdded:Connect(function(player)
	if playerOwnsPro(player.UserId) then
		print(("[ii Engine Pro] %s already owns catalog asset %d"):format(player.Name, CATALOG_ASSET_ID))
	end
end)

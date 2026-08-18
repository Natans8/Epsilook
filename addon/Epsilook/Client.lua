--- Answering from the running game what the payload left out.
--
-- The other half of the lean variation. `index.supplied` names, per column,
-- a call that answers it, and this is where those calls live -- one function
-- per route, keyed by the name the emitter wrote. Nothing above `Data` learns
-- that a column came from here rather than from a blob.
--
-- Some of these are not merely cheaper than shipping, they are better. A name
-- read from the client is the name the server currently uses, so a renamed
-- spell is findable under its new name; a description is resolved at the
-- player's own level rather than at the expansion's cap. Those are answers a
-- payload cannot give at any size.
--
-- Every route is feature-detected. A call that is not there means the column
-- is simply unanswerable, which is a different thing from empty, and the
-- caller is told so by getting nothing back.

local _, ns = ...

local Client = {}
if ns then
	ns.Client = Client
end

_G.Epsilook = _G.Epsilook or {}
_G.Epsilook.Client = Client

--- Ask for a spell's ORIGINAL data, never an addon's override.
-- Another addon on this client replaces the global and lets players rename
-- their own auras, which silently turns their strings into ours. The third
-- argument is what asks the game for its own answer instead, and every read
-- of a name goes through here so that no call site can forget it.
local function originalSpellInfo(spellID)
	local get = _G.GetSpellInfo
	if not get then
		return nil
	end
	return get(spellID, nil, true)
end

--- The routes, by the name the emitter writes into `index.supplied`.
-- Each takes the identity its column is keyed by and returns one value, or
-- nil where the client cannot answer for that row.
Client.ROUTES = {
	["GetSpellInfo"] = function(spellID)
		return originalSpellInfo(spellID)
	end,

	["GetSpellTexture"] = function(spellID)
		local get = _G.GetSpellTexture
		return get and get(spellID) or nil
	end,

	["GetSpellDescription"] = function(spellID)
		-- Asynchronous for a spell the client has not cached, so an empty
		-- answer means "not yet" rather than "none". A caller that wants to
		-- be sure asks again after `C_Spell.RequestLoadSpellData`.
		local get = _G.GetSpellDescription
		return get and get(spellID) or nil
	end,

	["C_Epsilon.SoundKit_Get"] = function(index)
		local epsilon = _G.C_Epsilon
		local get = epsilon and epsilon.SoundKit_Get
		return get and get(index) or nil
	end,

	["C_Epsilon.GODI_Get"] = function(index)
		local epsilon = _G.C_Epsilon
		local get = epsilon and epsilon.GODI_Get
		return get and get(index) or nil
	end,
}

--- Whether a named route can answer on this client.
-- @param route the call's name, as `index.supplied` spells it
-- @return true where the route exists and the client provides it
function Client.Has(route)
	local answer = Client.ROUTES[route]
	if not answer then
		return false
	end
	-- Asking is the only honest detection: a route is a composition of client
	-- calls, and whether they are all present is what the route itself knows.
	local ok, value = pcall(answer, 1)
	return ok and value ~= nil
end

--- Ask one route for one row.
-- @param route the call's name
-- @param key the identity the column is keyed by, usually a spell id
-- @return whatever the client answered, or nil
function Client.Get(route, key)
	local answer = Client.ROUTES[route]
	if not answer then
		return nil
	end
	local ok, value = pcall(answer, key)
	return ok and value or nil
end

return Client

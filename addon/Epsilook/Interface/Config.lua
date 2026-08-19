--- The settings a player may change, and the store they live in.
--
-- A layer of its own, below every interface and above nothing: the chat shell
-- reads it, a frame would read the same declarations, and the engine never
-- reads it at all, so a setting can never change what a query answers -- only
-- how an answer is shown. `SETTINGS` is the one declaration; a new setting is
-- one row there and one reader, and the panel draws itself from it rather
-- than naming any setting of its own.
--
-- The store is account-wide saved variables. Nothing here needs the client:
-- with no store loaded every setting reads its default, which is what a bare
-- interpreter and a first login both see.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Config = {}
Epsilook.Config = Config

--- Every setting a player may change: the key it is stored under, the words
-- a panel labels and explains it with, how it is chosen, and the value it
-- has until they choose. A `number` carries the bounds it is clamped to and
-- the step a slider moves by. The order is the order a panel lays them out.
Config.SETTINGS = {
	{
		key = "page",
		label = "Results per page",
		hint = "How many spells one page of a search prints before the next-page button.",
		kind = "number",
		default = 20,
		min = 5,
		max = 60,
		step = 5,
	},
}

--- The setting declared under a key, or nil.
-- @param key the setting's key
-- @return the declaration
function Config.Declared(key)
	for _, setting in ipairs(Config.SETTINGS) do
		if setting.key == key then
			return setting
		end
	end
	return nil
end

--- The values chosen so far. Replaced wholesale when the client hands over
-- its saved variables, so a read before then is a read of the defaults.
local chosen = {}

--- A value made fit for a setting, or nil where it cannot be: a number is
-- taken to the nearer of its setting's steps, and one outside the bounds is
-- refused rather than corrected, so a store written by hand says so instead
-- of silently becoming something else.
-- @param setting a declaration from SETTINGS
-- @param value the value offered
-- @return the value to store, or nil
function Config.Fit(setting, value)
	if type(value) ~= "number" or value ~= value then
		return nil
	end
	if value < setting.min or value > setting.max then
		return nil
	end
	-- The rounding runs after the bounds check, so a range that is not a whole
	-- number of steps could carry a value past the top; the result is held
	-- down to the bound rather than returned outside it.
	local steps = math.floor((value - setting.min) / setting.step + 0.5)
	return math.min(setting.min + steps * setting.step, setting.max)
end

--- What a setting reads as now: the value chosen, or its default.
-- @param key the setting's key
-- @return the value, or nil for a key nothing declares
function Config.Get(key)
	local setting = Config.Declared(key)
	if not setting then
		return nil
	end
	local value = chosen[key]
	if value == nil then
		return setting.default
	end
	return value
end

--- Choose a value for a setting.
-- @param key the setting's key
-- @param value the value, or nil to go back to the default
-- @return the value now read, or nil where the key or the value was refused
function Config.Set(key, value)
	local setting = Config.Declared(key)
	if not setting then
		return nil
	end
	if value == nil then
		chosen[key] = nil
		return setting.default
	end
	local fitted = Config.Fit(setting, value)
	if fitted == nil then
		return nil
	end
	chosen[key] = fitted
	return fitted
end

--- Take the client's saved variables as the store, keeping only what the
-- declarations still admit: a setting that has been dropped, renamed or
-- given narrower bounds leaves its stale value behind rather than carrying
-- it into a reader that no longer expects it.
-- @param store the saved variables table, or nil on a first login
-- @return the table to save, which is the one handed in where there was one
function Config.Load(store)
	store = store or {}
	chosen = {}
	for _, setting in ipairs(Config.SETTINGS) do
		local held = store[setting.key]
		if held ~= nil then
			local fitted = Config.Fit(setting, held)
			if fitted ~= nil then
				chosen[setting.key] = fitted
			end
		end
		store[setting.key] = chosen[setting.key]
	end
	Config.store = store
	return store
end

--- Write a chosen value through to the store the client saves, where one has
-- been loaded. Called by Set's callers rather than by Set, so a bare
-- interpreter never needs a store at all.
-- @param key the setting's key
function Config.Save(key)
	if Config.store then
		Config.store[key] = chosen[key]
	end
end

--- A one-line report that the payload loaded and reads correctly.
--
-- The first consumer of the API, and deliberately a tiny one: it asks the
-- surface the same questions a person would and prints what came back. It is
-- here rather than in `API.lua` because printing is presentation, and the
-- surface does not do that -- keeping the split honest from the first caller
-- is cheaper than restoring it later.
--
-- What it checks is the whole chain: the data addon loads on demand, a spell
-- resolves by id, its parts count, and a column reads a value out of the blob.
-- Anything wrong anywhere shows up as a wrong field rather than as an error.

local _, ns = ...

local Epsilook = _G.Epsilook

--- Run the checks and print one line.
-- @return true where everything answered, false where something did not
function Epsilook:SelfTest()
	local ok, report = pcall(function()
		local said = {}
		local function say(form, ...)
			said[#said + 1] = string.format(form, ...)
		end

		-- Asking for a count is what loads the payload, so this comes first
		-- and everything after it can assume the data is there.
		local spells = self:GetNumSpells()
		local info = self:GetDataInfo()
		if not info or spells == 0 then
			-- The ordinary way to arrive here is the data addon being absent
			-- or disabled, which is a thing to say plainly rather than an
			-- error to raise.
			return "no payload: is Epsilook_Data installed and enabled?"
		end
		say("%d spells", spells)
		say("%s (%s)", info.pack, info.variation)

		local spell = self:GetSpellDataByID(133)
		say(
			"133=%s school=%s icon=%s",
			tostring(spell.name),
			tostring(spell.school),
			tostring(spell.icon)
		)

		local counts = self:GetPartCounts(133)
		say(
			"m%d s%d a%d x%d",
			counts.model or 0,
			counts.sound or 0,
			counts.anim or 0,
			counts.mech or 0
		)

		-- One whole part, which is the longest chain the surface has: a row
		-- located in its pool, its stored numbers read out of the blob, a
		-- vocabulary asked what one of them is called, and the ids its axis
		-- can act on. Every layer is wrong in a visible way if any is.
		local part = self:GetPartDataByIndex(133, "model", 1)
		if part then
			say(
				"model1=%s %s acts=%d",
				part.kind,
				tostring(part.named.file),
				#self:GetPartActions(part)
			)
		else
			say("model1=none")
		end

		say("engine=%s", self.FindSpells and "yes" or "not built")
		return table.concat(said, " | ")
	end)

	-- Coloured the way this client colours its own output: a gold name, and
	-- red where something failed, so a bad run is not something to read
	-- carefully to notice.
	local colour = ok and "|cff71d5ff" or "|cffff2020"
	print(colour .. "Epsilook|r " .. tostring(report))
	return ok
end

if ns then
	ns.SelfTest = true
end

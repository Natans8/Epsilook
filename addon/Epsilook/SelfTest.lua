--- A one-line report that the payload loaded and the engine answers.
--
-- The first consumer of the API, and deliberately a tiny one: it asks the
-- surface the same questions a person would and prints what came back. It is
-- here rather than in `API.lua` because printing is presentation, and the
-- surface does not do that -- keeping the split honest from the first caller
-- is cheaper than restoring it later.
--
-- What it checks is the whole chain: the data addon mounts on demand, a spell
-- resolves by id, its parts read, a query parses, and a search answers.
-- Anything wrong anywhere shows up as a wrong field rather than as an error.

local Epsilook = _G.Epsilook

--- Run the checks and print one line.
-- @return true where everything answered, false where something did not
function Epsilook:SelfTest()
	local ok, report = pcall(function()
		local said = {}
		local function say(form, ...)
			said[#said + 1] = string.format(form, ...)
		end

		local loaded, reason = self:LoadData()
		if not loaded then
			-- The ordinary way to arrive here is the data addon being absent
			-- or disabled, which is a thing to say plainly rather than an
			-- error to raise.
			return "no data: " .. tostring(reason) .. " (is Epsilook_Data installed and enabled?)"
		end
		local info = self:GetDataInfo()
		say("%d spells", self:GetNumSpells())
		say("%s %s", info.pack, info.variation)

		local spell = self:GetSpellDataByID(133)
		say("133=%s %s %s", tostring(spell.name), tostring(spell.school), tostring(spell.expansion))

		local counts = self:GetPartCounts(133)
		say(
			"m%d s%d a%d x%d e%d",
			counts.model or 0,
			counts.sound or 0,
			counts.anim or 0,
			counts.fx or 0,
			counts.mech or 0
		)

		local part = self:GetPartDataByIndex(133, "model", 1)
		say("model1=%s %s", tostring(part and part.kind), tostring(part and part.values.file))

		local query, problems = self:ParseQuery("name:fireball -model:missile")
		say("parse=%s (%d problems)", self:FormatQuery(query), #problems)

		local _, first = self:FindSpells("name:=Fireball")()
		say("find=%s", tostring(first))
		return table.concat(said, " | ")
	end)

	-- Coloured the way this client colours its own output: a gold name, and
	-- red where something failed, so a bad run is not something to read
	-- carefully to notice.
	local colour = ok and "|cff71d5ff" or "|cffff2020"
	print(colour .. "Epsilook|r " .. tostring(report))
	return ok
end

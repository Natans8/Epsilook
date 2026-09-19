--- A look at the thing a link names, in frames of our own.
--
-- The client's tooltip cannot hold a model, so a preview is not a tooltip: it is
-- a frame this addon owns. Nothing here is protected or shared, so there is no
-- taint to take and nobody else's frame to fight over; the chat frame's hover
-- script is insecure and hands us the link, and what is drawn after that is
-- ours.
--
-- There are two ways to see one. Resting on a link shows it and leaving takes it
-- down, which costs nothing and interrupts nothing. Clicking pins it, and a
-- pinned look stays until it is closed, because the reason to pin is to put two
-- of them beside each other -- two morphs, the same spell at two stages -- and
-- a look that vanishes when the pointer moves cannot be compared with anything.
--
-- A pinned look is a window the player places, which is what every pinned thing
-- in this client is: the client's own pinned chat link, ItemRefTooltip, is
-- movable, toplevel, and closed with a button. So one appears where it was
-- asked for, is dragged wherever it is wanted, and rises above its fellows when
-- it is clicked. Nothing arranges them after that, because the player put them
-- where they are.
--
-- A part is looked at as one of the things in `SUBJECTS`, which is a row each
-- rather than a branch, so a creature or a piece of gear is a row when it is
-- built. A whole spell is not one of them: it is not a part, it is the thing the
-- parts belong to, and it is played rather than drawn.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Preview = {}
Epsilook.Preview = Preview

--- How large a look is, how far the next one is offset from the last, and how
-- many may be pinned at once.
--
-- It opens beside what was hovered, on whichever side of it has room: past the
-- middle of the screen it opens to the left, below the middle it grows upward.
-- That is how the transmogrification browser on this client does it, and it is
-- right for the reason a fixed corner is wrong -- a look far from the thing it
-- is of makes a reader watch two places at once -- while a look fixed to the
-- pointer near the foot of the screen has only the floor to be drawn in.
Preview.SIZE, Preview.GAP, Preview.MOST = 300, 24, 4

--- Which way a body is turned when it is first drawn, a little off straight on
-- so that it reads as a thing rather than a silhouette, and where the camera
-- stands to see it.
Preview.FACING = 0.6
Preview.DISTANCE, Preview.FIELD = 4, 1.2

--- One property of a part as the pack stores it, which for an id is the number
-- the client takes, and as it is spelled; nil where the part does not carry it.
--
-- ⛔ Read off the part's own declared properties rather than asked for by name.
-- A kind refuses a property it does not declare, and the kinds on one axis do
-- not agree on what they carry: an animation pose has no `id` where an anim kit
-- does, so asking every anim row for one throws on the third spell tried.
local function stored(part, name)
	for _, value in ipairs(Epsilook.Inspect.Values(part)) do
		if value.name == name then
			return value.stored, value.text
		end
	end
	return nil
end

--- The extensions of the files the client loads as a model.
local MODEL_FILES = { m2 = true, mdx = true }

--- The model file a part names, or nil where the file it names is not one.
--
-- ⛔ A part naming a file is not a part naming a model: a sound row names an
-- `.ogg` and a texture a `.blp`, both through the same path property. Handing
-- either to `SetModel` crashes the game outright rather than erroring, which is
-- no more survivable inside a `pcall` than the light was -- the native loader
-- reads the bytes as a model whatever they are. So the file is asked what it is
-- before it is drawn, which is also why this is not a question about the axis:
-- what makes a file drawable is the file.
-- @param part a PartData
function Preview.ModelOf(part)
	local fileID, path = Epsilook.Inspect.FileOf(part)
	if not fileID then
		return nil
	end
	local extension = (path or ""):match("%.([%a%d]+)$")
	if not (extension and MODEL_FILES[extension:lower()]) then
		return nil
	end
	return fileID
end

--- The first display a part names, or nil. A creature wears several and the
-- game picks one when it appears, so the first is the one shown.
-- @param part a PartData
function Preview.DisplayOf(part)
	local worn = Epsilook:GetPartDisplays(part)[1]
	if not worn then
		return nil
	end
	return worn.id
end

--- One moment of a cast, empty. `has` seeds a field with its one value, which
-- is how a lone subject becomes a sequence of one.
-- @param at the stage's stored number, or nil for a moment of its own
-- @param word how the stage is spelled
-- @param has a field name to the single id it holds
local function beat(at, word, has)
	local one = {
		stage = at or 0,
		word = word,
		mounts = {},
		displays = {},
		anims = {},
		animkits = {},
		kits = {},
	}
	for field, id in pairs(has or {}) do
		one[field] = { id }
	end
	return one
end

--- What can be looked at, and how, in the order a part is tried against them.
--
-- `from` is what the subject needs off a part, and a part offers a preview when
-- the first `from` resolves, so the order is which reading of a part wins where
-- it could be read two ways: a creature before the file it is built from,
-- because a display is that model already wearing its textures and the file
-- alone is a grey shape, and a mount before either, because you sit on one
-- rather than turn into one.
--
-- `put` is the whole of what happens to the look, so a subject is a row rather
-- than a row plus a branch somewhere else. The three ways to put something up
-- are named once each below and a subject picks one: looped, because an
-- animation runs through in about a second and a thing already over by the time
-- the eye reaches it is not a preview; seated, for the one thing a body carries
-- rather than becomes; and still, for a thing that simply is.
Preview.SUBJECTS = {
	{
		word = "animkit",
		from = function(part)
			if part.axis ~= "anim" then
				return nil
			end
			return stored(part, "id")
		end,
		put = function(frame, kitID)
			Preview.Loop(frame, "animkits", kitID)
		end,
	},
	{
		word = "anim",
		from = function(part)
			if part.axis ~= "anim" then
				return nil
			end
			return stored(part, "anim")
		end,
		put = function(frame, animation)
			Preview.Loop(frame, "anims", animation)
		end,
	},
	{
		word = "visual",
		from = function(part)
			if not (part.axis == "fx" and part.kind == "visual") then
				return nil
			end
			return stored(part, "id")
		end,
		put = function(frame, kitID)
			Preview.Loop(frame, "kits", kitID, true)
		end,
	},
	{
		word = "mount",
		from = function(part)
			if part.kind ~= "mount" then
				return nil
			end
			return Preview.DisplayOf(part)
		end,
		put = function(frame, displayID)
			Preview.Mount(frame, displayID)
		end,
	},
	{
		word = "creature",
		from = function(part)
			return Preview.DisplayOf(part)
		end,
		put = function(frame, displayID)
			Preview.Still(frame, "SetModelByCreatureDisplayID", displayID)
		end,
	},
	{
		word = "model",
		from = function(part)
			return Preview.ModelOf(part)
		end,
		put = function(frame, fileID)
			Preview.Still(frame, "SetModelByFileID", fileID)
		end,
	},
}

--- What a part can be looked at as, or nil: the first subject whose need it
-- meets, and the value that met it.
-- @param part a PartData
-- @return the subject and its value, or nil
function Preview.SubjectOf(part)
	for _, subject in ipairs(Preview.SUBJECTS) do
		local value = part and subject.from(part)
		if value then
			return subject, value
		end
	end
	return nil
end

--- Whether a part can be looked at at all, which is what decides whether a line
-- offers the word.
function Preview.Offers(part)
	return Preview.SubjectOf(part) ~= nil
end

--- Build one look. A frame is made when it is first wanted rather than at load,
-- since a player who never hovers one never needs any.
-- @param pinned whether it carries a close button
local function build(pinned)
	if not (_G.CreateFrame and _G.UIParent) then
		return nil
	end
	local frame = _G.CreateFrame("Frame", nil, _G.UIParent, "TooltipBorderedFrameTemplate")
	frame:SetSize(Preview.SIZE, Preview.SIZE)
	frame:SetFrameStrata("TOOLTIP")
	frame.scene = _G.CreateFrame("ModelScene", nil, frame)
	frame.scene:SetPoint("TOPLEFT", 6, -6)
	frame.scene:SetPoint("BOTTOMRIGHT", -6, 6)
	-- A scene draws nothing until it is told where to look from and what lights
	-- it. There is no camera in the scene's own right and no default: these are
	-- the numbers the addons on this client use for a figure filling a square.
	frame.scene:SetCameraPosition(Preview.DISTANCE, 0, 0)
	frame.scene:SetCameraOrientationByYawPitchRoll(math.pi, 0, 0)
	frame.scene:SetCameraFieldOfView(Preview.FIELD)
	frame.scene:SetLightDiffuseColor(0.8, 0.8, 0.8)
	frame.scene:SetLightAmbientColor(0.6, 0.6, 0.6)
	frame.scene:SetLightPosition(1, 0, 1)
	frame.scene:SetLightDirection(-1, 0, -1)
	frame.scene:SetLightVisible(true)
	frame.body = frame.scene:CreateActor(nil, "ModelSceneActorTemplate")
	frame.rider = frame.scene:CreateActor(nil, "ModelSceneActorTemplate")
	frame.rider:Hide()
	if pinned then
		-- What the client's own pinned chat link is: movable, above its fellows
		-- when clicked, and closed with a button.
		frame:SetMovable(true)
		frame:EnableMouse(true)
		frame:SetToplevel(true)
		frame:RegisterForDrag("LeftButton")
		frame:SetScript("OnDragStart", frame.StartMoving)
		frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
		frame.close = _G.CreateFrame("Button", nil, frame, "UIPanelCloseButton")
		frame.close:SetPoint("TOPRIGHT", 2, 2)
		frame.close:SetScript("OnClick", function()
			Preview.Unpin(frame)
		end)
		-- Above the model, or the model takes the click. A child frame is born at
		-- its parent's level plus one, so the model and the button sit at the same
		-- height and the model, which fills the frame, wins the ground they share:
		-- the button answered only on the two pixels hanging off the corner, which
		-- is what an unclickable close button looks like from the outside.
		frame.close:SetFrameLevel(frame.scene:GetFrameLevel() + 5)
		-- A pinned look is looked at, so it turns and it zooms.
		frame:EnableMouseWheel(true)
		frame:SetScript("OnMouseWheel", function(_, direction)
			-- The camera walks in and out rather than the model growing, which is
			-- the only zoom a scene has and the truer one anyway.
			frame.distance =
				math.max(1, math.min(20, (frame.distance or Preview.DISTANCE) - direction * 0.4))
			frame.scene:SetCameraPosition(frame.distance, 0, 0)
		end)
		frame.scene:EnableMouse(true)
		frame.scene:SetScript("OnMouseDown", function()
			frame.turning = select(1, _G.GetCursorPosition())
		end)
		frame.scene:SetScript("OnMouseUp", function()
			frame.turning = nil
		end)
		-- Where it is facing is kept here rather than asked back, so that turning
		-- it is arithmetic on a number this frame owns rather than a round trip
		-- through the model on every frame.
		frame.scene:SetScript("OnUpdate", function()
			if frame.turning then
				local at = select(1, _G.GetCursorPosition())
				frame.facing = (frame.facing or Preview.FACING) + (at - frame.turning) / 80
				frame.body:SetYaw(frame.facing)
				frame.turning = at
			end
		end)
	end
	frame:Hide()
	return frame
end

--- How long one beat of a sequence is held, and how long the last of them
-- stands before the body is cleared and it runs again.
Preview.BEAT, Preview.REST = 1.2, 2

--- Put the player back on the body actor, which is both how a look starts and
-- how a loop wipes what the last run applied to it.
-- @param frame the look
function Preview.Body(frame)
	Preview.Clear(frame)
	frame.body:SetModelByUnit("player")
	frame.body:SetPosition(0, 0, 0)
	frame.body:SetYaw(frame.facing or Preview.FACING)
end

--- Take everything off both actors: the models, and what was playing on them.
--
-- ⚠ What the client itself does to reset an actor, rather than relying on a new
-- model to clear the old one's kits and animation. Loading a model is not
-- documented to stop what was playing, and the client does not rely on it.
-- @param frame the look
function Preview.Clear(frame)
	for _, actor in ipairs({ frame.body, frame.rider }) do
		pcall(actor.StopAnimationKit, actor)
		pcall(actor.SetSpellVisualKit, actor, nil)
		pcall(actor.SetAnimation, actor, 0)
		pcall(actor.SetScale, actor, 1)
		actor:ClearModel()
	end
	frame.rider:Hide()
end

--- Seat the player on a mount, which is what the game's own mount list shows
-- and what a reader asking about a mount is asking to see.
--
-- ⛔ The order is the client's own, from the list that does this: the mount
-- takes the display and an idle, the rider is scaled by what the mount says it
-- needs rather than by anything we choose, and `AttachToMount` is what puts one
-- on the other. A rider scaled by hand rides through the saddle.
-- @param frame the look
-- @param displayID the mount's creature display
function Preview.Mount(frame, displayID)
	Preview.Clear(frame)
	frame.body:SetPosition(0, 0, 0)
	frame.body:SetYaw(frame.facing or Preview.FACING)
	if not pcall(frame.body.SetModelByCreatureDisplayID, frame.body, displayID) then
		return false
	end
	frame.body:SetAnimation(0)
	frame.rider:Show()
	-- The second argument sheathes the rider's weapons, which is how the client's
	-- own list asks for it.
	local seated, riding = pcall(frame.rider.SetModelByUnit, frame.rider, "player", true)
	if not (seated and riding) then
		-- The mount alone is still the answer to what the spell gives you, and
		-- the client's own list takes the same way out when a rider will not load.
		frame.rider:Hide()
		return true
	end
	local fitted, scale = pcall(frame.body.CalculateMountScale, frame.body, frame.rider)
	if fitted and scale and scale ~= 0 then
		frame.rider:SetScale(1 / scale)
	end
	pcall(frame.body.AttachToMount, frame.body, frame.rider, 0)
	return true
end

--- Put everything one stage of a spell does on a body at once, since a stage is
-- a moment rather than a list: the pose first, then what is drawn over it.
-- @param model the model frame
-- @param stage one entry of a sequence
local function stand(frame, stage)
	local actor = frame.body
	if stage.mounts[1] then
		-- Instead of the plain displays rather than before them: a body cannot
		-- both turn into something and sit on it, and a morph laid over a mount
		-- leaves the rider seated on whatever the body became.
		Preview.Mount(frame, stage.mounts[1])
	else
		for _, display in ipairs(stage.displays) do
			-- First, because it replaces the body the rest of this stage happens
			-- to: a spell that turns its target into something and then has it
			-- move is the something moving.
			pcall(actor.SetModelByCreatureDisplayID, actor, display)
		end
	end
	for _, anim in ipairs(stage.anims) do
		pcall(actor.SetAnimation, actor, anim)
	end
	for _, kit in ipairs(stage.animkits) do
		pcall(actor.PlayAnimationKit, actor, kit)
	end
	for _, kit in ipairs(stage.kits) do
		pcall(actor.SetSpellVisualKit, actor, kit)
	end
end

--- Run a sequence on a body, one beat at a time, over and over.
--
-- A spell is a sequence and not a picture, so this plays it as one: each stage
-- goes on in cast order, layering the way it layers during a real cast. The
-- whole spell at once would be every stage happening simultaneously, which is a
-- thing the spell never does.
--
-- The last beat is held for the rest as well as its own turn, because for most
-- spells the last stage is the aura -- what the spell LEAVES, which is what a
-- reader is usually asking after. Then the body is cleared and it starts again.
-- A single animation is a sequence of one, so it loops by the same clock.
-- @param frame a look whose `sequence` is set
local function play(frame)
	frame.at, frame.due = 0, 0
	local function stop()
		frame:SetScript("OnUpdate", nil)
	end
	local tick = function(_, elapsed)
		frame.due = frame.due - elapsed
		if frame.due > 0 then
			return
		end
		frame.at = frame.at + 1
		local stage = frame.sequence and frame.sequence[frame.at]
		if stage then
			if frame.at == frame.hold then
				frame.due = Preview.BEAT + Preview.REST
			else
				frame.due = Preview.BEAT
			end
			stand(frame, stage)
		else
			-- Setting the body again is what takes the applied visuals back off it.
			-- ⛔ Not `RefreshUnit`, which is the same addon's path for a unit that is
			-- not the player; for the player it sets the model by unit instead, and
			-- this frame only ever shows the player.
			frame.at, frame.due = 0, 0
			Preview.Body(frame)
		end
	end
	-- ⚠ A clock runs every frame, so a fault in it faults every frame. It is
	-- reported once and then stopped, which leaves a still look rather than an
	-- error per frame for as long as the look is up.
	local shell = Epsilook.Shell
	if shell and shell.Safely then
		tick = shell.Safely(tick, stop)
	end
	frame:SetScript("OnUpdate", tick)
end

--- Put one thing up and leave it there, which is every subject that is a thing
-- rather than something happening.
-- @param frame the look
-- @param method the actor method that takes this kind of id
-- @param id the id
function Preview.Still(frame, method, id)
	pcall(frame.body[method], frame.body, id)
	frame.body:SetPosition(0, 0, 0)
	frame.body:SetYaw(frame.facing or Preview.FACING)
end

--- Play one thing on the player's own body, over and over, as a sequence of
-- one.
--
-- Whether it rests is the subject's to say. An animation runs through in about
-- a second and has no final state, so resting after it is dead air before the
-- replay; a visual kit often runs longer than a beat, and wiping it at the
-- beat's end shows only its opening.
-- @param frame the look
-- @param field which of a beat's lists it belongs in
-- @param id the id
-- @param rests whether the one beat is held through the rest
function Preview.Loop(frame, field, id, rests)
	Preview.Body(frame)
	frame.sequence = { beat(nil, nil, { [field] = id }) }
	frame.hold = rests and 1 or nil
	play(frame)
end

--- Put a subject on a frame, the same way whether it is hovered or pinned.
--
-- ⚠ The frame must already be SHOWN. A model frame applies nothing while it is
-- hidden, so a model set first and shown after is a model the frame quietly
-- drops -- and a `PlayerModel` that has ever held a unit puts the unit back up
-- instead, which reads as every preview showing the player.
local function draw(frame, part)
	local subject, value = Preview.SubjectOf(part)
	if not (frame and frame.body and subject) then
		return false
	end
	-- A frame is reused, so whatever was running on it stops: a sequence left
	-- ticking would keep laying its own beats over whatever is drawn next.
	frame.sequence = nil
	frame:SetScript("OnUpdate", nil)
	frame.body:ClearModel()
	frame.rider:ClearModel()
	frame.rider:Hide()
	frame.facing = Preview.FACING
	subject.put(frame, value)
	return true
end

--- The one frame a hover uses, made once.
local hovered

--- The looks that have been pinned, oldest first.
local pinned = {}

--- Which corner of a look should meet which corner of what it opens beside, so
-- that it grows into the screen rather than off it. Past halfway across, it
-- opens to the left of its owner; past halfway down, it grows upward.
-- @param x, y where on the screen the thing being opened beside is
-- @return the look's own point, and the point on its owner to meet
local function sides(x, y)
	local width = _G.GetScreenWidth and _G.GetScreenWidth() or 1
	local height = _G.GetScreenHeight and _G.GetScreenHeight() or 1
	local mine, theirs = "LEFT", "RIGHT"
	if width > 0 and x / width > 0.5 then
		mine, theirs = "RIGHT", "LEFT"
	end
	if height > 0 and y / height > 0.5 then
		return "TOP" .. mine, "TOP" .. theirs
	end
	return "BOTTOM" .. mine, "BOTTOM" .. theirs
end

--- Where the pointer is, in the units a frame is placed in.
local function cursor()
	local x, y
	if _G.GetCursorPosition then
		x, y = _G.GetCursorPosition()
	end
	local scale = _G.UIParent and _G.UIParent:GetEffectiveScale()
	if not (x and y and scale and scale > 0) then
		return nil
	end
	return x / scale, y / scale
end

--- Put a look beside the tooltip that is already up for the same link, so the
-- words and the look are read in one place, falling back to the pointer.
-- @param frame the look
function Preview.Place(frame)
	local owner = _G.GameTooltip
	local x, y = cursor()
	frame:ClearAllPoints()
	if owner and owner.IsShown and owner:IsShown() and x then
		local mine, theirs = sides(x, y)
		frame:SetPoint(mine, owner, theirs, 0, 0)
	elseif x then
		local mine = sides(x, y)
		frame:SetPoint(mine, _G.UIParent, "BOTTOMLEFT", x, y)
	else
		frame:SetPoint("CENTER")
	end
end

--- The order a spell's stages are played in, and the one a reader is left
-- looking at.
--
-- ⚠ A stage's stored number is NOT its running order, though seven of the nine
-- fall that way by luck. The channel runs with the cast rather than after the
-- aura, and launch is the server's own moment rather than one of the client's,
-- numbered past the end of them; sorting on the number alone puts both after
-- the spell has finished.
--
-- `HELD` is the stage the loop rests on, because a loop has to settle
-- somewhere and the question a reader is usually asking of a spell is what it
-- LEAVES. ⛔ That is the aura by name and not the last stage.
--
-- ⛔ And `ENDED` is not played at all. On this server an aura runs until it is
-- cancelled, so the stage where it ends is not a stage of the spell running: it
-- is what the player sees when they choose to stop it. Playing it would say
-- every spell undoes itself a moment after it lands, which is the opposite of
-- what an aura does here. It stays reachable on its own row, like any other
-- visual kit.
Preview.ORDER = {
	none = 1,
	precast = 2,
	precastend = 3,
	cast = 4,
	channel = 5,
	channelend = 6,
	launch = 7,
	travel = 8,
	travelend = 9,
	impact = 10,
	trigger = 11,
	triggerend = 12,
	oneshot = 13,
	aura = 14,
	auraend = 15,
}
Preview.HELD = "aura"
Preview.ENDED = "auraend"

--- Where a stage falls in the running order. A word this file does not know
-- keeps its number and follows the ones it does, so a stage the pack learns
-- later plays at the end rather than not at all.
local function rank(stage)
	local known = Preview.ORDER[stage.word or ""]
	if known then
		return known
	end
	-- Past every rank above, since `ORDER` is keyed by word and so has no length
	-- to count; a stage keeps its own number to order it among its fellows.
	return 100 + stage.stage
end

--- The kinds that put a creature on the caster's own body, and where each one
-- happens: a morph or a shapeshift at the stage it names, a mount at the stage
-- the loop holds, since a mount carries no stage and being mounted is what the
-- spell leaves.
--
-- ⚠ A mount is drawn as the mount alone, the way the client's own mount list
-- draws one. A rider on it wants two actors and one model frame has one.
local BODIES = { morph = "own", shapeshift = "own", mount = "held" }

--- The stage a part happens at, as the pack stores it and as it is spelled. A
-- part that names no stage is one moment of its own, before every named one.
local function phaseOf(part)
	local at, word = stored(part, "phase")
	if word == "" then
		word = nil
	end
	return at or 0, word
end

--- One id gathered against the stage it happens at, refusing a repeat. A row
-- exists once per audience, so the same thing at the same stage arrives twice.
local function gather(stages, order, at, field, id, seen)
	local stage, word = at[1], at[2]
	-- Keyed by the word where there is one. A stage is a moment, and a row that
	-- names the moment in words belongs with the others that name it the same,
	-- whether or not the two were stored against one number -- which is what lets
	-- a row carrying no stage of its own be placed at one by name.
	local key = word or ("#" .. stage)
	local once = key .. ":" .. field .. ":" .. tostring(id)
	if not id or seen[once] then
		return
	end
	seen[once] = true
	if not stages[key] then
		stages[key] = beat(stage, word)
		order[#order + 1] = stages[key]
	end
	local into = stages[key][field]
	into[#into + 1] = id
end

--- What a spell does at each of its stages, in the order it is cast.
--
-- A spell is not a set of visual kits: at any stage the body is also holding a
-- pose and playing an animation, and a cast read without them is a cast with
-- the caster standing still through it. The anim axis carries both -- an anim
-- kit, which is a sequence with a bone set and a speed, and a loose animation --
-- and both are stamped with the same stage the visual kits are, so the three
-- gather into one timeline without anything having to be matched up.
-- @param spellID the spell
-- @return a list of `{stage, kits, animkits, anims}`, the first cast first
function Preview.SequenceOf(spellID)
	local stages, order, seen = {}, {}, {}
	for _, axis in ipairs({ "fx", "model" }) do
		for i = 1, Epsilook:GetNumParts(spellID, axis) do
			-- A row of a kind this reader does not know, from a newer pack, comes
			-- back as nothing and is stepped over.
			local part = Epsilook:GetPartDataByIndex(spellID, axis, i)
			local kind = part and part.kind
			if kind == "visual" then
				gather(stages, order, { phaseOf(part) }, "kits", stored(part, "id"), seen)
			elseif BODIES[kind] then
				-- ⛔ These two kinds by name, not anything that names a creature: a
				-- summon names one too, and putting the summoned creature on the
				-- caster's body says the caster turned into what they called up.
				local displays = Epsilook:GetPartDisplays(part)
				local first = displays[1] and displays[1].id or nil
				local at, word = phaseOf(part)
				local field = "displays"
				if BODIES[kind] == "held" then
					-- A mount names no stage of its own, and does not need to: being
					-- mounted is what the spell LEAVES, which is the stage held anyway.
					word, field = Preview.HELD, "mounts"
				end
				gather(stages, order, { at, word }, field, first, seen)
			end
		end
	end
	for i = 1, Epsilook:GetNumParts(spellID, "anim") do
		local part = Epsilook:GetPartDataByIndex(spellID, "anim", i)
		if part then
			local at = { phaseOf(part) }
			-- An anim kit names its own animation as well, and playing both would
			-- be the kit fighting the animation underneath it; the kit is the
			-- fuller reading, so a row that has one contributes only that.
			local kit = stored(part, "id")
			if kit then
				gather(stages, order, at, "animkits", kit, seen)
			else
				gather(stages, order, at, "anims", stored(part, "anim"), seen)
			end
		end
	end
	-- The cast, and no further. See `ENDED` above.
	local run = {}
	for _, each in ipairs(order) do
		if each.word ~= Preview.ENDED then
			run[#run + 1] = each
			each.at = #run
		end
	end
	order = run
	table.sort(order, function(a, b)
		if rank(a) ~= rank(b) then
			return rank(a) < rank(b)
		end
		return a.at < b.at
	end)
	-- ⛔ Last by construction rather than by where `ORDER` put it. A stage no
	-- word here names sorts after every one that is named, and left there it is
	-- what the loop would settle on, which is the one thing the loop promises it
	-- will not settle on.
	for at, each in ipairs(order) do
		if each.word == Preview.HELD then
			table.remove(order, at)
			order[#order + 1] = each
			break
		end
	end
	return order
end

--- Which beat of a sequence the loop settles on: the last, which is the aura
-- whenever the spell has one, since SequenceOf puts it there.
-- @param sequence as SequenceOf gives it
-- @return the index to hold
function Preview.HoldOf(sequence)
	return #sequence
end

--- Show what a whole spell looks like, on the player's own body.
--
-- This is the one a reader wants most and the only one they can have without
-- opening a spell: a page of results is twenty names, and the question asked of
-- every one of them is what it looks like. So resting on a spell answers it,
-- wherever the spell is named.
-- @param spellID the spell
-- @return whether there was anything to show
function Preview.Spell(spellID)
	local sequence = Preview.SequenceOf(spellID)
	if #sequence == 0 then
		return false
	end
	if not hovered then
		hovered = build(false)
	end
	if not (hovered and hovered.body) then
		return false
	end
	Preview.Place(hovered)
	hovered:Show()
	hovered.facing = Preview.FACING
	Preview.Body(hovered)
	hovered.sequence, hovered.hold = sequence, Preview.HoldOf(sequence)
	play(hovered)
	return true
end

--- Show a part while it is hovered, above the chat where there is room.
-- @param part a PartData
-- @return whether there was something to show
function Preview.Hover(part)
	if not Preview.Offers(part) then
		return false
	end
	if not hovered then
		hovered = build(false)
	end
	if not (hovered and hovered.body) then
		return false
	end
	Preview.Place(hovered)
	hovered:Show()
	return draw(hovered, part)
end

--- Take the hovered look down. A pinned one is not touched.
function Preview.Leave()
	if hovered then
		hovered:Hide()
	end
end

--- Closed looks, kept for the next one to be pinned.
--
-- ⚠ The client never frees a frame, so a look built per pin and hidden when
-- closed is a look that stays in memory for the session, still holding its
-- models. Forty pins would be forty scenes with four on screen.
local spare = {}

--- Put a look down: its clock stopped, its models released, and the frame
-- kept for reuse.
local function release(frame)
	frame:SetScript("OnUpdate", nil)
	frame.sequence, frame.distance, frame.turning = nil, nil, nil
	-- A reused look opens where a new one would, not where its last owner left
	-- the camera.
	frame.scene:SetCameraPosition(Preview.DISTANCE, 0, 0)
	Preview.Clear(frame)
	frame:Hide()
	spare[#spare + 1] = frame
end

--- Where a newly pinned look goes: at the pointer the first time, and after
-- that a step past the look pinned last, in the direction that keeps it on
-- the screen and off the link that was clicked.
--
-- Off the last look's own position rather than off how many are up. A count
-- repeats itself once the oldest starts being closed, and a new look landing
-- exactly on the one before it reads as the click having done nothing.
local function placed(frame)
	local x, y = cursor()
	local mine = x and sides(x, y) or "CENTER"
	local last = pinned[#pinned]
	frame:ClearAllPoints()
	if last and last:IsShown() and last:GetLeft() then
		local across = Preview.GAP
		if mine:find("RIGHT") then
			across = -across
		end
		local down = -Preview.GAP
		if mine:find("BOTTOM") then
			down = Preview.GAP
		end
		frame:SetPoint(
			"BOTTOMLEFT",
			_G.UIParent,
			"BOTTOMLEFT",
			last:GetLeft() + across,
			last:GetBottom() + down
		)
	elseif x then
		frame:SetPoint(mine, _G.UIParent, "BOTTOMLEFT", x, y)
	else
		frame:SetPoint("CENTER")
	end
end

--- Keep a look until it is closed. The oldest goes when there are too many, so
-- that a click always shows something rather than quietly doing nothing.
-- @param part a PartData
-- @return whether it was pinned
function Preview.Pin(part)
	if not Preview.Offers(part) then
		return false
	end
	local frame = table.remove(spare) or build(true)
	if not (frame and frame.body) then
		return false
	end
	placed(frame)
	table.insert(pinned, frame)
	while #pinned > Preview.MOST do
		release(table.remove(pinned, 1))
	end
	frame:Show()
	return draw(frame, part)
end

--- Close one pinned look. The others stay where the player put them.
function Preview.Unpin(frame)
	for index, each in ipairs(pinned) do
		if each == frame then
			table.remove(pinned, index)
			break
		end
	end
	release(frame)
end

--- How many looks are pinned, which is what a test asks.
function Preview.Pinned()
	return #pinned
end

return Preview

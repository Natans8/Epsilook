--- The settings panel, drawn from the declarations.
--
-- The client half of `Config`: it names no setting of its own, but walks
-- `Config.SETTINGS` and draws the control each one's kind calls for, so a
-- setting added there appears here with nothing written. Every client global
-- is reached through `_G` and guarded, so the file loads under a bare
-- interpreter and simply builds nothing.
--
-- The panel is registered with the client's own interface options, which is
-- where a player looks for an addon's settings; the shell's `options` word
-- opens it for anyone who would rather type.

_G.Epsilook = _G.Epsilook or {}
local Epsilook = _G.Epsilook

local Options = {}
Epsilook.Options = Options

local Config = Epsilook.Config

--- The addon's own name, as the panel is titled and the saved variables are
-- keyed.
Options.NAME = "Epsilook"
Options.STORE = "EpsilookSettings"

--- How wide the panel's controls are drawn, and how far apart their rows sit.
local WIDTH, ROW = 320, 64

--- The chat windows a player may send output to: the default, then each of
-- the client's own windows by its tab's name. A window with no name is one
-- the player has not made, and is left out.
-- @return a list of { value, text }
function Options.Frames()
	local out = { { value = Config.DEFAULT_FRAME, text = "Default" } }
	local named, count = _G.GetChatWindowInfo, _G.NUM_CHAT_WINDOWS
	if not named or not count then
		return out
	end
	for i = 1, count do
		local name = named(i)
		if name and name ~= "" then
			out[#out + 1] = { value = i, text = name }
		end
	end
	return out
end

--- What a frame setting reads as in words, for a menu's closed state.
-- @param value the stored window number
-- @return the window's name, or the default's word
function Options.FrameText(value)
	for _, frame in ipairs(Options.Frames()) do
		if frame.value == value then
			return frame.text
		end
	end
	return "Default"
end

--- Store a chosen value and let the client save it.
local function choose(key, value)
	Config.Set(key, value)
	Config.Save(key)
end

--- One slider for a number setting.
local function slider(panel, setting, y)
	local name = Options.NAME .. "Option" .. setting.key
	local control = _G.CreateFrame("Slider", name, panel, "OptionsSliderTemplate")
	control:SetPoint("TOPLEFT", 16, y)
	control:SetWidth(WIDTH)
	control:SetMinMaxValues(setting.min, setting.max)
	control:SetValueStep(setting.step)
	control:SetObeyStepOnDrag(true)
	control:SetValue(Config.Get(setting.key))
	local label, low, high = _G[name .. "Text"], _G[name .. "Low"], _G[name .. "High"]
	if low then
		low:SetText(tostring(setting.min))
	end
	if high then
		high:SetText(tostring(setting.max))
	end
	local function retitle(value)
		if label then
			label:SetText(setting.label .. ": " .. value)
		end
	end
	retitle(Config.Get(setting.key))
	control:SetScript("OnValueChanged", function(_, value)
		local fitted = Config.Fit(setting, value)
		if fitted then
			choose(setting.key, fitted)
			retitle(fitted)
		end
	end)
	return control
end

--- One dropdown for a chat-window setting. The menu is rebuilt every time it
-- opens, because a player may name a window while the panel is up.
local function dropdown(panel, setting, y)
	local name = Options.NAME .. "Option" .. setting.key
	local control = _G.CreateFrame("Frame", name, panel, "UIDropDownMenuTemplate")
	control:SetPoint("TOPLEFT", 0, y - 18)
	local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormal")
	title:SetPoint("BOTTOMLEFT", control, "TOPLEFT", 20, 2)
	title:SetText(setting.label)
	local set, text = _G.UIDropDownMenu_SetWidth, _G.UIDropDownMenu_SetText
	if set then
		set(control, WIDTH - 40)
	end
	if text then
		text(control, Options.FrameText(Config.Get(setting.key)))
	end
	if _G.UIDropDownMenu_Initialize then
		_G.UIDropDownMenu_Initialize(control, function()
			for _, frame in ipairs(Options.Frames()) do
				local info = _G.UIDropDownMenu_CreateInfo()
				info.text = frame.text
				info.checked = frame.value == Config.Get(setting.key)
				info.func = function()
					choose(setting.key, frame.value)
					if text then
						text(control, frame.text)
					end
				end
				_G.UIDropDownMenu_AddButton(info)
			end
		end)
	end
	return control
end

--- The panel, built once.
local panel

--- Build the settings panel and register it with the client's own interface
-- options. Does nothing where the client's frames are absent.
-- @return the panel, or nil
function Options.Panel()
	if panel or not _G.CreateFrame then
		return panel
	end
	panel = _G.CreateFrame("Frame")
	panel.name = Options.NAME
	local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
	title:SetPoint("TOPLEFT", 16, -16)
	title:SetText(Options.NAME)
	local y = -56
	for _, setting in ipairs(Config.SETTINGS) do
		local hint = panel:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
		hint:SetPoint("TOPLEFT", 16, y)
		hint:SetWidth(WIDTH)
		hint:SetJustifyH("LEFT")
		hint:SetText(setting.hint)
		y = y - 24
		if setting.kind == "number" then
			slider(panel, setting, y - 8)
		else
			dropdown(panel, setting, y)
		end
		y = y - ROW
	end
	if _G.InterfaceOptions_AddCategory then
		_G.InterfaceOptions_AddCategory(panel)
	end
	return panel
end

--- Show the settings panel. The client's own opener does not land on the
-- first call from an addon, so it is called twice, as every addon that opens
-- its own panel does.
function Options.Show()
	local built = Options.Panel()
	local open = _G.InterfaceOptionsFrame_OpenToCategory
	if built and open then
		open(built)
		open(built)
	end
end

--- Take the saved settings when the client hands them over, and build the
-- panel. Registered here rather than in `Config`, which never touches the
-- client.
local function install()
	if not _G.CreateFrame then
		return
	end
	local watcher = _G.CreateFrame("Frame")
	watcher:RegisterEvent("ADDON_LOADED")
	watcher:SetScript("OnEvent", function(self, _, addon)
		if addon ~= Options.NAME then
			return
		end
		_G[Options.STORE] = Config.Load(_G[Options.STORE])
		Options.Panel()
		self:UnregisterEvent("ADDON_LOADED")
	end)
end

install()

"""The word one spell-to-spell edge prints.

An edge exists because some effect row on the source spell triggers the target.
What the edge SAYS is a naming decision over that row's effect and aura, which
is why it lives here rather than in the route that reads the rows: the enum
names it falls back to are resolved per build.
"""

from __future__ import annotations

from collections.abc import Mapping

# A word is listed here only where several enum spellings name one
# relationship, so the list collapses them. Anything else falls back to its own
# enum name, lowercased and de-underscored, which tells a reader where the edge
# came from without claiming more than the enum does.
#
# Rewording a LONE enum is the mistake this table is careful not to make: one
# spelling has nothing to collapse, so a reword is a second name for one thing
# and it always claims a little more than the original. Several entries were
# removed for exactly that -- an area trigger reworded to "in its area"
# asserted the linked spell fires on units inside, which the enum never says.
LINK_KIND_BY_AURA = {
    # (a) the aura names a trigger and the word says WHEN it fires.
    #
    # "periodically" is the interval without its length. The length sits in
    # EffectAuraPeriod and printing it -- "every 1s", "every 3s" -- would be the
    # exact word rather than the merely honest one. It is declined rather than
    # pending: it needs the period in the pack, it fragments one word into some
    # forty, and it puts numbers into the mechanics corpus, which is the
    # substring-noise trap the spell id is kept out of.
    23: "periodically",  # PERIODIC_TRIGGER_SPELL
    227: "periodically",  # PERIODIC_TRIGGER_SPELL_WITH_VALUE
    48: "periodically",  # PERIODIC_TRIGGER_SPELL_FROM_CLIENT
    42: "on proc",  # PROC_TRIGGER_SPELL
    231: "on proc",  # PROC_TRIGGER_SPELL_WITH_VALUE
    360: "on proc",  # PROC_TRIGGER_SPELL_COPY
    43: "on proc",  # PROC_TRIGGER_DAMAGE
    394: "on confirm",  # SHOW_CONFIRMATION_PROMPT
    469: "on confirm",  # SHOW_CONFIRMATION_PROMPT_WITH_DIFFICULTY
    468: "on low health",  # TRIGGER_SPELL_ON_HEALTH_BELOW_PCT
    # both fire when power reaches a level, absolute on one and relative on the
    # other; "on power" read as "powered on" and named neither
    396: "on power level",  # TRIGGER_SPELL_ON_POWER_AMOUNT
    328: "on power level",  # TRIGGER_SPELL_ON_POWER_PCT
    495: "when it expires",  # TRIGGER_SPELL_ON_EXPIRE
    406: "on a key",  # KEYBOUND_OVERRIDE (the keybind route shows the key itself)

    # (b) one relationship under several spellings.
    284: "linked",  # LINKED
    285: "linked",  # LINKED_2
    361: "replaces autoattack",  # OVERRIDE_AUTOATTACK_WITH_MELEE_SPELL
    367: "replaces autoattack",  # OVERRIDE_AUTOATTACK_WITH_RANGED_SPELL
    # The one judgement call left in either table, kept deliberately. This has
    # no spellings to collapse within this dict, but it is the same relationship
    # as the dummy and script effects below: the engine does nothing and a
    # script does the work. The bare fallback would say less than nothing.
    # The periodic form is not folded in, since being periodic is the fact that
    # distinguishes it and the fallback keeps both halves.
    4: "by script",  # DUMMY
}
LINK_KIND_BY_EFFECT = {
    # (a) names a trigger, and the word says WHEN. These three also satisfy (b).
    64: "on cast",  # TRIGGER_SPELL
    142: "on cast",  # TRIGGER_SPELL_WITH_VALUE
    151: "on cast",  # TRIGGER_SPELL_2

    # (b) one relationship under several spellings.
    32: "as a missile",  # TRIGGER_MISSILE
    148: "as a missile",  # TRIGGER_MISSILE_SPELL_WITH_VALUE
    # WHO casts it is the essential fact here — the TARGET does, not you
    140: "forced on target",  # FORCE_CAST
    141: "forced on target",  # FORCE_CAST_WITH_VALUE
    160: "forced on target",  # FORCE_CAST_2
    164: "removes",  # REMOVE_AURA
    203: "removes",  # REMOVE_AURA_2
    36: "teaches",  # LEARN_SPELL
    57: "teaches",  # LEARN_PET_SPELL
    # seven spellings of one relationship, and the word says when: the movement
    # finishes, then the spell is cast
    41: "on landing",  # JUMP
    42: "on landing",  # JUMP_DEST
    213: "on landing",  # JUMP_DEST_2
    254: "on landing",  # JUMP_CHARGE
    138: "on landing",  # LEAP_BACK
    96: "on landing",  # CHARGE
    149: "on landing",  # CHARGE_DEST
    3: "by script",  # DUMMY
    77: "by script",  # SCRIPT_EFFECT
    # 179 CREATE_AREATRIGGER and 182 DESPAWN_AREATRIGGER both fall back. 182 is
    # the OPPOSITE of 179 and used to share its word; 179's "in its area" then
    # went too, because a lone enum has nothing to collapse and the phrase
    # asserted a firing condition (units inside it) that CREATE_AREATRIGGER
    # never states.
}

def link_kind_word(effect: int, aura: int, effect_names: Mapping[int, str],
                   aura_names: Mapping[int, str]) -> str:
    """The word one edge prints, from the effect or aura that owns it.

    An APPLY_AURA row is described by its AURA -- the effect says only "applies
    an aura", which every one of them does -- and anything else by its effect.

    An unlisted value falls back to the enum's own name, lowercased and
    de-underscored, which is the same fallback an unknown effect or aura id
    gets elsewhere. That tail is honestly "the aura this came from" rather than
    a relationship, and it SHIPS rather than being dropped because some spells
    reach a visual only through one of those edges.

    An id the enum table does not name at all falls back to `aura N` / `effect
    N`, never the empty string, which would render a note-shaped hole.
    """
    if aura:
        return (LINK_KIND_BY_AURA.get(aura)
                or aura_names.get(aura, "").lower().replace("_", " ")
                or f"aura {aura}")
    return (LINK_KIND_BY_EFFECT.get(effect)
            or effect_names.get(effect, "").lower().replace("_", " ")
            or f"effect {effect}")

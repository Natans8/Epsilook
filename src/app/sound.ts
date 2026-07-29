import {CFG} from "../config";
/* ------------------------------------------------- sound playback (▶) */

// One shared player — starting a sound stops the previous one. Audio is
// streamed from Wowhead's CDN only on click, never preloaded (same house
// rule as the hotlinked icons).
let nowPlaying: { audio: HTMLAudioElement; btn: HTMLElement } | null = null;

function stopSound(): void {
    if (!nowPlaying) return;
    nowPlaying.audio.pause();
    nowPlaying.audio.src = "";
    setPlayGlyph(nowPlaying.btn, "▶");
    nowPlaying = null;
}

function setPlayGlyph(btn: HTMLElement, glyph: string): void {
    btn.textContent = glyph;
    btn.classList.toggle("playing", glyph === "■");
    btn.classList.toggle("loading", glyph === "◌");
}

export function toggleSound(btn: HTMLElement): void {
    const wasThis = nowPlaying && nowPlaying.btn === btn;
    stopSound();
    if (wasThis) return;

    const audio = new Audio(btn.dataset.play);
    audio.volume = Math.min(1, Math.max(0, CFG.soundVolume ?? 0.5));
    nowPlaying = {audio, btn};
    setPlayGlyph(btn, "◌");

    const isCurrent = () => nowPlaying && nowPlaying.audio === audio;
    audio.addEventListener("playing", () => {
        if (isCurrent()) setPlayGlyph(btn, "■");
    });
    audio.addEventListener("ended", () => {
        if (isCurrent()) stopSound();
    });
    audio.addEventListener("error", () => {
        if (!isCurrent()) return;
        nowPlaying = null;
        setPlayGlyph(btn, "✕");
        btn.title = "This sound is unavailable on Wowhead's CDN";
        setTimeout(() => {
            if (btn.textContent === "✕") setPlayGlyph(btn, "▶");
        }, 1500);
    });
    audio.play().catch(() => {
    }); // failures surface via the error listener
}

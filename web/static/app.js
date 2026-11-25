const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const SETTINGS_STORAGE_KEY = 'spotyboty_settings_v1';
const LAST_TRACK_STORAGE_KEY = 'spotyboty_last_track_v1';

const ACCENT_PRESETS = {
    spotify: { accent: '#1db954', hover: '#1ed760' },
    telegram: { accent: 'var(--tg-theme-button-color, #2ea6ff)', hover: 'color-mix(in srgb, var(--tg-theme-button-color, #2ea6ff) 85%, #ffffff 15%)' },
    purple: { accent: '#a855f7', hover: '#c084fc' },
    pink: { accent: '#ec4899', hover: '#f472b6' },
    orange: { accent: '#f97316', hover: '#fb923c' },
    cyan: { accent: '#06b6d4', hover: '#22d3ee' },
};

const DEFAULT_SETTINGS = {
    accent: 'spotify',
    fpTheme: 'auto', // 'auto' | 'dark' | 'light'
    sortOrder: 'newest', // 'newest' | 'oldest' | 'title' | 'artist'
    density: 'normal', // 'normal' | 'compact'
    coverStyle: 'square', // 'square' | 'vinyl'
    playbackRate: 1,
    audioFade: true,
    autoNext: true,
    equalizer: true,
    ambientBg: true,
    showSendBtn: true,
    hideDeleteBtn: false,
    autoOpenPlayer: false,
    rememberLastTrack: true,
    autoScroll: true,
    marquee: true,
    reducedMotion: false,
    haptic: true,
};

function loadUserSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

let userSettings = loadUserSettings();
let isSettingsOpen = false;

function saveUserSettings() {
    try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(userSettings));
    } catch (e) {}
}

function getEffectiveFullPlayerTheme() {
    if (userSettings.fpTheme === 'dark' || userSettings.fpTheme === 'light') {
        return userSettings.fpTheme;
    }
    return tg.colorScheme || 'dark';
}

function applyTelegramTheme() {
    const scheme = tg.colorScheme || 'dark';
    const fpTheme = getEffectiveFullPlayerTheme();
    document.documentElement.dataset.theme = scheme;
    document.documentElement.dataset.fpTheme = fpTheme;
    const bgColor = tg.themeParams?.bg_color || (scheme === 'light' ? '#ffffff' : '#0f0f13');
    try {
        if (isFullPlayerOpen && fpTheme !== 'light') {
            tg.setHeaderColor?.('#0f0f13');
            tg.setBackgroundColor?.('#0f0f13');
        } else {
            tg.setHeaderColor?.(bgColor);
            tg.setBackgroundColor?.(bgColor);
        }
    } catch (e) {}
}

function applyUserSettings() {
    const preset = ACCENT_PRESETS[userSettings.accent] || ACCENT_PRESETS.spotify;
    document.documentElement.style.setProperty('--accent', preset.accent);
    document.documentElement.style.setProperty('--accent-hover', preset.hover);
    document.body.classList.toggle('no-equalizer', !userSettings.equalizer);
    document.body.classList.toggle('no-ambient-bg', !userSettings.ambientBg);
    document.body.classList.toggle('hide-send-btn', !userSettings.showSendBtn);
    document.body.classList.toggle('hide-delete-btn', Boolean(userSettings.hideDeleteBtn));
    document.body.classList.toggle('compact-list', userSettings.density === 'compact');
    document.body.classList.toggle('vinyl-cover', userSettings.coverStyle === 'vinyl');
    document.body.classList.toggle('no-marquee', !userSettings.marquee);
    document.body.classList.toggle('reduced-motion', Boolean(userSettings.reducedMotion));
    applyTelegramTheme();
}

const initData = tg.initData || '';
const authHeaders = () => ({ 'X-Telegram-Init-Data': initData });

let allTracks = [];
let filteredTracks = [];
let userPlaylists = []; // [{ id, name, emoji, track_ids: [...] }]
let activePlaylistId = 'all'; // 'all' | number
let playbackQueueIds = []; // Очередь воспроизведения той вкладки, откуда запустили трек
let shuffledIds = [];
let currentFileId = null;
let isRepeat = false;
let isShuffle = false;
let isSeeking = false;
let isFullPlayerOpen = false;
let isSwitchingTrack = false;
let isPlActionsOpen = false;
let isPlModalOpen = false;
let isAddTracksModalOpen = false;
let editingPlaylistId = null;
let selectedModalEmoji = '🎧';
let pickerSelectedIds = new Set();

function haptic(style = 'light') {
    if (!userSettings.haptic) return;
    try {
        tg.HapticFeedback?.impactOccurred(style);
    } catch (e) {}
}

function getBaseQueueIds() {
    if (playbackQueueIds.length > 0) {
        const allSet = new Set(allTracks.map(t => t.file_id));
        const valid = playbackQueueIds.filter(id => allSet.has(id));
        if (valid.length > 0) return valid;
    }
    return filteredTracks.map(t => t.file_id);
}

function rebuildShuffleQueue() {
    const ids = [...getBaseQueueIds()];
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    if (currentFileId) {
        const idx = ids.indexOf(currentFileId);
        if (idx > 0) {
            ids.splice(idx, 1);
            ids.unshift(currentFileId);
        }
    }
    shuffledIds = ids;
}

function getActiveOrderIds() {
    const baseIds = getBaseQueueIds();
    if (isShuffle) {
        const validSet = new Set(baseIds);
        const cleaned = shuffledIds.filter(id => validSet.has(id));
        if (cleaned.length !== baseIds.length) {
            rebuildShuffleQueue();
            return shuffledIds;
        }
        return cleaned;
    }
    return baseIds;
}

function getCurrentIndex() {
    if (!currentFileId) return -1;
    return getActiveOrderIds().indexOf(currentFileId);
}

const audio = document.getElementById('audioElement');
const headerEl = document.getElementById('headerEl');
const playlistTabs = document.getElementById('playlistTabs');
const plMenuBtn = document.getElementById('plMenuBtn');
const plActionsBackdrop = document.getElementById('plActionsBackdrop');
const plActionsTitle = document.getElementById('plActionsTitle');
const plActionsCloseBtn = document.getElementById('plActionsCloseBtn');
const plAddTracksBtn = document.getElementById('plAddTracksBtn');
const plEditBtn = document.getElementById('plEditBtn');
const plDeleteBtn = document.getElementById('plDeleteBtn');
const plModalBackdrop = document.getElementById('plModalBackdrop');
const plModalSheet = document.getElementById('plModalSheet');
const plModalTitle = document.getElementById('plModalTitle');
const plModalCloseBtn = document.getElementById('plModalCloseBtn');
const plEmojiPicker = document.getElementById('plEmojiPicker');
const plNameInput = document.getElementById('plNameInput');
const plModalSaveBtn = document.getElementById('plModalSaveBtn');
const addTracksBackdrop = document.getElementById('addTracksBackdrop');
const addTracksSheet = document.getElementById('addTracksSheet');
const addTracksTitle = document.getElementById('addTracksTitle');
const addTracksCloseBtn = document.getElementById('addTracksCloseBtn');
const addTracksSearch = document.getElementById('addTracksSearch');
const addTracksList = document.getElementById('addTracksList');
const addTracksSaveBtn = document.getElementById('addTracksSaveBtn');
const scrollTopBtn = document.getElementById('scrollTopBtn');
const trackListEl = document.getElementById('trackList');
const trackCountEl = document.getElementById('trackCount');
const searchInput = document.getElementById('searchInput');
const playerBar = document.getElementById('playerBar');
const playerTitle = document.getElementById('playerTitle');
const playerArtist = document.getElementById('playerArtist');
const playerCover = document.getElementById('playerCover');
const playPauseBtn = document.getElementById('playPauseBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const repeatBtn = document.getElementById('repeatBtn');
const playerTrackTrigger = document.getElementById('playerTrackTrigger');
const seekWrapper = document.getElementById('seekWrapper');
const seekFill = document.getElementById('seekFill');
const seekThumb = document.getElementById('seekThumb');
const seekSlider = document.getElementById('seekSlider');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');

const fullPlayer = document.getElementById('fullPlayer');
const fpBgImgs = [document.getElementById('fpBgImgA'), document.getElementById('fpBgImgB')];
const fpCollapseBtn = document.getElementById('fpCollapseBtn');
const fpArtBox = document.getElementById('fpArtBox');
const fpCovers = [document.getElementById('fpCoverA'), document.getElementById('fpCoverB')];
const fpCoverFallback = document.getElementById('fpCoverFallback');
let fpActiveLayer = 0;
let fpCoverSeq = 0;
const fpTitle = document.getElementById('fpTitle');
const fpArtist = document.getElementById('fpArtist');
const fpSeekWrapper = document.getElementById('fpSeekWrapper');
const fpSeekFill = document.getElementById('fpSeekFill');
const fpSeekThumb = document.getElementById('fpSeekThumb');
const fpSeekSlider = document.getElementById('fpSeekSlider');
const fpCurrentTime = document.getElementById('fpCurrentTime');
const fpTotalTime = document.getElementById('fpTotalTime');
const fpShuffleBtn = document.getElementById('fpShuffleBtn');
const fpPrevBtn = document.getElementById('fpPrevBtn');
const fpPlayPauseBtn = document.getElementById('fpPlayPauseBtn');
const fpPlayIcon = document.getElementById('fpPlayIcon');
const fpPauseIcon = document.getElementById('fpPauseIcon');
const fpNextBtn = document.getElementById('fpNextBtn');
const fpRepeatBtn = document.getElementById('fpRepeatBtn');
const undoToast = document.getElementById('undoToast');
const undoToastText = document.getElementById('undoToastText');
const undoDeleteBtn = document.getElementById('undoDeleteBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsBackdrop = document.getElementById('settingsBackdrop');
const settingsSheet = document.getElementById('settingsSheet');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const accentPalette = document.getElementById('accentPalette');
const fpThemeSegment = document.getElementById('fpThemeSegment');
const sortSegment = document.getElementById('sortSegment');
const densitySegment = document.getElementById('densitySegment');
const coverStyleSegment = document.getElementById('coverStyleSegment');
const sleepSegment = document.getElementById('sleepSegment');
const sleepTimerBadge = document.getElementById('sleepTimerBadge');
const speedSegment = document.getElementById('speedSegment');
const optAudioFade = document.getElementById('optAudioFade');
const optAutoNext = document.getElementById('optAutoNext');
const optEqualizer = document.getElementById('optEqualizer');
const optAmbientBg = document.getElementById('optAmbientBg');
const optShowSendBtn = document.getElementById('optShowSendBtn');
const optHideDeleteBtn = document.getElementById('optHideDeleteBtn');
const optAutoOpenPlayer = document.getElementById('optAutoOpenPlayer');
const optRememberLast = document.getElementById('optRememberLast');
const optAutoScroll = document.getElementById('optAutoScroll');
const optMarquee = document.getElementById('optMarquee');
const optReducedMotion = document.getElementById('optReducedMotion');
const optHaptic = document.getElementById('optHaptic');
const settingsResetBtn = document.getElementById('settingsResetBtn');

// ===== Audio Fade & Sleep Timer =====
let audioFadeRafId = null;
let sleepMode = 'off'; // 'off' | '15' | '30' | '60' | 'track'
let sleepEndAt = 0;
let sleepIntervalId = null;
let sleepFadeStarted = false;

function cancelAudioFade() {
    if (audioFadeRafId !== null) {
        cancelAnimationFrame(audioFadeRafId);
        audioFadeRafId = null;
    }
}

function fadeAudioVolume(fromVol, toVol, durationMs, onDone) {
    cancelAudioFade();
    const start = performance.now();
    try {
        audio.volume = fromVol;
    } catch (e) {
        if (onDone) onDone();
        return;
    }
    function step(now) {
        const p = Math.min(1, (now - start) / durationMs);
        try {
            audio.volume = Math.max(0, Math.min(1, fromVol + (toVol - fromVol) * p));
        } catch (e) {}
        if (p < 1) {
            audioFadeRafId = requestAnimationFrame(step);
        } else {
            audioFadeRafId = null;
            if (onDone) onDone();
        }
    }
    audioFadeRafId = requestAnimationFrame(step);
}

function playWithFade() {
    cancelAudioFade();
    audio.playbackRate = Number(userSettings.playbackRate) || 1;
    if (!userSettings.audioFade) {
        try { audio.volume = 1; } catch (e) {}
        audio.play().catch(() => {});
        return;
    }
    try { audio.volume = 0.05; } catch (e) {}
    const p = audio.play();
    if (p && typeof p.then === 'function') {
        p.then(() => fadeAudioVolume(0.05, 1, 240)).catch(() => {
            try { audio.volume = 1; } catch (e) {}
        });
    } else {
        fadeAudioVolume(0.05, 1, 240);
    }
}

function pauseWithFade() {
    cancelAudioFade();
    if (!userSettings.audioFade || audio.paused) {
        audio.pause();
        try { audio.volume = 1; } catch (e) {}
        return;
    }
    const startVol = typeof audio.volume === 'number' ? audio.volume : 1;
    fadeAudioVolume(startVol, 0, 220, () => {
        audio.pause();
        try { audio.volume = 1; } catch (e) {}
    });
}

function updateSleepBadge() {
    if (sleepMode === 'off') {
        sleepTimerBadge.textContent = '';
    } else if (sleepMode === 'track') {
        sleepTimerBadge.textContent = 'После трека';
    } else {
        const remSec = Math.max(0, Math.ceil((sleepEndAt - Date.now()) / 1000));
        sleepTimerBadge.textContent = `Осталось ${formatTime(remSec)}`;
    }
}

function clearSleepTimer() {
    sleepMode = 'off';
    sleepEndAt = 0;
    sleepFadeStarted = false;
    if (sleepIntervalId !== null) {
        clearInterval(sleepIntervalId);
        sleepIntervalId = null;
    }
    updateSleepBadge();
    syncSettingsUI();
}

function setSleepTimer(mode) {
    if (sleepIntervalId !== null) {
        clearInterval(sleepIntervalId);
        sleepIntervalId = null;
    }
    sleepMode = mode;
    sleepFadeStarted = false;

    if (mode === 'off' || mode === 'track') {
        sleepEndAt = 0;
        updateSleepBadge();
        syncSettingsUI();
        return;
    }

    const minutes = parseInt(mode, 10);
    if (!minutes || isNaN(minutes)) {
        clearSleepTimer();
        return;
    }

    sleepEndAt = Date.now() + minutes * 60 * 1000;
    updateSleepBadge();
    syncSettingsUI();

    sleepIntervalId = setInterval(() => {
        const remMs = sleepEndAt - Date.now();
        updateSleepBadge();
        if (remMs <= 5000 && !sleepFadeStarted && !audio.paused) {
            sleepFadeStarted = true;
            const curVol = typeof audio.volume === 'number' ? audio.volume : 1;
            fadeAudioVolume(curVol, 0, Math.max(400, remMs), () => {
                audio.pause();
                try { audio.volume = 1; } catch (e) {}
                clearSleepTimer();
            });
        } else if (remMs <= 0) {
            audio.pause();
            try { audio.volume = 1; } catch (e) {}
            clearSleepTimer();
        }
    }, 500);
}

function applyPlaybackRate() {
    try {
        audio.playbackRate = Number(userSettings.playbackRate) || 1;
    } catch (e) {}
}

function syncSettingsUI() {
    accentPalette.querySelectorAll('.accent-swatch').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.accent === userSettings.accent);
    });
    fpThemeSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.fpTheme === userSettings.fpTheme);
    });
    sortSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.sort === userSettings.sortOrder);
    });
    densitySegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.density === userSettings.density);
    });
    coverStyleSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.coverStyle === userSettings.coverStyle);
    });
    sleepSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.sleep === sleepMode);
    });
    speedSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.speed) === Number(userSettings.playbackRate));
    });
    optAudioFade.checked = Boolean(userSettings.audioFade);
    optAutoNext.checked = Boolean(userSettings.autoNext);
    optEqualizer.checked = Boolean(userSettings.equalizer);
    optAmbientBg.checked = Boolean(userSettings.ambientBg);
    optShowSendBtn.checked = Boolean(userSettings.showSendBtn);
    optHideDeleteBtn.checked = Boolean(userSettings.hideDeleteBtn);
    optAutoOpenPlayer.checked = Boolean(userSettings.autoOpenPlayer);
    optRememberLast.checked = Boolean(userSettings.rememberLastTrack);
    optAutoScroll.checked = Boolean(userSettings.autoScroll);
    optMarquee.checked = Boolean(userSettings.marquee);
    optReducedMotion.checked = Boolean(userSettings.reducedMotion);
    optHaptic.checked = Boolean(userSettings.haptic);
}

function openSettings() {
    if (isSettingsOpen) return;
    isSettingsOpen = true;
    syncSettingsUI();
    settingsSheet.style.transform = '';
    settingsSheet.classList.remove('dragging');
    document.body.classList.add('settings-open');
    settingsBackdrop.classList.add('open');
    settingsBackdrop.setAttribute('aria-hidden', 'false');
    haptic('light');
    try {
        tg.BackButton?.show();
    } catch (e) {}
}

function closeSettings() {
    if (!isSettingsOpen) return;
    isSettingsOpen = false;
    settingsSheet.style.transform = '';
    settingsSheet.classList.remove('dragging');
    document.body.classList.remove('settings-open');
    settingsBackdrop.classList.remove('open');
    settingsBackdrop.setAttribute('aria-hidden', 'true');
    if (!isFullPlayerOpen) {
        try {
            tg.BackButton?.hide();
        } catch (e) {}
    }
}

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsBackdrop) closeSettings();
});

// 60fps swipe-down gesture to close settings sheet
let stSwipeStartY = 0;
let stSwipeStartTime = 0;
let stSwipeDeltaY = 0;
let stSwipeActive = false;
let stSwipeDragging = false;
let stSwipeRafId = null;

function renderSettingsSwipeFrame() {
    stSwipeRafId = null;
    if (!stSwipeDragging) return;
    const dy = Math.max(0, stSwipeDeltaY);
    settingsSheet.style.transform = `translate3d(0, ${dy}px, 0)`;
}

settingsSheet.addEventListener('touchstart', (e) => {
    if (!isSettingsOpen || e.touches.length !== 1) return;
    if (settingsSheet.scrollTop > 0) return;
    stSwipeStartY = e.touches[0].clientY;
    stSwipeStartTime = Date.now();
    stSwipeDeltaY = 0;
    stSwipeActive = true;
    stSwipeDragging = false;
}, { passive: true });

settingsSheet.addEventListener('touchmove', (e) => {
    if (!stSwipeActive) return;
    const dy = e.touches[0].clientY - stSwipeStartY;
    if (!stSwipeDragging) {
        if (dy < 8) {
            if (dy < -8) stSwipeActive = false;
            return;
        }
        if (settingsSheet.scrollTop > 0) {
            stSwipeActive = false;
            return;
        }
        stSwipeDragging = true;
        settingsSheet.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();
    stSwipeDeltaY = Math.max(0, dy);
    if (stSwipeRafId === null) {
        stSwipeRafId = requestAnimationFrame(renderSettingsSwipeFrame);
    }
}, { passive: false });

function endSettingsSwipe() {
    if (!stSwipeActive) return;
    stSwipeActive = false;
    if (stSwipeRafId !== null) {
        cancelAnimationFrame(stSwipeRafId);
        stSwipeRafId = null;
    }
    if (!stSwipeDragging) return;
    stSwipeDragging = false;
    settingsSheet.classList.remove('dragging');

    const elapsed = Math.max(1, Date.now() - stSwipeStartTime);
    const vy = stSwipeDeltaY / elapsed;
    if (stSwipeDeltaY > 80 || vy > 0.5) {
        haptic('light');
        closeSettings();
    } else {
        settingsSheet.style.transform = '';
    }
}

settingsSheet.addEventListener('touchend', endSettingsSwipe);
settingsSheet.addEventListener('touchcancel', endSettingsSwipe);

accentPalette.addEventListener('click', (e) => {
    const btn = e.target.closest('.accent-swatch');
    if (!btn) return;
    userSettings.accent = btn.dataset.accent;
    saveUserSettings();
    applyUserSettings();
    syncSettingsUI();
    haptic('light');
});

fpThemeSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    userSettings.fpTheme = btn.dataset.fpTheme;
    saveUserSettings();
    applyUserSettings();
    syncSettingsUI();
    haptic('light');
});

sortSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    userSettings.sortOrder = btn.dataset.sort;
    saveUserSettings();
    syncSettingsUI();
    applySearchFilter();
    haptic('light');
});

densitySegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    userSettings.density = btn.dataset.density;
    saveUserSettings();
    applyUserSettings();
    syncSettingsUI();
    haptic('light');
});

coverStyleSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    userSettings.coverStyle = btn.dataset.coverStyle;
    saveUserSettings();
    applyUserSettings();
    syncSettingsUI();
    haptic('light');
});

sleepSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    setSleepTimer(btn.dataset.sleep);
    haptic('light');
});

speedSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    userSettings.playbackRate = Number(btn.dataset.speed) || 1;
    saveUserSettings();
    applyPlaybackRate();
    syncSettingsUI();
    haptic('light');
});

optAudioFade.addEventListener('change', () => {
    userSettings.audioFade = optAudioFade.checked;
    saveUserSettings();
    haptic('light');
});

optAutoNext.addEventListener('change', () => {
    userSettings.autoNext = optAutoNext.checked;
    saveUserSettings();
    haptic('light');
});

optEqualizer.addEventListener('change', () => {
    userSettings.equalizer = optEqualizer.checked;
    saveUserSettings();
    applyUserSettings();
    haptic('light');
});

optAmbientBg.addEventListener('change', () => {
    userSettings.ambientBg = optAmbientBg.checked;
    saveUserSettings();
    applyUserSettings();
    haptic('light');
});

optShowSendBtn.addEventListener('change', () => {
    userSettings.showSendBtn = optShowSendBtn.checked;
    saveUserSettings();
    applyUserSettings();
    haptic('light');
});

optHideDeleteBtn.addEventListener('change', () => {
    userSettings.hideDeleteBtn = optHideDeleteBtn.checked;
    saveUserSettings();
    applyUserSettings();
    haptic('light');
});

optAutoOpenPlayer.addEventListener('change', () => {
    userSettings.autoOpenPlayer = optAutoOpenPlayer.checked;
    saveUserSettings();
    haptic('light');
});

optRememberLast.addEventListener('change', () => {
    userSettings.rememberLastTrack = optRememberLast.checked;
    saveUserSettings();
    if (!userSettings.rememberLastTrack) {
        try { localStorage.removeItem(LAST_TRACK_STORAGE_KEY); } catch (e) {}
    } else if (currentFileId) {
        saveLastTrackState(true);
    }
    haptic('light');
});

optAutoScroll.addEventListener('change', () => {
    userSettings.autoScroll = optAutoScroll.checked;
    saveUserSettings();
    haptic('light');
});

optMarquee.addEventListener('change', () => {
    userSettings.marquee = optMarquee.checked;
    saveUserSettings();
    applyUserSettings();
    if (userSettings.marquee) refreshAllMarquees();
    haptic('light');
});

optReducedMotion.addEventListener('change', () => {
    userSettings.reducedMotion = optReducedMotion.checked;
    saveUserSettings();
    applyUserSettings();
    haptic('light');
});

optHaptic.addEventListener('change', () => {
    userSettings.haptic = optHaptic.checked;
    saveUserSettings();
    if (userSettings.haptic) haptic('light');
});

settingsResetBtn.addEventListener('click', () => {
    userSettings = { ...DEFAULT_SETTINGS };
    saveUserSettings();
    clearSleepTimer();
    applyPlaybackRate();
    applyUserSettings();
    syncSettingsUI();
    if (allTracks.length > 0) applySearchFilter();
    haptic('medium');
});

applyUserSettings();
applyPlaybackRate();

let progressRafId = null;
let pendingDelete = null;

function setProgressVisual(current, duration) {
    const pct = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
    const formattedCurrent = formatTime(current);
    const formattedTotal = duration > 0 ? formatTime(duration) : '0:00';

    seekFill.style.width = `${pct}%`;
    seekThumb.style.left = `${pct}%`;
    currentTimeEl.textContent = formattedCurrent;
    totalTimeEl.textContent = formattedTotal;

    fpSeekFill.style.width = `${pct}%`;
    fpSeekThumb.style.left = `${pct}%`;
    fpCurrentTime.textContent = formattedCurrent;
    fpTotalTime.textContent = formattedTotal;

    if (duration > 0) {
        seekSlider.max = duration;
        fpSeekSlider.max = duration;
        if (!isSeeking) {
            seekSlider.value = current;
            fpSeekSlider.value = current;
        }
    }
}

function startProgressLoop() {
    if (progressRafId !== null) return;
    const tick = () => {
        if (!isSeeking && !audio.paused && audio.duration) {
            setProgressVisual(audio.currentTime, audio.duration);
        }
        if (!audio.paused) {
            progressRafId = requestAnimationFrame(tick);
        } else {
            progressRafId = null;
        }
    };
    progressRafId = requestAnimationFrame(tick);
}

function stopProgressLoop() {
    if (progressRafId !== null) {
        cancelAnimationFrame(progressRafId);
        progressRafId = null;
    }
}

function formatTime(sec) {
    if (!sec || isNaN(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function renderSkeleton(count = 6) {
    trackListEl.innerHTML = Array.from({ length: count }, () => `
        <div class="skeleton-item">
            <div class="skeleton-cover skeleton-shimmer"></div>
            <div class="skeleton-meta">
                <div class="skeleton-line title skeleton-shimmer"></div>
                <div class="skeleton-line artist skeleton-shimmer"></div>
            </div>
            <div class="skeleton-actions">
                <div class="skeleton-circle skeleton-shimmer"></div>
                <div class="skeleton-circle skeleton-shimmer"></div>
            </div>
        </div>
    `).join('');
}

let pendingResumeTime = null;
let lastTrackSaveAt = 0;

function saveLastTrackState(force = false) {
    if (!userSettings.rememberLastTrack || !currentFileId) return;
    const now = Date.now();
    if (!force && now - lastTrackSaveAt < 4000) return;
    lastTrackSaveAt = now;
    try {
        localStorage.setItem(
            LAST_TRACK_STORAGE_KEY,
            JSON.stringify({
                file_id: currentFileId,
                time: Math.floor(audio.currentTime || 0),
            })
        );
    } catch (e) {}
}

function restoreLastTrackIfEnabled() {
    if (!userSettings.rememberLastTrack || currentFileId) return;
    let saved = null;
    try {
        const raw = localStorage.getItem(LAST_TRACK_STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
    } catch (e) {}
    if (!saved || !saved.file_id) return;

    const track = allTracks.find(t => t.file_id === saved.file_id);
    if (!track) return;

    currentFileId = track.file_id;
    const titleText = track.title || track.name;
    const artistText = track.performer || 'Spotify';

    playerBar.classList.add('visible');
    document.body.classList.add('has-player');
    setMarqueeText(playerTitle, titleText);
    playerArtist.textContent = artistText;
    playerCover.style.visibility = 'visible';
    playerCover.src = track.cover_url;

    setMarqueeText(fpTitle, titleText);
    setMarqueeText(fpArtist, artistText);
    crossfadeFullPlayerCover(track.cover_url, true);

    pendingResumeTime = typeof saved.time === 'number' && saved.time > 0 ? saved.time : null;
    audio.src = track.stream_url;
    updatePlayButtons(false);
    syncActiveTrackInDOM();
}

function getActiveCustomPlaylist() {
    if (activePlaylistId === 'all') return null;
    return userPlaylists.find(p => p.id === activePlaylistId) || null;
}

function getTracksForActivePlaylist() {
    const pl = getActiveCustomPlaylist();
    if (!pl) return allTracks;
    const byId = new Map(allTracks.map(t => [t.file_id, t]));
    return pl.track_ids.map(fid => byId.get(fid)).filter(Boolean);
}

function renderPlaylistTabs() {
    playlistTabs.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `pl-tab ${activePlaylistId === 'all' ? 'active' : ''}`;
    allBtn.dataset.plId = 'all';
    allBtn.innerHTML = `🎵 Все <span class="pl-tab-count">${allTracks.length}</span>`;
    allBtn.addEventListener('click', () => selectPlaylistTab('all'));
    playlistTabs.appendChild(allBtn);

    userPlaylists.forEach((pl) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `pl-tab ${activePlaylistId === pl.id ? 'active' : ''}`;
        btn.dataset.plId = String(pl.id);
        btn.innerHTML = `${escapeHtml(pl.emoji || '🎧')} ${escapeHtml(pl.name)} <span class="pl-tab-count">${pl.track_ids.length}</span>`;
        btn.addEventListener('click', () => {
            if (activePlaylistId === pl.id) {
                openPlaylistActions();
            } else {
                selectPlaylistTab(pl.id);
            }
        });
        playlistTabs.appendChild(btn);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pl-tab add-tab';
    addBtn.textContent = '＋';
    addBtn.title = 'Создать плейлист';
    addBtn.addEventListener('click', () => openPlaylistModal(null));
    playlistTabs.appendChild(addBtn);

    const activeTabEl = playlistTabs.querySelector('.pl-tab.active');
    if (activeTabEl) {
        activeTabEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }

    plMenuBtn.style.display = activePlaylistId === 'all' ? 'none' : 'flex';
}

function openPlaylistActions() {
    const pl = getActiveCustomPlaylist();
    if (!pl || isPlActionsOpen) return;
    isPlActionsOpen = true;
    plActionsTitle.textContent = `${pl.emoji || '🎧'} ${pl.name}`;
    document.body.classList.add('settings-open');
    plActionsBackdrop.classList.add('open');
    plActionsBackdrop.setAttribute('aria-hidden', 'false');
    haptic('light');
    try { tg.BackButton?.show(); } catch (e) {}
}

function closePlaylistActions() {
    if (!isPlActionsOpen) return;
    isPlActionsOpen = false;
    plActionsBackdrop.classList.remove('open');
    plActionsBackdrop.setAttribute('aria-hidden', 'true');
    if (!isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

plMenuBtn.addEventListener('click', openPlaylistActions);
plActionsCloseBtn.addEventListener('click', closePlaylistActions);
plActionsBackdrop.addEventListener('click', (e) => {
    if (e.target === plActionsBackdrop) closePlaylistActions();
});

function getAllTabIds() {
    return ['all', ...userPlaylists.map(p => p.id)];
}

// 60fps horizontal screen swipe to switch between playlist tabs
let tabSwipeStartX = 0;
let tabSwipeStartY = 0;
let tabSwipeStartTime = 0;
let tabSwipeDeltaX = 0;
let tabSwipeActive = false;
let tabSwipeLocked = null; // 'horizontal' | 'vertical' | null
let tabSwipeRafId = null;

function renderTabSwipeFrame() {
    tabSwipeRafId = null;
    if (!tabSwipeActive || tabSwipeLocked !== 'horizontal') return;
    const tabs = getAllTabIds();
    const curIdx = tabs.indexOf(activePlaylistId);
    const atStartEdge = curIdx <= 0 && tabSwipeDeltaX > 0;
    const atEndEdge = curIdx >= tabs.length - 1 && tabSwipeDeltaX < 0;

    let visualX = tabSwipeDeltaX;
    if (atStartEdge || atEndEdge) {
        // Мягкое «резиновое» сопротивление на крайних вкладках
        visualX = Math.max(-44, Math.min(44, tabSwipeDeltaX * 0.24));
    } else {
        visualX = Math.max(-220, Math.min(220, tabSwipeDeltaX));
    }
    const op = atStartEdge || atEndEdge ? 1 : Math.max(0.55, 1 - Math.abs(visualX) / 380);
    trackListEl.style.transform = `translate3d(${visualX}px, 0, 0)`;
    trackListEl.style.opacity = `${op}`;
}

function animateTabSwipeSwitch(targetPlId, direction) {
    // direction: -1 (swipe left -> next tab), +1 (swipe right -> prev tab)
    trackListEl.classList.remove('swiping');
    trackListEl.classList.add('swipe-out');
    trackListEl.style.transform = `translate3d(${direction * 110}px, 0, 0)`;
    trackListEl.style.opacity = '0';

    setTimeout(() => {
        activePlaylistId = targetPlId;
        renderPlaylistTabs();
        applySearchFilter();
        window.scrollTo(0, 0);

        trackListEl.classList.remove('swipe-out');
        trackListEl.classList.add('swiping');
        trackListEl.style.transform = `translate3d(${-direction * 46}px, 0, 0)`;
        trackListEl.style.opacity = '0';
        void trackListEl.offsetWidth;
        trackListEl.classList.remove('swiping');
        trackListEl.style.transform = '';
        trackListEl.style.opacity = '';
    }, 140);
}

document.addEventListener('touchstart', (e) => {
    if (userPlaylists.length === 0) return;
    if (isFullPlayerOpen || isSettingsOpen || isPlActionsOpen || isPlModalOpen || isAddTracksModalOpen) return;
    if (e.touches.length !== 1) return;
    if (e.target.closest('.header, .player-bar, .seek-wrapper, .undo-toast, input, button')) return;

    tabSwipeStartX = e.touches[0].clientX;
    tabSwipeStartY = e.touches[0].clientY;
    tabSwipeStartTime = Date.now();
    tabSwipeDeltaX = 0;
    tabSwipeLocked = null;
    tabSwipeActive = true;
}, { passive: true });

document.addEventListener('touchmove', (e) => {
    if (!tabSwipeActive) return;
    const dx = e.touches[0].clientX - tabSwipeStartX;
    const dy = e.touches[0].clientY - tabSwipeStartY;

    if (!tabSwipeLocked) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.35) {
            tabSwipeLocked = 'horizontal';
            trackListEl.classList.remove('swipe-out');
            trackListEl.classList.add('swiping');
        } else {
            tabSwipeLocked = 'vertical';
            tabSwipeActive = false;
            return;
        }
    }

    if (tabSwipeLocked === 'horizontal') {
        if (e.cancelable) e.preventDefault();
        tabSwipeDeltaX = dx;
        if (tabSwipeRafId === null) {
            tabSwipeRafId = requestAnimationFrame(renderTabSwipeFrame);
        }
    }
}, { passive: false });

function endTabSwipe() {
    if (!tabSwipeActive) return;
    tabSwipeActive = false;
    if (tabSwipeRafId !== null) {
        cancelAnimationFrame(tabSwipeRafId);
        tabSwipeRafId = null;
    }
    if (tabSwipeLocked !== 'horizontal') {
        tabSwipeLocked = null;
        return;
    }
    tabSwipeLocked = null;

    const tabs = getAllTabIds();
    const curIdx = tabs.indexOf(activePlaylistId);
    const elapsed = Math.max(1, Date.now() - tabSwipeStartTime);
    const vx = Math.abs(tabSwipeDeltaX) / elapsed;
    const triggered = Math.abs(tabSwipeDeltaX) > 60 || vx > 0.42;

    if (triggered && tabSwipeDeltaX < 0 && curIdx < tabs.length - 1) {
        haptic('light');
        animateTabSwipeSwitch(tabs[curIdx + 1], -1);
    } else if (triggered && tabSwipeDeltaX > 0 && curIdx > 0) {
        haptic('light');
        animateTabSwipeSwitch(tabs[curIdx - 1], 1);
    } else {
        trackListEl.classList.remove('swiping', 'swipe-out');
        trackListEl.style.transform = '';
        trackListEl.style.opacity = '';
    }
}

document.addEventListener('touchend', endTabSwipe);
document.addEventListener('touchcancel', endTabSwipe);

function selectPlaylistTab(plId, animate = false) {
    if (activePlaylistId === plId && !animate) return;
    activePlaylistId = plId;
    haptic('light');
    renderPlaylistTabs();
    applySearchFilter({ animateEntrance: animate });
    window.scrollTo(0, 0);
}

function openPlaylistModal(pl = null) {
    editingPlaylistId = pl ? pl.id : null;
    selectedModalEmoji = pl ? (pl.emoji || '🎧') : '🎧';
    plModalTitle.textContent = pl ? 'Изменить плейлист' : 'Новый плейлист';
    plModalSaveBtn.textContent = pl ? 'Сохранить' : 'Создать';
    plNameInput.value = pl ? pl.name : '';

    plEmojiPicker.querySelectorAll('.emoji-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.emoji === selectedModalEmoji);
    });

    isPlModalOpen = true;
    document.body.classList.add('settings-open');
    plModalBackdrop.classList.add('open');
    plModalBackdrop.setAttribute('aria-hidden', 'false');
    haptic('light');
    setTimeout(() => plNameInput.focus(), 200);
    try { tg.BackButton?.show(); } catch (e) {}
}

function closePlaylistModal() {
    if (!isPlModalOpen) return;
    isPlModalOpen = false;
    plModalBackdrop.classList.remove('open');
    plModalBackdrop.setAttribute('aria-hidden', 'true');
    if (!isSettingsOpen && !isAddTracksModalOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isAddTracksModalOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

plEmojiPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-btn');
    if (!btn) return;
    selectedModalEmoji = btn.dataset.emoji;
    plEmojiPicker.querySelectorAll('.emoji-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
    });
    haptic('light');
});

plModalCloseBtn.addEventListener('click', closePlaylistModal);
plModalBackdrop.addEventListener('click', (e) => {
    if (e.target === plModalBackdrop) closePlaylistModal();
});

plModalSaveBtn.addEventListener('click', async () => {
    const name = plNameInput.value.trim();
    if (!name) {
        plNameInput.focus();
        return;
    }
    plModalSaveBtn.disabled = true;
    try {
        if (editingPlaylistId !== null) {
            const res = await fetch(`/api/playlists/${editingPlaylistId}`, {
                method: 'PATCH',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, emoji: selectedModalEmoji }),
            });
            if (res.ok) {
                const pl = userPlaylists.find(p => p.id === editingPlaylistId);
                if (pl) {
                    pl.name = name;
                    pl.emoji = selectedModalEmoji;
                }
                closePlaylistModal();
                renderPlaylistTabs();
                haptic('medium');
            }
        } else {
            const res = await fetch('/api/playlists', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, emoji: selectedModalEmoji }),
            });
            if (res.ok) {
                const data = await res.json();
                userPlaylists.push(data.playlist);
                closePlaylistModal();
                selectPlaylistTab(data.playlist.id, true);
                haptic('medium');
            } else {
                const err = await res.json().catch(() => ({}));
                if (err.error && tg.showAlert) tg.showAlert(err.error);
            }
        }
    } catch (e) {
    } finally {
        plModalSaveBtn.disabled = false;
    }
});

plEditBtn.addEventListener('click', () => {
    const pl = getActiveCustomPlaylist();
    closePlaylistActions();
    if (pl) openPlaylistModal(pl);
});

plDeleteBtn.addEventListener('click', async () => {
    const pl = getActiveCustomPlaylist();
    closePlaylistActions();
    if (!pl) return;
    const doDelete = async () => {
        try {
            const res = await fetch(`/api/playlists/${pl.id}`, {
                method: 'DELETE',
                headers: authHeaders(),
            });
            if (res.ok) {
                userPlaylists = userPlaylists.filter(p => p.id !== pl.id);
                haptic('medium');
                selectPlaylistTab('all', true);
            }
        } catch (e) {}
    };
    if (tg.showConfirm) {
        tg.showConfirm(`Удалить плейлист «${pl.name}»? Треки останутся в «Все».`, (ok) => {
            if (ok) doDelete();
        });
    } else if (confirm(`Удалить плейлист «${pl.name}»?`)) {
        doDelete();
    }
});

function renderPickerTracks() {
    const q = addTracksSearch.value.trim().toLowerCase();
    const list = allTracks.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.performer && t.performer.toLowerCase().includes(q))
    );

    if (list.length === 0) {
        addTracksList.innerHTML = `<div class="empty-state" style="padding:24px 12px;">Треки не найдены</div>`;
        return;
    }

    addTracksList.innerHTML = '';
    list.forEach((track) => {
        const selected = pickerSelectedIds.has(track.file_id);
        const row = document.createElement('div');
        row.className = `picker-row ${selected ? 'selected' : ''}`;
        row.innerHTML = `
            <div class="picker-check">✓</div>
            <div class="picker-info">
                <div class="picker-title">${escapeHtml(track.title || track.name)}</div>
                <div class="picker-artist">${escapeHtml(track.performer || 'Spotify')}</div>
            </div>
        `;
        row.addEventListener('click', () => {
            if (pickerSelectedIds.has(track.file_id)) {
                pickerSelectedIds.delete(track.file_id);
                row.classList.remove('selected');
            } else {
                pickerSelectedIds.add(track.file_id);
                row.classList.add('selected');
            }
            haptic('light');
        });
        addTracksList.appendChild(row);
    });
}

function openAddTracksModal() {
    const pl = getActiveCustomPlaylist();
    if (!pl) return;
    pickerSelectedIds = new Set(pl.track_ids);
    addTracksTitle.textContent = `${pl.emoji || '🎧'} ${pl.name}`;
    addTracksSearch.value = '';
    renderPickerTracks();

    isAddTracksModalOpen = true;
    document.body.classList.add('settings-open');
    addTracksBackdrop.classList.add('open');
    addTracksBackdrop.setAttribute('aria-hidden', 'false');
    haptic('light');
    try { tg.BackButton?.show(); } catch (e) {}
}

function closeAddTracksModal() {
    if (!isAddTracksModalOpen) return;
    isAddTracksModalOpen = false;
    addTracksBackdrop.classList.remove('open');
    addTracksBackdrop.setAttribute('aria-hidden', 'true');
    if (!isSettingsOpen && !isPlModalOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isPlModalOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

plAddTracksBtn.addEventListener('click', () => {
    closePlaylistActions();
    openAddTracksModal();
});
addTracksCloseBtn.addEventListener('click', closeAddTracksModal);
addTracksBackdrop.addEventListener('click', (e) => {
    if (e.target === addTracksBackdrop) closeAddTracksModal();
});
addTracksSearch.addEventListener('input', renderPickerTracks);

addTracksSaveBtn.addEventListener('click', async () => {
    const pl = getActiveCustomPlaylist();
    if (!pl) return;
    const prevSet = new Set(pl.track_ids);
    const toAdd = [...pickerSelectedIds].filter(id => !prevSet.has(id));
    const toRemove = [...prevSet].filter(id => !pickerSelectedIds.has(id));

    addTracksSaveBtn.disabled = true;
    try {
        if (toAdd.length > 0) {
            await fetch(`/api/playlists/${pl.id}/tracks`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_ids: toAdd }),
            });
        }
        for (const fid of toRemove) {
            await fetch(`/api/playlists/${pl.id}/tracks?file_id=${encodeURIComponent(fid)}`, {
                method: 'DELETE',
                headers: authHeaders(),
            });
        }
        pl.track_ids = [...toAdd.reverse(), ...pl.track_ids.filter(id => pickerSelectedIds.has(id))];
        closeAddTracksModal();
        renderPlaylistTabs();
        applySearchFilter();
        haptic('medium');
    } catch (e) {
    } finally {
        addTracksSaveBtn.disabled = false;
    }
});

async function loadPlaylist() {
    if (!initData) {
        trackListEl.innerHTML = `<div class="empty-state">Откройте плейлист через кнопку в Telegram-боте.</div>`;
        return;
    }
    renderSkeleton(6);
    try {
        const [resTracks, resPlaylists] = await Promise.all([
            fetch('/api/playlist', { headers: authHeaders() }),
            fetch('/api/playlists', { headers: authHeaders() }),
        ]);
        if (!resTracks.ok) {
            throw new Error(`HTTP ${resTracks.status}`);
        }
        const data = await resTracks.json();
        allTracks = data.tracks || [];
        if (resPlaylists.ok) {
            const plData = await resPlaylists.json();
            userPlaylists = plData.playlists || [];
        }
        renderPlaylistTabs();
        filteredTracks = getSortedTracks(getTracksForActivePlaylist());
        renderTracks({ animateEntrance: true });
        restoreLastTrackIfEnabled();
    } catch (err) {
        trackListEl.innerHTML = `<div class="empty-state">Ошибка загрузки плейлиста</div>`;
    }
}

function renderTracks(options = {}) {
    const { animateEntrance = false, highlightFileId = null } = options;
    const activePl = getActiveCustomPlaylist();
    const sourceCount = activePl ? activePl.track_ids.length : allTracks.length;
    trackCountEl.textContent = `${sourceCount} треков`;

    if (filteredTracks.length === 0) {
        if (activePl && !searchInput.value.trim()) {
            trackListEl.innerHTML = `
                <div class="empty-state">
                    <div>В плейлисте «${escapeHtml(activePl.name)}» пока пусто 🎧</div>
                    <button id="emptyAddTracksBtn" class="empty-cta-btn" type="button">➕ Добавить треки</button>
                </div>
            `;
            const emptyBtn = document.getElementById('emptyAddTracksBtn');
            if (emptyBtn) emptyBtn.addEventListener('click', openAddTracksModal);
        } else {
            trackListEl.innerHTML = `<div class="empty-state">Плейлист пуст 🎧</div>`;
        }
        return;
    }

    trackListEl.innerHTML = '';
    const isPaused = audio.paused;
    filteredTracks.forEach((track, idx) => {
        const isCurrent = currentFileId !== null && currentFileId === track.file_id;
        const item = document.createElement('div');
        const classes = ['track-item'];
        if (isCurrent) classes.push('active');
        if (animateEntrance && idx < 14) {
            classes.push('entering');
            item.style.setProperty('--enter-idx', idx);
        }
        if (highlightFileId && track.file_id === highlightFileId) {
            classes.push('restoring');
        }
        item.className = classes.join(' ');
        item.dataset.fileId = track.file_id;

        const coverUrl = track.cover_url;
        const eqHtml = isCurrent
            ? `<div class="eq-overlay ${isPaused ? 'paused' : ''}"><span></span><span></span><span></span></div>`
            : '';

        item.innerHTML = `
            <div class="cover-wrapper">
                <img src="${coverUrl}" alt="" loading="lazy"
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                <span class="cover-fallback" style="display:none;">🎵</span>
                ${eqHtml}
            </div>
            <div class="track-info">
                <div class="track-title">${escapeHtml(track.title || track.name)}</div>
                <div class="track-artist">${escapeHtml(track.performer || 'Spotify')}</div>
            </div>
            <div class="track-actions">
                <button class="icon-btn" title="Отправить в чат" data-action="send">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
                <button class="icon-btn delete" title="Удалить" data-action="delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
            </div>
        `;

        item.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (btn) {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (action === 'send') sendToChat(track.file_id);
                if (action === 'delete') deleteTrack(track.file_id);
                return;
            }
            playbackQueueIds = filteredTracks.map(t => t.file_id);
            if (isShuffle) rebuildShuffleQueue();
            playTrackById(track.file_id);
            if (userSettings.autoOpenPlayer) {
                openFullPlayer();
            }
        });

        trackListEl.appendChild(item);
    });
}

function setMarqueeText(el, text) {
    let inner = el.querySelector('.marquee-inner');
    if (!inner) {
        inner = document.createElement('span');
        inner.className = 'marquee-inner';
        el.textContent = '';
        el.appendChild(inner);
    }
    el.classList.remove('scrolling');
    el.style.removeProperty('--marquee-distance');
    el.style.removeProperty('--marquee-duration');
    inner.textContent = text;
    refreshMarquee(el);
}

function refreshMarquee(el) {
    const inner = el.querySelector('.marquee-inner');
    if (!inner) return;
    requestAnimationFrame(() => {
        const overflow = inner.scrollWidth - el.clientWidth;
        if (overflow > 4) {
            const distance = -(overflow + 14);
            const duration = Math.max(6, Math.min(18, (overflow / 32) + 4.5));
            el.style.setProperty('--marquee-distance', `${distance}px`);
            el.style.setProperty('--marquee-duration', `${duration.toFixed(1)}s`);
            el.classList.add('scrolling');
        } else {
            el.classList.remove('scrolling');
        }
    });
}

function refreshAllMarquees() {
    refreshMarquee(playerTitle);
    refreshMarquee(fpTitle);
    refreshMarquee(fpArtist);
}

window.addEventListener('resize', refreshAllMarquees);

let fpOpenTimer = null;

function openFullPlayer() {
    if (!currentFileId || isFullPlayerOpen) return;
    isFullPlayerOpen = true;
    if (fpOpenTimer) {
        clearTimeout(fpOpenTimer);
        fpOpenTimer = null;
    }

    // Запускаем чистый GPU-переход на следующем кадре без синхронного reflow
    fullPlayer.style.transform = '';
    fullPlayer.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
        fullPlayer.classList.add('open');
    });

    haptic('light');
    try {
        tg.BackButton?.show();
    } catch (e) {}

    // Тяжёлые операции (overflow: hidden на body, смена цвета шапки TG, пересчёт marquee)
    // выполняем ПОСЛЕ завершения 60fps анимации выезда, чтобы не было рывка на 1-м кадре
    fpOpenTimer = setTimeout(() => {
        if (!isFullPlayerOpen) return;
        document.body.classList.add('fp-open');
        applyTelegramTheme();
        refreshAllMarquees();
    }, 370);
}

function closeFullPlayer() {
    if (!isFullPlayerOpen) return;
    isFullPlayerOpen = false;
    if (fpOpenTimer) {
        clearTimeout(fpOpenTimer);
        fpOpenTimer = null;
    }

    document.body.classList.remove('fp-open');
    fullPlayer.style.transform = '';
    fullPlayer.classList.remove('open', 'dragging');
    fullPlayer.setAttribute('aria-hidden', 'true');

    try {
        tg.BackButton?.hide();
    } catch (e) {}

    setTimeout(() => {
        if (isFullPlayerOpen) return;
        applyTelegramTheme();
        scrollToActiveTrack();
    }, 370);
}

applyTelegramTheme();
try {
    tg.onEvent?.('themeChanged', applyTelegramTheme);
} catch (e) {}

try {
    tg.BackButton?.onClick(() => {
        if (isAddTracksModalOpen) {
            closeAddTracksModal();
        } else if (isPlModalOpen) {
            closePlaylistModal();
        } else if (isPlActionsOpen) {
            closePlaylistActions();
        } else if (isSettingsOpen) {
            closeSettings();
        } else if (isFullPlayerOpen) {
            closeFullPlayer();
        }
    });
} catch (e) {}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (isAddTracksModalOpen) closeAddTracksModal();
        else if (isPlModalOpen) closePlaylistModal();
        else if (isPlActionsOpen) closePlaylistActions();
        else if (isSettingsOpen) closeSettings();
        else if (isFullPlayerOpen) closeFullPlayer();
    }
});

function hideLayerInstantly(el) {
    el.style.transition = 'none';
    el.classList.remove('visible');
    void el.offsetWidth;
    el.style.transition = '';
}

function crossfadeFullPlayerCover(coverUrl, instantCover = false) {
    const seq = ++fpCoverSeq;
    const prevIdx = fpActiveLayer;
    const nextIdx = 1 - fpActiveLayer;

    const prevCover = fpCovers[prevIdx];
    const nextCover = fpCovers[nextIdx];
    const prevBg = fpBgImgs[prevIdx];
    const nextBg = fpBgImgs[nextIdx];

    prevCover.style.zIndex = '1';
    nextCover.style.zIndex = '2';
    prevBg.style.zIndex = '1';
    nextBg.style.zIndex = '2';

    hideLayerInstantly(nextCover);
    hideLayerInstantly(nextBg);

    const preload = new Image();
    preload.onload = () => {
        if (seq !== fpCoverSeq) return;
        fpCoverFallback.style.display = 'none';
        nextCover.src = coverUrl;
        nextBg.src = coverUrl;

        if (instantCover) {
            // При свайпе сама карточка fpArtBox уже анимирует opacity/transform,
            // поэтому обложку внутри меняем мгновенно без двойного наложения теней
            nextCover.style.transition = 'none';
            nextCover.classList.add('visible');
            void nextCover.offsetWidth;
            nextCover.style.transition = '';
            hideLayerInstantly(prevCover);
        }

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (seq !== fpCoverSeq) return;
                if (!instantCover) {
                    nextCover.classList.add('visible');
                }
                nextBg.classList.add('visible');
                fpActiveLayer = nextIdx;
                setTimeout(() => {
                    if (fpActiveLayer === nextIdx) {
                        if (!instantCover) hideLayerInstantly(prevCover);
                        hideLayerInstantly(prevBg);
                    }
                }, 700);
            });
        });
    };
    preload.onerror = () => {
        if (seq !== fpCoverSeq) return;
        hideLayerInstantly(prevCover);
        hideLayerInstantly(nextCover);
        hideLayerInstantly(prevBg);
        hideLayerInstantly(nextBg);
        fpCoverFallback.style.display = 'block';
    };
    preload.src = coverUrl;
}

playerTrackTrigger.addEventListener('click', openFullPlayer);
fpCollapseBtn.addEventListener('click', () => {
    haptic('light');
    closeFullPlayer();
});

// Gestures in fullscreen player: 60fps GPU-accelerated vertical swipe-down to close & horizontal cover swipe to skip
let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartTime = 0;
let swipeDeltaX = 0;
let swipeDeltaY = 0;
let swipeMode = null; // 'vertical' | 'horizontal' | null
let swipeStartedOnArt = false;
let swipeActive = false;
let swipeRafId = null;

function renderSwipeFrame() {
    swipeRafId = null;
    if (!swipeActive) return;
    if (swipeMode === 'horizontal') {
        const clampedX = Math.max(-220, Math.min(220, swipeDeltaX));
        const rot = clampedX * 0.032;
        const op = Math.max(0.35, 1 - Math.abs(clampedX) / 300);
        const baseScale = audio.paused ? 0.92 : 1;
        fpArtBox.style.transform = `translate3d(${clampedX}px, 0, 0) rotate(${rot}deg) scale(${baseScale})`;
        fpArtBox.style.opacity = `${op}`;
    } else if (swipeMode === 'vertical') {
        const dy = Math.max(0, swipeDeltaY);
        fullPlayer.style.transform = `translate3d(0, ${dy}px, 0)`;
    }
}

let nextCoverInstant = false;

function animateArtSwipeChange(direction) {
    // direction: -1 (swipe left -> next track), +1 (swipe right -> prev track)
    const baseScale = audio.paused ? 0.92 : 1;
    fpArtBox.classList.remove('swiping');
    fpArtBox.classList.add('swipe-out');
    fpArtBox.style.transform = `translate3d(${direction * 115}%, 0, 0) rotate(${direction * 6}deg) scale(${baseScale * 0.95})`;
    fpArtBox.style.opacity = '0';

    setTimeout(() => {
        nextCoverInstant = true;
        if (direction < 0) {
            playNextTrack();
        } else {
            playPrevTrack();
        }
        nextCoverInstant = false;

        fpArtBox.classList.remove('swipe-out');
        fpArtBox.classList.add('swiping');
        fpArtBox.style.transform = `translate3d(${-direction * 46}px, 0, 0) scale(0.93)`;
        fpArtBox.style.opacity = '0';
        void fpArtBox.offsetWidth;
        fpArtBox.classList.remove('swiping');
        fpArtBox.style.transform = '';
        fpArtBox.style.opacity = '';
    }, 170);
}

fullPlayer.addEventListener('touchstart', (e) => {
    if (!isFullPlayerOpen || e.touches.length !== 1) return;
    if (e.target.closest('.seek-wrapper') || e.target.closest('button')) return;
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipeStartTime = Date.now();
    swipeDeltaX = 0;
    swipeDeltaY = 0;
    swipeMode = null;
    swipeStartedOnArt = Boolean(e.target.closest('#fpArtBox'));
    swipeActive = true;
}, { passive: true });

fullPlayer.addEventListener('touchmove', (e) => {
    if (!swipeActive) return;
    const dx = e.touches[0].clientX - swipeStartX;
    const dy = e.touches[0].clientY - swipeStartY;

    if (!swipeMode) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (swipeStartedOnArt && Math.abs(dx) > Math.abs(dy)) {
            swipeMode = 'horizontal';
            fpArtBox.classList.remove('swipe-out');
            fpArtBox.classList.add('swiping');
        } else {
            swipeMode = 'vertical';
            fullPlayer.classList.add('dragging');
        }
    }

    if (swipeMode === 'horizontal') {
        if (e.cancelable) e.preventDefault();
        swipeDeltaX = dx;
    } else if (swipeMode === 'vertical') {
        swipeDeltaY = Math.max(0, dy);
    }

    if (swipeRafId === null) {
        swipeRafId = requestAnimationFrame(renderSwipeFrame);
    }
}, { passive: false });

function endFullPlayerSwipe() {
    if (!swipeActive) return;
    swipeActive = false;
    if (swipeRafId !== null) {
        cancelAnimationFrame(swipeRafId);
        swipeRafId = null;
    }
    const elapsed = Math.max(1, Date.now() - swipeStartTime);

    if (swipeMode === 'horizontal') {
        const vx = Math.abs(swipeDeltaX) / elapsed;
        if (Math.abs(swipeDeltaX) > 65 || vx > 0.45) {
            haptic('light');
            animateArtSwipeChange(swipeDeltaX < 0 ? -1 : 1);
        } else {
            fpArtBox.classList.remove('swiping', 'swipe-out');
            fpArtBox.style.transform = '';
            fpArtBox.style.opacity = '';
        }
    } else if (swipeMode === 'vertical') {
        fullPlayer.classList.remove('dragging');
        const vy = swipeDeltaY / elapsed;
        if (swipeDeltaY > 90 || vy > 0.55) {
            closeFullPlayer();
        } else {
            fullPlayer.style.transform = '';
        }
    }
    swipeMode = null;
}

fullPlayer.addEventListener('touchend', endFullPlayerSwipe);
fullPlayer.addEventListener('touchcancel', endFullPlayerSwipe);

let smoothScrollRafId = null;

function cancelSmoothScroll() {
    if (smoothScrollRafId !== null) {
        cancelAnimationFrame(smoothScrollRafId);
        smoothScrollRafId = null;
    }
}

window.addEventListener('touchstart', cancelSmoothScroll, { passive: true });
window.addEventListener('wheel', cancelSmoothScroll, { passive: true });

function smoothScrollToY(targetY) {
    cancelSmoothScroll();
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const clampedTarget = Math.max(0, Math.min(targetY, maxScroll));
    const startY = window.scrollY || document.documentElement.scrollTop || 0;
    const distance = clampedTarget - startY;

    if (Math.abs(distance) < 4) return;

    // Адаптивная длительность: короткий скролл ~280ms, длинный прыжок в Shuffle до 560ms
    const duration = Math.min(560, Math.max(280, Math.abs(distance) * 0.32));
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        // Плавная кривая easeOutCubic (60/120 FPS)
        const eased = 1 - Math.pow(1 - progress, 3);
        window.scrollTo(0, startY + distance * eased);

        if (progress < 1) {
            smoothScrollRafId = requestAnimationFrame(step);
        } else {
            smoothScrollRafId = null;
        }
    }

    smoothScrollRafId = requestAnimationFrame(step);
}

function syncActiveTrackInDOM() {
    const prevItems = trackListEl.querySelectorAll('.track-item.active');
    prevItems.forEach((el) => {
        if (el.dataset.fileId !== currentFileId) {
            el.classList.remove('active');
            const eq = el.querySelector('.eq-overlay');
            if (eq) eq.remove();
        }
    });

    if (!currentFileId) return;
    const nextItem = Array.from(trackListEl.children).find(
        (el) => el.dataset && el.dataset.fileId === currentFileId
    );
    if (!nextItem) return;

    nextItem.classList.add('active');
    const coverWrap = nextItem.querySelector('.cover-wrapper');
    if (coverWrap && !coverWrap.querySelector('.eq-overlay')) {
        const eq = document.createElement('div');
        eq.className = `eq-overlay ${audio.paused ? 'paused' : ''}`;
        eq.innerHTML = '<span></span><span></span><span></span>';
        coverWrap.appendChild(eq);
    }
}

function scrollToActiveTrack() {
    if (isFullPlayerOpen || !userSettings.autoScroll) return;
    requestAnimationFrame(() => {
        const activeItem = trackListEl.querySelector('.track-item.active');
        if (!activeItem) return;

        const headerH = headerEl ? headerEl.offsetHeight : 0;
        const playerH = playerBar.classList.contains('visible') ? playerBar.offsetHeight : 0;
        const visibleHeight = Math.max(120, window.innerHeight - headerH - playerH);

        const rect = activeItem.getBoundingClientRect();
        const currentScrollY = window.scrollY || document.documentElement.scrollTop || 0;
        const itemAbsTop = rect.top + currentScrollY;

        // Центрируем активный трек в видимой области между шапкой и нижним плеером
        const targetTop = Math.max(0, itemAbsTop - headerH - (visibleHeight - rect.height) / 2);
        smoothScrollToY(targetTop);
    });
}

let scrollTicking = false;
window.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
        const y = window.scrollY || document.documentElement.scrollTop || 0;
        headerEl.classList.toggle('scrolled', y > 12);
        scrollTopBtn.classList.toggle('visible', y > 280);
        scrollTicking = false;
    });
}, { passive: true });

scrollTopBtn.addEventListener('click', () => {
    haptic('light');
    smoothScrollToY(0);
});

function playTrackById(fileId, shouldScroll = false) {
    const track = filteredTracks.find(t => t.file_id === fileId) || allTracks.find(t => t.file_id === fileId);
    if (!track) return;
    currentFileId = track.file_id;

    const titleText = track.title || track.name;
    const artistText = track.performer || 'Spotify';

    playerBar.classList.add('visible');
    document.body.classList.add('has-player');
    setMarqueeText(playerTitle, titleText);
    playerArtist.textContent = artistText;

    playerCover.style.visibility = 'visible';
    playerCover.src = track.cover_url;

    setMarqueeText(fpTitle, titleText);
    setMarqueeText(fpArtist, artistText);
    crossfadeFullPlayerCover(track.cover_url, nextCoverInstant);

    pendingResumeTime = null;
    seekSlider.value = 0;
    fpSeekSlider.value = 0;
    setProgressVisual(0, 0);

    // Не даём внутреннему событию pause при смене audio.src сжимать обложку во время буферизации
    cancelAudioFade();
    try { audio.volume = 1; } catch (e) {}
    isSwitchingTrack = true;
    audio.src = track.stream_url;
    applyPlaybackRate();
    saveLastTrackState(true);
    audio.play().catch(() => {
        isSwitchingTrack = false;
        updatePlayButtons(false);
    });
    updatePlayButtons(true);
    syncActiveTrackInDOM();
    if (shouldScroll) {
        scrollToActiveTrack();
    }

    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: titleText,
            artist: artistText,
            artwork: [{ src: track.cover_url, sizes: '512x512', type: 'image/jpeg' }]
        });
    }
}

function playPrevTrack() {
    const order = getActiveOrderIds();
    if (order.length === 0) return;
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    const idx = order.indexOf(currentFileId);
    const prevIdx = idx === -1 ? order.length - 1 : (idx - 1 + order.length) % order.length;
    playTrackById(order[prevIdx], true);
}

function playNextTrack() {
    const order = getActiveOrderIds();
    if (order.length === 0) return;
    const idx = order.indexOf(currentFileId);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % order.length;
    playTrackById(order[nextIdx], true);
}

function togglePlayPause() {
    haptic('light');
    if (!currentFileId && filteredTracks.length > 0) {
        playTrackById(filteredTracks[0].file_id);
        return;
    }
    isSwitchingTrack = false;
    if (audio.paused) {
        playWithFade();
    } else {
        pauseWithFade();
    }
}

function toggleRepeat() {
    haptic('light');
    isRepeat = !isRepeat;
    repeatBtn.classList.toggle('active-mode', isRepeat);
    fpRepeatBtn.classList.toggle('active-mode', isRepeat);
}

function toggleShuffle() {
    haptic('light');
    isShuffle = !isShuffle;
    fpShuffleBtn.classList.toggle('active-mode', isShuffle);
    if (isShuffle) {
        rebuildShuffleQueue();
    }
}

function updatePlayButtons(playing) {
    playIcon.style.display = playing ? 'none' : 'block';
    pauseIcon.style.display = playing ? 'block' : 'none';
    fpPlayIcon.style.display = playing ? 'none' : 'block';
    fpPauseIcon.style.display = playing ? 'block' : 'none';
    fpArtBox.classList.toggle('playing', playing);
    fpPlayPauseBtn.classList.toggle('is-playing', playing);
    document.querySelectorAll('.eq-overlay').forEach(el => {
        el.classList.toggle('paused', !playing);
    });
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
}

if ('mediaSession' in navigator) {
    const setHandler = (action, fn) => {
        try {
            navigator.mediaSession.setActionHandler(action, fn);
        } catch (e) {}
    };
    setHandler('play', () => {
        if (!currentFileId && filteredTracks.length > 0) {
            playTrackById(filteredTracks[0].file_id);
        } else {
            audio.play().catch(() => {});
        }
    });
    setHandler('pause', () => audio.pause());
    setHandler('previoustrack', playPrevTrack);
    setHandler('nexttrack', playNextTrack);
    setHandler('seekto', (details) => {
        if (details && typeof details.seekTime === 'number' && !isNaN(audio.duration)) {
            audio.currentTime = Math.max(0, Math.min(details.seekTime, audio.duration));
        }
    });
}

playPauseBtn.addEventListener('click', togglePlayPause);
fpPlayPauseBtn.addEventListener('click', togglePlayPause);

prevBtn.addEventListener('click', () => { haptic('light'); playPrevTrack(); });
fpPrevBtn.addEventListener('click', () => { haptic('light'); playPrevTrack(); });
nextBtn.addEventListener('click', () => { haptic('light'); playNextTrack(); });
fpNextBtn.addEventListener('click', () => { haptic('light'); playNextTrack(); });

repeatBtn.addEventListener('click', toggleRepeat);
fpRepeatBtn.addEventListener('click', toggleRepeat);
fpShuffleBtn.addEventListener('click', toggleShuffle);

audio.addEventListener('playing', () => {
    isSwitchingTrack = false;
    updatePlayButtons(true);
    startProgressLoop();
});
audio.addEventListener('play', () => {
    updatePlayButtons(true);
    startProgressLoop();
});
audio.addEventListener('pause', () => {
    if (isSwitchingTrack) return;
    updatePlayButtons(false);
    stopProgressLoop();
    saveLastTrackState(true);
});
audio.addEventListener('loadedmetadata', () => {
    applyPlaybackRate();
    if (pendingResumeTime !== null && audio.duration) {
        const clamped = Math.max(0, Math.min(pendingResumeTime, Math.max(0, audio.duration - 1)));
        audio.currentTime = clamped;
        pendingResumeTime = null;
    }
    setProgressVisual(audio.currentTime || 0, audio.duration || 0);
});
audio.addEventListener('seeked', () => {
    if (!isSeeking) {
        setProgressVisual(audio.currentTime || 0, audio.duration || 0);
        saveLastTrackState(true);
    }
});

audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    setProgressVisual(audio.currentTime || 0, audio.duration || 0);
    if (!audio.paused) {
        saveLastTrackState(false);
    }
});

audio.addEventListener('ended', () => {
    stopProgressLoop();
    if (sleepMode === 'track') {
        clearSleepTimer();
        updatePlayButtons(false);
        return;
    }
    if (isRepeat) {
        audio.currentTime = 0;
        setProgressVisual(0, audio.duration || 0);
        audio.play();
    } else if (userSettings.autoNext && filteredTracks.length > 0) {
        playNextTrack();
    } else {
        updatePlayButtons(false);
    }
});

function bindSeekSlider(sliderEl, wrapperEl) {
    sliderEl.addEventListener('input', () => {
        isSeeking = true;
        wrapperEl.classList.add('seeking');
        const val = parseFloat(sliderEl.value) || 0;
        setProgressVisual(val, audio.duration || parseFloat(sliderEl.max) || 0);
    });

    sliderEl.addEventListener('change', () => {
        const val = parseFloat(sliderEl.value) || 0;
        audio.currentTime = val;
        isSeeking = false;
        wrapperEl.classList.remove('seeking');
        setProgressVisual(val, audio.duration || 0);
    });
}

bindSeekSlider(seekSlider, seekWrapper);
bindSeekSlider(fpSeekSlider, fpSeekWrapper);

function getSortedTracks(list) {
    const copy = [...list];
    const order = userSettings.sortOrder || 'newest';
    if (order === 'oldest') {
        return copy.reverse();
    }
    if (order === 'title') {
        return copy.sort((a, b) =>
            String(a.title || a.name || '').localeCompare(String(b.title || b.name || ''), undefined, { sensitivity: 'base' })
        );
    }
    if (order === 'artist') {
        return copy.sort((a, b) => {
            const cmp = String(a.performer || '').localeCompare(String(b.performer || ''), undefined, { sensitivity: 'base' });
            if (cmp !== 0) return cmp;
            return String(a.title || a.name || '').localeCompare(String(b.title || b.name || ''), undefined, { sensitivity: 'base' });
        });
    }
    return copy;
}

function applySearchFilter(options = {}) {
    const q = searchInput.value.trim().toLowerCase();
    const source = getTracksForActivePlaylist();
    const matched = source.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.performer && t.performer.toLowerCase().includes(q)) ||
        (t.name && t.name.toLowerCase().includes(q))
    );
    filteredTracks = getSortedTracks(matched);
    renderTracks(options);
}

searchInput.addEventListener('input', () => applySearchFilter());

async function sendToChat(fileId) {
    try {
        const res = await fetch(`/api/send_track?file_id=${encodeURIComponent(fileId)}`, {
            method: 'POST',
            headers: authHeaders()
        });
        if (res.ok && tg.showPopup) {
            tg.showPopup({ message: 'Трек отправлен в чат с ботом! 🎧' });
        }
    } catch (e) {}
}

function commitServerDelete(fileId, playlistId = 'all', keepalive = false) {
    const url = playlistId === 'all'
        ? `/api/playlist?file_id=${encodeURIComponent(fileId)}`
        : `/api/playlists/${playlistId}/tracks?file_id=${encodeURIComponent(fileId)}`;
    fetch(url, {
        method: 'DELETE',
        headers: authHeaders(),
        keepalive
    }).catch(() => {});
}

function flushPendingDelete(keepalive = false) {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    const { track, playlistId } = pendingDelete;
    pendingDelete = null;
    undoToast.classList.remove('visible');
    commitServerDelete(track.file_id, playlistId, keepalive);
}

function showUndoToast(track, playlistName = null) {
    undoToastText.textContent = playlistName
        ? `Убран из «${playlistName}»`
        : `Удалён: ${track.title || track.name}`;
    undoToast.classList.add('visible');
}

undoDeleteBtn.addEventListener('click', () => {
    if (!pendingDelete) return;
    haptic('light');
    clearTimeout(pendingDelete.timer);
    const { track, playlistId, index } = pendingDelete;
    pendingDelete = null;
    undoToast.classList.remove('visible');

    if (playlistId === 'all') {
        const insertAt = Math.min(index, allTracks.length);
        allTracks.splice(insertAt, 0, track);
    } else {
        const pl = userPlaylists.find(p => p.id === playlistId);
        if (pl && !pl.track_ids.includes(track.file_id)) {
            const insertAt = Math.min(index, pl.track_ids.length);
            pl.track_ids.splice(insertAt, 0, track.file_id);
        }
    }
    if (isShuffle) rebuildShuffleQueue();
    renderPlaylistTabs();
    applySearchFilter({ highlightFileId: track.file_id });
});

window.addEventListener('pagehide', () => {
    saveLastTrackState(true);
    flushPendingDelete(true);
});

function finalizeDeleteUI(fileId, playlistId) {
    const track = allTracks.find(t => t.file_id === fileId);
    if (!track) return;

    let removedIndex = 0;
    let playlistName = null;

    if (playlistId === 'all') {
        removedIndex = allTracks.findIndex(t => t.file_id === fileId);
        if (removedIndex === -1) return;
        allTracks.splice(removedIndex, 1);
        userPlaylists.forEach((p) => {
            p.track_ids = p.track_ids.filter(id => id !== fileId);
        });
        playbackQueueIds = playbackQueueIds.filter(id => id !== fileId);
        shuffledIds = shuffledIds.filter(id => id !== fileId);

        if (currentFileId === fileId) {
            if (getBaseQueueIds().length > 0) {
                playNextTrack();
            } else {
                audio.pause();
                audio.src = '';
                currentFileId = null;
                closeFullPlayer();
                playerBar.classList.remove('visible');
                document.body.classList.remove('has-player');
            }
        }
    } else {
        const pl = userPlaylists.find(p => p.id === playlistId);
        if (!pl) return;
        playlistName = pl.name;
        removedIndex = pl.track_ids.indexOf(fileId);
        if (removedIndex === -1) return;
        pl.track_ids.splice(removedIndex, 1);
    }

    renderPlaylistTabs();
    applySearchFilter();

    showUndoToast(track, playlistName);
    const timer = setTimeout(() => {
        if (pendingDelete && pendingDelete.track.file_id === fileId) {
            pendingDelete = null;
            undoToast.classList.remove('visible');
            commitServerDelete(fileId, playlistId, false);
        }
    }, 5000);

    pendingDelete = { track, playlistId, index: removedIndex, timer };
}

function deleteTrack(fileId) {
    flushPendingDelete(false);

    const targetPlaylistId = activePlaylistId;
    const exists = allTracks.some(t => t.file_id === fileId);
    if (!exists) return;

    haptic('medium');
    const itemEl = Array.from(trackListEl.children).find(
        el => el.dataset && el.dataset.fileId === fileId
    );
    if (itemEl && !itemEl.classList.contains('removing')) {
        itemEl.style.maxHeight = `${itemEl.offsetHeight}px`;
        requestAnimationFrame(() => {
            itemEl.classList.add('removing');
        });
        setTimeout(() => finalizeDeleteUI(fileId, targetPlaylistId), 220);
    } else {
        finalizeDeleteUI(fileId, targetPlaylistId);
    }
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[s]));
}

loadPlaylist();

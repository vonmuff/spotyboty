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
    swipeMode: 'playlists', // 'playlists' | 'tracks'
    coverStyle: 'square', // 'square' | 'vinyl'
    ambientStyle: 'mesh', // 'mesh' | 'aurora' | 'bokeh' | 'parallax' | 'drift' | 'static'
    ambientMotion: 'medium', // 'off' | 'soft' | 'medium' | 'vivid'
    coverHalo: true,
    playbackRate: 1,
    audioFade: true,
    autoNext: true,
    equalizer: true,
    ambientBg: true,
    hideSendBtn: false,
    hideDeleteBtn: false,
    dragReorder: false,
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
        const parsed = JSON.parse(raw);
        if (parsed.hideSendBtn === undefined && typeof parsed.showSendBtn === 'boolean') {
            parsed.hideSendBtn = !parsed.showSendBtn;
        }
        delete parsed.showSendBtn;
        return { ...DEFAULT_SETTINGS, ...parsed };
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
    document.body.dataset.ambientStyle = userSettings.ambientStyle || 'mesh';
    document.body.dataset.ambientMotion = userSettings.ambientMotion || 'medium';
    document.body.classList.toggle('cover-halo', Boolean(userSettings.coverHalo));
    document.body.classList.toggle('hide-send-btn', Boolean(userSettings.hideSendBtn));
    document.body.classList.toggle('hide-delete-btn', Boolean(userSettings.hideDeleteBtn));
    document.body.classList.toggle('compact-list', userSettings.density === 'compact');
    document.body.classList.toggle('vinyl-cover', userSettings.coverStyle === 'vinyl');
    document.body.classList.toggle('no-marquee', !userSettings.marquee);
    document.body.classList.toggle('reduced-motion', Boolean(userSettings.reducedMotion));
    applyTelegramTheme();
    if (typeof syncAmbientRuntime === 'function') syncAmbientRuntime();
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
let isTrackPlaylistsModalOpen = false;
let isTrackActionsOpen = false;
let isStatsOpen = false;
let statsPeriod = 'all';
let listenSession = { fileId: null, accumSec: 0, lastResumeAt: null, duration: 0 };
let trackPlaylistsTargetFileId = null;
let trackActionsTargetFileId = null;
let pendingAddFileIdAfterCreate = null;
let editingPlaylistId = null;
let selectedModalEmoji = '🎧';
let pickerSelectedIds = new Set();
let suppressNextTrackClick = false;
let suppressNextTabClick = false;
let bokehParticles = [];
let ambientRafId = null;
let lastAmbientFrameTime = 0;
let paletteMorphRafId = null;

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
const trackPlaylistsBackdrop = document.getElementById('trackPlaylistsBackdrop');
const trackPlaylistsSubtitle = document.getElementById('trackPlaylistsSubtitle');
const trackPlaylistsCloseBtn = document.getElementById('trackPlaylistsCloseBtn');
const trackPlaylistsList = document.getElementById('trackPlaylistsList');
const trackPlaylistsCreateBtn = document.getElementById('trackPlaylistsCreateBtn');
const trackActionsBackdrop = document.getElementById('trackActionsBackdrop');
const trackActionsTitle = document.getElementById('trackActionsTitle');
const trackActionsSubtitle = document.getElementById('trackActionsSubtitle');
const trackActionsCloseBtn = document.getElementById('trackActionsCloseBtn');
const trackActPlaylistBtn = document.getElementById('trackActPlaylistBtn');
const trackActSendBtn = document.getElementById('trackActSendBtn');
const trackActDeleteBtn = document.getElementById('trackActDeleteBtn');
const trackActDeleteLabel = document.getElementById('trackActDeleteLabel');
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
const fpBgAlts = [document.getElementById('fpBgAltA'), document.getElementById('fpBgAltB')];
const fpBokehCanvas = document.getElementById('fpBokehCanvas');
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
const statsBtn = document.getElementById('statsBtn');
const statsBackdrop = document.getElementById('statsBackdrop');
const statsCloseBtn = document.getElementById('statsCloseBtn');
const statsPeriodSegment = document.getElementById('statsPeriodSegment');
const statsBody = document.getElementById('statsBody');
const settingsBackdrop = document.getElementById('settingsBackdrop');
const settingsSheet = document.getElementById('settingsSheet');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const accentPalette = document.getElementById('accentPalette');
const fpThemeSegment = document.getElementById('fpThemeSegment');
const sortSegment = document.getElementById('sortSegment');
const densitySegment = document.getElementById('densitySegment');
const swipeModeSegment = document.getElementById('swipeModeSegment');
const coverStyleSegment = document.getElementById('coverStyleSegment');
const ambientStyleSegment = document.getElementById('ambientStyleSegment');
const ambientMotionSegment = document.getElementById('ambientMotionSegment');
const sleepSegment = document.getElementById('sleepSegment');
const sleepTimerBadge = document.getElementById('sleepTimerBadge');
const speedSegment = document.getElementById('speedSegment');
const optAudioFade = document.getElementById('optAudioFade');
const optAutoNext = document.getElementById('optAutoNext');
const optEqualizer = document.getElementById('optEqualizer');
const optAmbientBg = document.getElementById('optAmbientBg');
const optCoverHalo = document.getElementById('optCoverHalo');
const optHideSendBtn = document.getElementById('optHideSendBtn');
const optHideDeleteBtn = document.getElementById('optHideDeleteBtn');
const optDragReorder = document.getElementById('optDragReorder');
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
    swipeModeSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.swipeMode === (userSettings.swipeMode || 'playlists'));
    });
    coverStyleSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.coverStyle === userSettings.coverStyle);
    });
    ambientStyleSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.ambientStyle === (userSettings.ambientStyle || 'mesh'));
    });
    ambientMotionSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.ambientMotion === (userSettings.ambientMotion || 'medium'));
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
    optCoverHalo.checked = Boolean(userSettings.coverHalo);
    optHideSendBtn.checked = Boolean(userSettings.hideSendBtn);
    optHideDeleteBtn.checked = Boolean(userSettings.hideDeleteBtn);
    optDragReorder.checked = Boolean(userSettings.dragReorder);
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

swipeModeSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    userSettings.swipeMode = btn.dataset.swipeMode === 'tracks' ? 'tracks' : 'playlists';
    saveUserSettings();
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

ambientStyleSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    userSettings.ambientStyle = btn.dataset.ambientStyle || 'mesh';
    if (!userSettings.ambientBg) {
        userSettings.ambientBg = true;
    }
    saveUserSettings();
    applyUserSettings();
    syncSettingsUI();
    haptic('light');
});

ambientMotionSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const mode = btn.dataset.ambientMotion;
    userSettings.ambientMotion = mode;
    if (mode !== 'off' && !userSettings.ambientBg) {
        userSettings.ambientBg = true;
    }
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

optCoverHalo.addEventListener('change', () => {
    userSettings.coverHalo = optCoverHalo.checked;
    saveUserSettings();
    applyUserSettings();
    haptic('light');
});

optHideSendBtn.addEventListener('change', () => {
    userSettings.hideSendBtn = optHideSendBtn.checked;
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

optDragReorder.addEventListener('change', () => {
    userSettings.dragReorder = optDragReorder.checked;
    saveUserSettings();
    renderTracks();
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
let progressResetTimer = null;
let pendingDelete = null;

function clearSmoothProgressReset() {
    if (progressResetTimer) {
        clearTimeout(progressResetTimer);
        progressResetTimer = null;
    }
    seekWrapper.classList.remove('seek-resetting');
    fpSeekWrapper.classList.remove('seek-resetting');
}

function resetProgressSmoothly() {
    clearSmoothProgressReset();
    if (!userSettings.reducedMotion) {
        seekWrapper.classList.add('seek-resetting');
        fpSeekWrapper.classList.add('seek-resetting');
        progressResetTimer = setTimeout(() => {
            progressResetTimer = null;
            seekWrapper.classList.remove('seek-resetting');
            fpSeekWrapper.classList.remove('seek-resetting');
        }, 300);
    }
    seekSlider.value = 0;
    fpSeekSlider.value = 0;
    setProgressVisual(0, 0);
}

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
        btn.dataset.custom = '1';
        btn.innerHTML = `${escapeHtml(pl.emoji || '🎧')} ${escapeHtml(pl.name)} <span class="pl-tab-count">${pl.track_ids.length}</span>`;
        btn.addEventListener('click', () => {
            if (suppressNextTabClick) {
                suppressNextTabClick = false;
                return;
            }
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
    if (!isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isTrackPlaylistsModalOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isTrackPlaylistsModalOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

// ===== Drag & Drop Reordering of Playlist Tabs (Long-press) =====
let tabDragState = null;

function cancelTabLongPress() {
    if (tabDragState && tabDragState.timer) {
        clearTimeout(tabDragState.timer);
        tabDragState.timer = null;
    }
}

function finishTabDrag() {
    if (!tabDragState) return;
    const state = tabDragState;
    cancelTabLongPress();
    tabDragState = null;

    if (!state.active) return;

    state.tabEl.classList.remove('tab-dragging');
    playlistTabs.classList.remove('reordering');

    const newOrderIds = Array.from(playlistTabs.querySelectorAll('.pl-tab[data-custom="1"]'))
        .map(el => Number(el.dataset.plId))
        .filter(id => !Number.isNaN(id));

    const changed = newOrderIds.length === state.initialOrder.length &&
        newOrderIds.some((id, i) => id !== state.initialOrder[i]);

    if (changed) {
        const byId = new Map(userPlaylists.map(p => [p.id, p]));
        userPlaylists = newOrderIds.map(id => byId.get(id)).filter(Boolean);
        fetch('/api/playlists/reorder', {
            method: 'PUT',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist_ids: newOrderIds }),
        }).catch(() => {});
        haptic('medium');
    }
}

playlistTabs.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (userPlaylists.length < 2) return;
    const tabEl = e.target.closest('.pl-tab[data-custom="1"]');
    if (!tabEl) return;

    const initialOrder = userPlaylists.map(p => p.id);
    const state = {
        pointerId: e.pointerId,
        tabEl,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        initialOrder,
        timer: null,
    };
    state.timer = setTimeout(() => {
        if (tabDragState !== state) return;
        state.active = true;
        suppressNextTabClick = true;
        tabEl.classList.add('tab-dragging');
        playlistTabs.classList.add('reordering');
        try { playlistTabs.setPointerCapture(state.pointerId); } catch (err) {}
        haptic('medium');
    }, 300);

    tabDragState = state;
});

playlistTabs.addEventListener('pointermove', (e) => {
    if (!tabDragState || e.pointerId !== tabDragState.pointerId) return;

    if (!tabDragState.active) {
        if (Math.abs(e.clientX - tabDragState.startX) > 8 || Math.abs(e.clientY - tabDragState.startY) > 8) {
            cancelTabLongPress();
            tabDragState = null;
        }
        return;
    }

    if (e.cancelable) e.preventDefault();
    const customTabs = Array.from(playlistTabs.querySelectorAll('.pl-tab[data-custom="1"]'));
    const dragged = tabDragState.tabEl;
    const curIdx = customTabs.indexOf(dragged);
    if (curIdx === -1) return;

    for (let i = 0; i < customTabs.length; i++) {
        const other = customTabs[i];
        if (other === dragged) continue;
        const rect = other.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (i < curIdx && e.clientX < midX) {
            playlistTabs.insertBefore(dragged, other);
            haptic('light');
            break;
        } else if (i > curIdx && e.clientX > midX) {
            playlistTabs.insertBefore(dragged, other.nextSibling);
            haptic('light');
            break;
        }
    }
});

playlistTabs.addEventListener('pointerup', (e) => {
    if (tabDragState && e.pointerId === tabDragState.pointerId) {
        finishTabDrag();
    }
});

playlistTabs.addEventListener('pointercancel', (e) => {
    if (tabDragState && e.pointerId === tabDragState.pointerId) {
        finishTabDrag();
    }
});

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
        visualX = Math.max(-36, Math.min(36, tabSwipeDeltaX * 0.22));
    } else {
        visualX = Math.max(-130, Math.min(130, tabSwipeDeltaX * 0.65));
    }
    const op = atStartEdge || atEndEdge ? 1 : Math.max(0.72, 1 - Math.abs(visualX) / 420);
    trackListEl.style.transform = `translate3d(${visualX}px, 0, 0)`;
    trackListEl.style.opacity = `${op}`;
}

let tabSwipeSwitchTimer = null;

function animateTabSwipeSwitch(targetPlId, direction) {
    // direction: -1 (swipe left -> next tab), +1 (swipe right -> prev tab)
    if (tabSwipeSwitchTimer) {
        clearTimeout(tabSwipeSwitchTimer);
        tabSwipeSwitchTimer = null;
    }
    const currentOffset = Math.min(130, Math.abs(tabSwipeDeltaX) * 0.65);
    const exitX = direction * Math.max(72, currentOffset + 42);

    trackListEl.classList.remove('swiping');
    trackListEl.classList.add('swipe-out');
    trackListEl.style.transform = `translate3d(${exitX}px, 0, 0)`;
    trackListEl.style.opacity = '0';

    tabSwipeSwitchTimer = setTimeout(() => {
        tabSwipeSwitchTimer = null;
        activePlaylistId = targetPlId;
        renderPlaylistTabs();
        applySearchFilter();
        window.scrollTo(0, 0);

        trackListEl.classList.remove('swipe-out');
        trackListEl.classList.add('swiping');
        trackListEl.style.transform = `translate3d(${-direction * 26}px, 0, 0)`;
        trackListEl.style.opacity = '0';

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                trackListEl.classList.remove('swiping');
                trackListEl.style.transform = '';
                trackListEl.style.opacity = '';
            });
        });
    }, 155);
}

document.addEventListener('touchstart', (e) => {
    if (userPlaylists.length === 0) return;
    if (isFullPlayerOpen || isSettingsOpen || isStatsOpen || isPlActionsOpen || isPlModalOpen || isAddTracksModalOpen || isTrackPlaylistsModalOpen || isTrackActionsOpen) return;
    if (e.touches.length !== 1) return;
    if (e.target.closest('.header, .player-bar, .seek-wrapper, .undo-toast, .drag-handle, input, button')) return;
    if (userSettings.swipeMode === 'tracks' && e.target.closest('.track-swipe-wrap')) return;

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

// ===== Two-finger Touchpad Swipes (PC: Playlists, Fullscreen Track Skip & Open/Close Player) =====
let wheelAccumX = 0;
let wheelAccumY = 0;
let wheelLocked = false;
let wheelLockedAt = 0;
let wheelResetTimer = null;

window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    if (isSettingsOpen || isStatsOpen || isPlActionsOpen || isPlModalOpen || isAddTracksModalOpen || isTrackPlaylistsModalOpen || isTrackActionsOpen) return;
    if (!isFullPlayerOpen && e.target.closest('.playlist-tabs')) return;

    const absX = Math.abs(e.deltaX);
    const absY = Math.abs(e.deltaY);

    // 1) Вертикальный свайп двумя пальцами:
    //    - в полноэкранном плеере (вверх или вниз) -> плавно свернуть плеер
    //    - на мини-плеере внизу (вверх или вниз) -> плавно развернуть плеер
    const onMiniPlayer = !isFullPlayerOpen && Boolean(e.target.closest('.player-bar')) && Boolean(currentFileId);
    if ((isFullPlayerOpen || onMiniPlayer) && absY >= 4 && absY > absX * 1.35) {
        if (e.cancelable) e.preventDefault();

        if (wheelResetTimer) clearTimeout(wheelResetTimer);
        wheelResetTimer = setTimeout(() => {
            wheelAccumX = 0;
            wheelAccumY = 0;
            wheelLocked = false;
            wheelResetTimer = null;
        }, 200);

        if (wheelLocked) {
            if (Date.now() - wheelLockedAt < 560) return;
            wheelLocked = false;
            wheelAccumY = 0;
        }

        wheelAccumY += e.deltaY;
        if (Math.abs(wheelAccumY) < 85) return;

        wheelAccumY = 0;
        wheelLocked = true;
        wheelLockedAt = Date.now();
        haptic('light');
        if (isFullPlayerOpen) {
            closeFullPlayer();
        } else {
            openFullPlayer();
        }
        return;
    }

    // 2) Горизонтальный свайп двумя пальцами (переключение плейлистов / треков)
    if (absX < 4 || absX <= absY * 1.35) return;

    if (isFullPlayerOpen) {
        if (getBaseQueueIds().length < 2) return;
    } else {
        if (userPlaylists.length === 0) return;
    }

    if (e.cancelable) e.preventDefault();

    if (wheelResetTimer) clearTimeout(wheelResetTimer);
    wheelResetTimer = setTimeout(() => {
        wheelAccumX = 0;
        wheelAccumY = 0;
        wheelLocked = false;
        wheelResetTimer = null;
    }, 180);

    if (wheelLocked) {
        // Позволяем повторный осознанный жест после 520 мс, но гасим инерцию тачпада
        if (Date.now() - wheelLockedAt < 520) return;
        wheelLocked = false;
        wheelAccumX = 0;
    }

    wheelAccumX += e.deltaX;
    if (Math.abs(wheelAccumX) < 55) return;

    const goNext = wheelAccumX > 0;
    wheelAccumX = 0;
    wheelLocked = true;
    wheelLockedAt = Date.now();

    if (isFullPlayerOpen) {
        animateArtSwipeChange(goNext ? -1 : 1);
    } else {
        const tabs = getAllTabIds();
        const curIdx = tabs.indexOf(activePlaylistId);
        tabSwipeDeltaX = 0;
        if (goNext && curIdx < tabs.length - 1) {
            animateTabSwipeSwitch(tabs[curIdx + 1], -1);
        } else if (!goNext && curIdx > 0) {
            animateTabSwipeSwitch(tabs[curIdx - 1], 1);
        }
    }
}, { passive: false });

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
    pendingAddFileIdAfterCreate = null;
    plModalBackdrop.classList.remove('open');
    plModalBackdrop.setAttribute('aria-hidden', 'true');
    if (!isSettingsOpen && !isAddTracksModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isAddTracksModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen) {
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
                const createdPl = data.playlist;
                const pendingFid = pendingAddFileIdAfterCreate;
                pendingAddFileIdAfterCreate = null;
                userPlaylists.push(createdPl);
                if (pendingFid) {
                    try {
                        const addRes = await fetch(`/api/playlists/${createdPl.id}/tracks`, {
                            method: 'POST',
                            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                            body: JSON.stringify({ file_ids: [pendingFid] }),
                        });
                        if (addRes.ok) {
                            createdPl.track_ids = [pendingFid];
                        }
                    } catch (e) {}
                }
                closePlaylistModal();
                selectPlaylistTab(createdPl.id, true);
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
    if (!isSettingsOpen && !isPlModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isPlModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

// ===== Quick "Add Track to Playlist" Modal (Swipe Right) =====
function renderTrackPlaylistsModalList() {
    const fileId = trackPlaylistsTargetFileId;
    if (!fileId) return;

    if (userPlaylists.length === 0) {
        trackPlaylistsList.innerHTML = `<div class="empty-state" style="padding:20px 10px;">У вас пока нет плейлистов — создайте первый ниже</div>`;
        return;
    }

    trackPlaylistsList.innerHTML = '';
    userPlaylists.forEach((pl) => {
        const hasTrack = pl.track_ids.includes(fileId);
        const row = document.createElement('div');
        row.className = `picker-row ${hasTrack ? 'selected' : ''}`;
        row.innerHTML = `
            <div class="picker-check">✓</div>
            <div class="picker-info">
                <div class="picker-title">${escapeHtml(pl.emoji || '🎧')} ${escapeHtml(pl.name)}</div>
                <div class="picker-artist">${pl.track_ids.length} треков</div>
            </div>
        `;
        row.addEventListener('click', async () => {
            const currentlyIn = pl.track_ids.includes(fileId);
            haptic('light');
            if (currentlyIn) {
                pl.track_ids = pl.track_ids.filter(id => id !== fileId);
                row.classList.remove('selected');
                row.querySelector('.picker-artist').textContent = `${pl.track_ids.length} треков`;
                renderPlaylistTabs();
                if (activePlaylistId === pl.id) applySearchFilter();
                fetch(`/api/playlists/${pl.id}/tracks?file_id=${encodeURIComponent(fileId)}`, {
                    method: 'DELETE',
                    headers: authHeaders(),
                }).catch(() => {});
            } else {
                pl.track_ids = [fileId, ...pl.track_ids];
                row.classList.add('selected');
                row.querySelector('.picker-artist').textContent = `${pl.track_ids.length} треков`;
                renderPlaylistTabs();
                if (activePlaylistId === pl.id) applySearchFilter();
                fetch(`/api/playlists/${pl.id}/tracks`, {
                    method: 'POST',
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file_ids: [fileId] }),
                }).catch(() => {});
            }
        });
        trackPlaylistsList.appendChild(row);
    });
}

function openTrackPlaylistsModal(fileId) {
    const track = allTracks.find(t => t.file_id === fileId);
    if (!track) return;
    trackPlaylistsTargetFileId = fileId;
    trackPlaylistsSubtitle.textContent = `${track.title || track.name} — ${track.performer || 'Spotify'}`;
    renderTrackPlaylistsModalList();

    isTrackPlaylistsModalOpen = true;
    document.body.classList.add('settings-open');
    trackPlaylistsBackdrop.classList.add('open');
    trackPlaylistsBackdrop.setAttribute('aria-hidden', 'false');
    try { tg.BackButton?.show(); } catch (e) {}
}

function closeTrackPlaylistsModal() {
    if (!isTrackPlaylistsModalOpen) return;
    isTrackPlaylistsModalOpen = false;
    trackPlaylistsTargetFileId = null;
    trackPlaylistsBackdrop.classList.remove('open');
    trackPlaylistsBackdrop.setAttribute('aria-hidden', 'true');
    if (!isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isPlActionsOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isPlActionsOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

trackPlaylistsCloseBtn.addEventListener('click', closeTrackPlaylistsModal);
trackPlaylistsBackdrop.addEventListener('click', (e) => {
    if (e.target === trackPlaylistsBackdrop) closeTrackPlaylistsModal();
});
trackPlaylistsCreateBtn.addEventListener('click', () => {
    const fid = trackPlaylistsTargetFileId;
    closeTrackPlaylistsModal();
    pendingAddFileIdAfterCreate = fid;
    openPlaylistModal(null);
});

// ===== Track Long-Press Action Sheet =====
function openTrackActions(fileId) {
    const track = allTracks.find(t => t.file_id === fileId);
    if (!track || isTrackActionsOpen) return;
    trackActionsTargetFileId = fileId;
    trackActionsTitle.textContent = track.title || track.name;
    trackActionsSubtitle.textContent = track.performer || 'Spotify';
    trackActDeleteLabel.textContent = activePlaylistId === 'all' ? 'Удалить трек' : 'Убрать из плейлиста';

    isTrackActionsOpen = true;
    document.body.classList.add('settings-open');
    trackActionsBackdrop.classList.add('open');
    trackActionsBackdrop.setAttribute('aria-hidden', 'false');
    haptic('medium');
    try { tg.BackButton?.show(); } catch (e) {}
}

function closeTrackActions() {
    if (!isTrackActionsOpen) return;
    isTrackActionsOpen = false;
    trackActionsTargetFileId = null;
    trackActionsBackdrop.classList.remove('open');
    trackActionsBackdrop.setAttribute('aria-hidden', 'true');
    if (!isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

trackActionsCloseBtn.addEventListener('click', closeTrackActions);
trackActionsBackdrop.addEventListener('click', (e) => {
    if (e.target === trackActionsBackdrop) closeTrackActions();
});
trackActPlaylistBtn.addEventListener('click', () => {
    const fid = trackActionsTargetFileId;
    closeTrackActions();
    if (fid) openTrackPlaylistsModal(fid);
});
trackActSendBtn.addEventListener('click', () => {
    const fid = trackActionsTargetFileId;
    closeTrackActions();
    if (fid) sendToChat(fid);
});
trackActDeleteBtn.addEventListener('click', () => {
    const fid = trackActionsTargetFileId;
    closeTrackActions();
    if (fid) deleteTrack(fid);
});

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
    renderSkeleton();
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
    const canReorderTracks = Boolean(userSettings.dragReorder) && Boolean(activePl) && !searchInput.value.trim() && (userSettings.sortOrder === 'newest' || !userSettings.sortOrder);
    const deleteSwipeLabel = activePl ? 'Убрать' : 'Удалить';

    filteredTracks.forEach((track, idx) => {
        const isCurrent = currentFileId !== null && currentFileId === track.file_id;
        const wrap = document.createElement('div');
        const wrapClasses = ['track-swipe-wrap'];
        if (animateEntrance && idx < 14) {
            wrapClasses.push('entering');
            wrap.style.setProperty('--enter-idx', idx);
        }
        if (highlightFileId && track.file_id === highlightFileId) {
            wrapClasses.push('restoring');
        }
        wrap.className = wrapClasses.join(' ');
        wrap.dataset.fileId = track.file_id;

        const coverUrl = track.cover_url;
        const eqHtml = isCurrent
            ? `<div class="eq-overlay ${isPaused ? 'paused' : ''}"><span></span><span></span><span></span></div>`
            : '';
        const dragHandleHtml = canReorderTracks
            ? `<div class="drag-handle" title="Перетащить для сортировки" aria-label="Перетащить"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg></div>`
            : '';

        wrap.innerHTML = `
            <div class="swipe-bg" aria-hidden="true">
                <div class="swipe-action swipe-action-left">📂 В плейлист</div>
                <div class="swipe-action swipe-action-right">🗑 ${deleteSwipeLabel}</div>
            </div>
            <div class="track-item ${isCurrent ? 'active' : ''}" data-file-id="${escapeHtml(track.file_id)}">
                ${dragHandleHtml}
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
                    <button class="icon-btn delete" title="${deleteSwipeLabel}" data-action="delete">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </div>
            </div>
        `;

        const item = wrap.querySelector('.track-item');
        item.addEventListener('click', (e) => {
            if (suppressNextTrackClick) {
                suppressNextTrackClick = false;
                return;
            }
            if (e.target.closest('.drag-handle')) return;
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
            playTrackById(track.file_id, true);
            if (userSettings.autoOpenPlayer) {
                openFullPlayer();
            }
        });

        trackListEl.appendChild(wrap);
    });
}

// ===== Track Card Long-Press (Context Menu) & Optional Swipe =====
const CARD_SWIPE_THRESHOLD = 74;
let cardSwipeState = null;
let trackLongPressState = null;

function cancelTrackLongPress() {
    if (trackLongPressState) {
        if (trackLongPressState.timer) clearTimeout(trackLongPressState.timer);
        trackLongPressState = null;
    }
}

trackListEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.track-swipe-wrap')) {
        e.preventDefault();
    }
});

function resetCardSwipeVisual(state) {
    if (!state) return;
    state.itemEl.classList.remove('swiping');
    state.itemEl.style.transform = '';
    state.bgEl.classList.remove('visible', 'dir-right', 'dir-left', 'armed');
}

trackListEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isFullPlayerOpen || isSettingsOpen || isPlActionsOpen || isPlModalOpen || isAddTracksModalOpen || isTrackPlaylistsModalOpen || isTrackActionsOpen) return;
    if (trackDragState) return;
    if (e.target.closest('.drag-handle, button')) return;
    const wrapEl = e.target.closest('.track-swipe-wrap');
    if (!wrapEl) return;
    const itemEl = wrapEl.querySelector('.track-item');
    const bgEl = wrapEl.querySelector('.swipe-bg');
    if (!itemEl || !bgEl) return;

    const fileId = wrapEl.dataset.fileId;

    // Долгий тап по карточке (360 мс) — открывает меню действий трека в любом режиме свайпа
    cancelTrackLongPress();
    const lpState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        timer: null,
    };
    lpState.timer = setTimeout(() => {
        if (trackLongPressState !== lpState) return;
        trackLongPressState = null;
        if (cardSwipeState && cardSwipeState.locked === 'horizontal') return;
        cardSwipeState = null;
        tabSwipeActive = false;
        suppressNextTrackClick = true;
        setTimeout(() => { suppressNextTrackClick = false; }, 320);
        openTrackActions(fileId);
    }, 360);
    trackLongPressState = lpState;

    // Свайп самой карточки работает только если выбран режим 'tracks'
    if (userSettings.swipeMode !== 'tracks') return;

    cardSwipeState = {
        pointerId: e.pointerId,
        wrapEl,
        itemEl,
        bgEl,
        fileId,
        startX: e.clientX,
        startY: e.clientY,
        dx: 0,
        locked: null,
        armed: false,
    };
});

trackListEl.addEventListener('pointermove', (e) => {
    if (trackLongPressState && e.pointerId === trackLongPressState.pointerId) {
        if (Math.abs(e.clientX - trackLongPressState.startX) > 8 || Math.abs(e.clientY - trackLongPressState.startY) > 8) {
            cancelTrackLongPress();
        }
    }
    if (!cardSwipeState || e.pointerId !== cardSwipeState.pointerId) return;
    const s = cardSwipeState;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;

    if (!s.locked) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.25) {
            s.locked = 'horizontal';
            cancelTrackLongPress();
            s.itemEl.classList.add('swiping');
            try { trackListEl.setPointerCapture(s.pointerId); } catch (err) {}
        } else {
            s.locked = 'vertical';
            cardSwipeState = null;
            return;
        }
    }

    if (s.locked !== 'horizontal') return;
    if (e.cancelable) e.preventDefault();

    const maxSwipe = 128;
    const clamped = Math.abs(dx) <= 92
        ? dx
        : Math.sign(dx) * Math.min(maxSwipe, 92 + (Math.abs(dx) - 92) * 0.35);
    s.dx = clamped;
    s.itemEl.style.transform = `translate3d(${clamped}px, 0, 0)`;

    const isRight = clamped > 0;
    s.bgEl.classList.add('visible');
    s.bgEl.classList.toggle('dir-right', isRight);
    s.bgEl.classList.toggle('dir-left', !isRight);

    const nowArmed = Math.abs(clamped) >= CARD_SWIPE_THRESHOLD;
    if (nowArmed !== s.armed) {
        s.armed = nowArmed;
        s.bgEl.classList.toggle('armed', nowArmed);
        if (nowArmed) haptic('light');
    }
});

function endCardSwipe(e, cancelled = false) {
    if (trackLongPressState && (!e || e.pointerId === trackLongPressState.pointerId)) {
        cancelTrackLongPress();
    }
    if (!cardSwipeState || (e && e.pointerId !== cardSwipeState.pointerId)) return;
    const s = cardSwipeState;
    cardSwipeState = null;

    if (s.locked !== 'horizontal') return;
    suppressNextTrackClick = true;
    setTimeout(() => { suppressNextTrackClick = false; }, 260);

    const triggered = !cancelled && Math.abs(s.dx) >= CARD_SWIPE_THRESHOLD;
    const isRight = s.dx > 0;

    resetCardSwipeVisual(s);

    if (triggered) {
        if (isRight) {
            haptic('medium');
            openTrackPlaylistsModal(s.fileId);
        } else {
            deleteTrack(s.fileId);
        }
    }
}

trackListEl.addEventListener('pointerup', (e) => endCardSwipe(e, false));
trackListEl.addEventListener('pointercancel', (e) => endCardSwipe(e, true));

// ===== Drag & Drop Reordering of Tracks inside Custom Playlists =====
let trackDragState = null;

function stopTrackDragAutoScroll() {
    if (trackDragState && trackDragState.scrollRafId !== null) {
        cancelAnimationFrame(trackDragState.scrollRafId);
        trackDragState.scrollRafId = null;
    }
}

function updateTrackDragPosition(clientY) {
    if (!trackDragState) return;
    const s = trackDragState;
    const dy = (clientY - s.anchorClientY) + (window.scrollY - s.anchorScrollY);
    s.wrapEl.style.transform = `translate3d(0, ${dy}px, 0)`;

    const children = Array.from(trackListEl.children);
    const curIdx = children.indexOf(s.wrapEl);
    if (curIdx === -1) return;

    const draggedRect = s.wrapEl.getBoundingClientRect();
    const draggedMidY = draggedRect.top + draggedRect.height / 2;

    if (curIdx > 0) {
        const prev = children[curIdx - 1];
        const prevRect = prev.getBoundingClientRect();
        if (draggedMidY < prevRect.top + prevRect.height / 2) {
            const beforeTop = s.wrapEl.getBoundingClientRect().top;
            trackListEl.insertBefore(s.wrapEl, prev);
            const afterTop = s.wrapEl.getBoundingClientRect().top;
            s.anchorClientY += (afterTop - beforeTop);
            const newDy = (clientY - s.anchorClientY) + (window.scrollY - s.anchorScrollY);
            s.wrapEl.style.transform = `translate3d(0, ${newDy}px, 0)`;
            haptic('light');
            return;
        }
    }

    if (curIdx < children.length - 1) {
        const next = children[curIdx + 1];
        const nextRect = next.getBoundingClientRect();
        if (draggedMidY > nextRect.top + nextRect.height / 2) {
            const beforeTop = s.wrapEl.getBoundingClientRect().top;
            trackListEl.insertBefore(s.wrapEl, next.nextSibling);
            const afterTop = s.wrapEl.getBoundingClientRect().top;
            s.anchorClientY += (afterTop - beforeTop);
            const newDy = (clientY - s.anchorClientY) + (window.scrollY - s.anchorScrollY);
            s.wrapEl.style.transform = `translate3d(0, ${newDy}px, 0)`;
            haptic('light');
        }
    }
}

function runTrackDragAutoScroll() {
    if (!trackDragState) return;
    const s = trackDragState;
    const edge = 80;
    let delta = 0;
    if (s.lastClientY < edge) {
        delta = -Math.ceil((edge - s.lastClientY) / 10);
    } else if (s.lastClientY > window.innerHeight - edge) {
        delta = Math.ceil((s.lastClientY - (window.innerHeight - edge)) / 10);
    }
    if (delta !== 0) {
        window.scrollBy(0, delta);
        updateTrackDragPosition(s.lastClientY);
        s.scrollRafId = requestAnimationFrame(runTrackDragAutoScroll);
    } else {
        s.scrollRafId = null;
    }
}

function finishTrackDrag() {
    if (!trackDragState) return;
    const s = trackDragState;
    stopTrackDragAutoScroll();
    trackDragState = null;

    s.wrapEl.classList.remove('drag-active');
    s.wrapEl.style.transform = '';
    suppressNextTrackClick = true;
    setTimeout(() => { suppressNextTrackClick = false; }, 220);

    const activePl = getActiveCustomPlaylist();
    if (!activePl) return;

    const newIds = Array.from(trackListEl.children)
        .map(el => el.dataset && el.dataset.fileId)
        .filter(Boolean);

    const changed = newIds.length === s.initialIds.length &&
        newIds.some((id, idx) => id !== s.initialIds[idx]);

    if (changed) {
        activePl.track_ids = newIds;
        filteredTracks = getSortedTracks(getTracksForActivePlaylist());
        fetch(`/api/playlists/${activePl.id}/reorder`, {
            method: 'PUT',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_ids: newIds }),
        }).catch(() => {});
        haptic('medium');
    }
}

trackListEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const wrapEl = handle.closest('.track-swipe-wrap');
    if (!wrapEl) return;

    if (e.cancelable) e.preventDefault();
    const initialIds = Array.from(trackListEl.children)
        .map(el => el.dataset && el.dataset.fileId)
        .filter(Boolean);

    trackDragState = {
        pointerId: e.pointerId,
        wrapEl,
        anchorClientY: e.clientY,
        anchorScrollY: window.scrollY,
        lastClientY: e.clientY,
        initialIds,
        scrollRafId: null,
    };

    wrapEl.classList.add('drag-active');
    try { trackListEl.setPointerCapture(e.pointerId); } catch (err) {}
    haptic('medium');
});

trackListEl.addEventListener('pointermove', (e) => {
    if (!trackDragState || e.pointerId !== trackDragState.pointerId) return;
    if (e.cancelable) e.preventDefault();
    trackDragState.lastClientY = e.clientY;
    updateTrackDragPosition(e.clientY);
    if (trackDragState.scrollRafId === null) {
        const edge = 80;
        if (e.clientY < edge || e.clientY > window.innerHeight - edge) {
            trackDragState.scrollRafId = requestAnimationFrame(runTrackDragAutoScroll);
        }
    }
});

trackListEl.addEventListener('pointerup', (e) => {
    if (trackDragState && e.pointerId === trackDragState.pointerId) {
        finishTrackDrag();
    }
});

trackListEl.addEventListener('pointercancel', (e) => {
    if (trackDragState && e.pointerId === trackDragState.pointerId) {
        finishTrackDrag();
    }
});

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
        syncAmbientRuntime();
    }, 370);
}

function closeFullPlayer() {
    if (!isFullPlayerOpen) return;
    isFullPlayerOpen = false;
    syncAmbientRuntime();
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
        if (isTrackActionsOpen) {
            closeTrackActions();
        } else if (isTrackPlaylistsModalOpen) {
            closeTrackPlaylistsModal();
        } else if (isAddTracksModalOpen) {
            closeAddTracksModal();
        } else if (isPlModalOpen) {
            closePlaylistModal();
        } else if (isPlActionsOpen) {
            closePlaylistActions();
        } else if (isStatsOpen) {
            closeStats();
        } else if (isSettingsOpen) {
            closeSettings();
        } else if (isFullPlayerOpen) {
            closeFullPlayer();
        }
    });
} catch (e) {}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (isTrackActionsOpen) closeTrackActions();
        else if (isTrackPlaylistsModalOpen) closeTrackPlaylistsModal();
        else if (isAddTracksModalOpen) closeAddTracksModal();
        else if (isPlModalOpen) closePlaylistModal();
        else if (isPlActionsOpen) closePlaylistActions();
        else if (isStatsOpen) closeStats();
        else if (isSettingsOpen) closeSettings();
        else if (isFullPlayerOpen) closeFullPlayer();
    }
});

// ===== Listening Stats Tracking & Wrapped Card =====
function pauseListenSession() {
    if (listenSession.lastResumeAt !== null) {
        const delta = (performance.now() - listenSession.lastResumeAt) / 1000;
        if (delta > 0 && delta < 3600) {
            listenSession.accumSec += delta;
        }
        listenSession.lastResumeAt = null;
    }
}

function resumeListenSession() {
    if (!currentFileId) return;
    if (listenSession.fileId !== currentFileId) {
        listenSession = {
            fileId: currentFileId,
            accumSec: 0,
            lastResumeAt: performance.now(),
            duration: Number(audio.duration) || 0,
        };
    } else if (listenSession.lastResumeAt === null) {
        listenSession.lastResumeAt = performance.now();
        if (audio.duration) listenSession.duration = audio.duration;
    }
}

function flushListenSession(keepalive = false) {
    pauseListenSession();
    const { fileId, accumSec, duration } = listenSession;
    listenSession = { fileId: null, accumSec: 0, lastResumeAt: null, duration: 0 };
    if (!fileId || !initData) return;

    const minThreshold = duration > 0 && duration < 35 ? Math.max(5, duration * 0.4) : 15;
    if (accumSec < minThreshold) return;

    const track = allTracks.find(t => t.file_id === fileId);
    const payload = JSON.stringify({
        file_id: fileId,
        listened_sec: Math.round(accumSec),
        title: track ? (track.title || track.name || '') : '',
        performer: track ? (track.performer || '') : '',
    });

    fetch('/api/stats/play', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: payload,
        keepalive,
    }).catch(() => {});
}

function formatListeningDuration(totalSec) {
    const mins = Math.floor(totalSec / 60);
    if (mins < 1) return totalSec > 0 ? '< 1 мин' : '0 мин';
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours === 0) return `${mins} мин`;
    return remMins > 0 ? `${hours} ч ${remMins} мин` : `${hours} ч`;
}

function renderStatsContent(data) {
    if (!data || data.total_plays === 0) {
        statsBody.innerHTML = `
            <div class="stats-empty">
                Послушайте пару треков (от 15 секунд),<br>и здесь появится ваша персональная статистика ✨
            </div>
        `;
        return;
    }

    const periodLabels = {
        all: 'За всё время',
        '30d': 'За последние 30 дней',
        '7d': 'За последние 7 дней',
    };

    const medals = ['🥇', '🥈', '🥉'];
    const maxArtistPlays = data.top_artists.length > 0 ? Math.max(1, data.top_artists[0].plays) : 1;

    const artistsHtml = data.top_artists.length > 0
        ? `
            <div class="stats-card">
                <div class="stats-card-title">🏆 Любимые исполнители</div>
                <div class="stats-artist-list">
                    ${data.top_artists.map((a, i) => {
                        const pct = Math.max(12, Math.round((a.plays / maxArtistPlays) * 100));
                        return `
                            <div class="stats-artist-row">
                                <div class="stats-artist-head">
                                    <span class="stats-artist-name">${medals[i] || '•'} ${escapeHtml(a.performer)}</span>
                                    <span class="stats-artist-count">${a.plays} просл.</span>
                                </div>
                                <div class="stats-bar-track">
                                    <div class="stats-bar-fill" style="width:${pct}%"></div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `
        : '';

    const tracksHtml = data.top_tracks.length > 0
        ? `
            <div class="stats-card">
                <div class="stats-card-title">🔥 Топ треков</div>
                <div class="stats-track-list">
                    ${data.top_tracks.map((t, i) => `
                        <div class="stats-track-row ${t.in_library ? '' : 'unavailable'}" data-stats-fid="${escapeHtml(t.file_id)}" data-in-lib="${t.in_library ? '1' : '0'}">
                            <span class="stats-track-rank">${i + 1}</span>
                            <div class="stats-track-cover">
                                ${t.cover_url
                                    ? `<img src="${t.cover_url}" alt="" loading="lazy" onerror="this.style.display='none'; this.parentElement.textContent='🎵';">`
                                    : '🎵'}
                            </div>
                            <div class="stats-track-info">
                                <div class="stats-track-title">${escapeHtml(t.title)}</div>
                                <div class="stats-track-artist">${escapeHtml(t.performer)}</div>
                            </div>
                            <span class="stats-track-badge">×${t.plays}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `
        : '';

    statsBody.innerHTML = `
        <div class="stats-hero">
            <div class="stats-hero-label">${periodLabels[data.period] || periodLabels.all}</div>
            <div class="stats-hero-value">${formatListeningDuration(data.total_seconds)}</div>
            <div class="stats-hero-pills">
                <span class="stats-pill">🎧 ${data.total_plays} прослушиваний</span>
                <span class="stats-pill">🎵 ${data.unique_tracks} уникальных</span>
            </div>
        </div>
        ${artistsHtml}
        ${tracksHtml}
    `;

    statsBody.querySelectorAll('.stats-track-row[data-in-lib="1"]').forEach((row) => {
        row.addEventListener('click', () => {
            const fid = row.dataset.statsFid;
            if (!fid) return;
            haptic('light');
            closeStats();
            playTrackById(fid, true);
            if (userSettings.autoOpenPlayer) openFullPlayer();
        });
    });
}

async function loadAndRenderStats(period = statsPeriod) {
    statsPeriod = period;
    statsPeriodSegment.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
    statsBody.innerHTML = `<div class="stats-empty">Загрузка статистики...</div>`;
    try {
        const res = await fetch(`/api/stats?period=${encodeURIComponent(period)}`, {
            headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (period === statsPeriod) {
            renderStatsContent(data);
        }
    } catch (e) {
        statsBody.innerHTML = `<div class="stats-empty">Не удалось загрузить статистику</div>`;
    }
}

function openStats() {
    if (isStatsOpen) return;
    isStatsOpen = true;
    document.body.classList.add('settings-open');
    statsBackdrop.classList.add('open');
    statsBackdrop.setAttribute('aria-hidden', 'false');
    haptic('light');
    try { tg.BackButton?.show(); } catch (e) {}
    loadAndRenderStats(statsPeriod);
}

function closeStats() {
    if (!isStatsOpen) return;
    isStatsOpen = false;
    statsBackdrop.classList.remove('open');
    statsBackdrop.setAttribute('aria-hidden', 'true');
    if (!isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen && !isTrackActionsOpen) {
        document.body.classList.remove('settings-open');
    }
    if (!isFullPlayerOpen && !isSettingsOpen && !isPlModalOpen && !isAddTracksModalOpen && !isPlActionsOpen && !isTrackPlaylistsModalOpen && !isTrackActionsOpen) {
        try { tg.BackButton?.hide(); } catch (e) {}
    }
}

statsBtn.addEventListener('click', openStats);
statsCloseBtn.addEventListener('click', closeStats);
statsBackdrop.addEventListener('click', (e) => {
    if (e.target === statsBackdrop) closeStats();
});
statsPeriodSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    haptic('light');
    loadAndRenderStats(btn.dataset.period || 'all');
});

function hideLayerInstantly(el) {
    el.style.transition = 'none';
    el.classList.remove('visible');
    void el.offsetWidth;
    el.style.transition = '';
}

// ===== Cover Palette Extraction, Bokeh Canvas & Web Audio Beat Analyser =====
const DEFAULT_AMBIENT_PALETTE = [
    [29, 185, 84],
    [37, 99, 235],
    [168, 85, 247],
    [236, 72, 153],
];
const coverPaletteCache = new Map();
let currentAmbientPalette = DEFAULT_AMBIENT_PALETTE.map(c => [...c]);

function boostColorVividness(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const avg = (r + g + b) / 3;
    const sat = max === 0 ? 0 : (max - min) / max;
    const boost = sat < 0.35 ? 1.45 : 1.18;
    let nr = Math.min(255, Math.max(0, Math.round(avg + (r - avg) * boost)));
    let ng = Math.min(255, Math.max(0, Math.round(avg + (g - avg) * boost)));
    let nb = Math.min(255, Math.max(0, Math.round(avg + (b - avg) * boost)));
    // Держим яркость в комфортном диапазоне: не слишком темно и без выжигания в белый
    const lum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
    if (lum < 75 && lum > 1) {
        const k = 90 / lum;
        nr = Math.min(255, Math.round(nr * k));
        ng = Math.min(255, Math.round(ng * k));
        nb = Math.min(255, Math.round(nb * k));
    } else if (lum > 185) {
        const k = 175 / lum;
        nr = Math.round(nr * k);
        ng = Math.round(ng * k);
        nb = Math.round(nb * k);
    }
    return [nr, ng, nb];
}

const fpBgEl = fullPlayer.querySelector('.fp-bg');
const fpArtHaloEl = fullPlayer.querySelector('.fp-art-halo');

function writeAmbientPaletteVars(palette) {
    for (let i = 0; i < 4; i++) {
        const [r, g, b] = palette[i] || DEFAULT_AMBIENT_PALETTE[i];
        const val = `rgb(${r}, ${g}, ${b})`;
        if (fpBgEl) fpBgEl.style.setProperty(`--fp-c${i + 1}`, val);
        if (fpArtHaloEl) fpArtHaloEl.style.setProperty(`--fp-c${i + 1}`, val);
    }
}

function applyAmbientPalette(targetPalette, instant = false) {
    if (paletteMorphRafId !== null) {
        cancelAnimationFrame(paletteMorphRafId);
        paletteMorphRafId = null;
    }

    const normalizedTarget = Array.from({ length: 4 }, (_, i) => [
        ...(targetPalette[i] || DEFAULT_AMBIENT_PALETTE[i])
    ]);

    // CSS-переменные обновляем ОДИН раз за трек, чтобы мобильный GPU не перерисовывал
    // градиентные текстуры по 20–40 раз за время свайпа (это и вызывало глитчи/разрывы)
    writeAmbientPaletteVars(normalizedTarget);

    // Для Canvas «Боке» можно безопасно и плавно морфить цвета (без перерисовки CSS-слоёв)
    if (instant || userSettings.reducedMotion || !isFullPlayerOpen || userSettings.ambientStyle !== 'bokeh') {
        currentAmbientPalette = normalizedTarget;
        return;
    }

    const startPalette = currentAmbientPalette.map(c => [...c]);
    const durationMs = 680;
    const startTime = performance.now();

    const step = (now) => {
        const t = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        currentAmbientPalette = Array.from({ length: 4 }, (_, i) => [
            Math.round(startPalette[i][0] + (normalizedTarget[i][0] - startPalette[i][0]) * eased),
            Math.round(startPalette[i][1] + (normalizedTarget[i][1] - startPalette[i][1]) * eased),
            Math.round(startPalette[i][2] + (normalizedTarget[i][2] - startPalette[i][2]) * eased),
        ]);

        if (t < 1) {
            paletteMorphRafId = requestAnimationFrame(step);
        } else {
            paletteMorphRafId = null;
            currentAmbientPalette = normalizedTarget;
        }
    };

    paletteMorphRafId = requestAnimationFrame(step);
}

function extractCoverPalette(img, coverUrl) {
    if (coverPaletteCache.has(coverUrl)) {
        applyAmbientPalette(coverPaletteCache.get(coverUrl));
        return;
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;

        const candidates = [];
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 180) continue;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum < 22 || lum > 242) continue;
            const sat = max === 0 ? 0 : (max - min) / max;
            const score = sat * 2.2 + (1 - Math.abs(lum - 135) / 135);
            candidates.push({ r, g, b, score });
        }

        candidates.sort((a, b) => b.score - a.score);
        const picked = [];
        for (const c of candidates) {
            const distinct = picked.every(p => {
                const dr = p[0] - c.r, dg = p[1] - c.g, db = p[2] - c.b;
                return (dr * dr + dg * dg + db * db) > 3600;
            });
            if (distinct) {
                picked.push(boostColorVividness(c.r, c.g, c.b));
                if (picked.length === 4) break;
            }
        }

        while (picked.length < 4) {
            if (picked.length > 0) {
                const base = picked[picked.length - 1];
                picked.push([base[2], base[0], base[1]]);
            } else {
                picked.push([...DEFAULT_AMBIENT_PALETTE[picked.length]]);
            }
        }

        coverPaletteCache.set(coverUrl, picked);
        if (coverPaletteCache.size > 60) {
            const firstKey = coverPaletteCache.keys().next().value;
            coverPaletteCache.delete(firstKey);
        }
        applyAmbientPalette(picked);
    } catch (e) {
        applyAmbientPalette(DEFAULT_AMBIENT_PALETTE);
    }
}

const BOKEH_COUNT = 26;

function initBokehParticles(w, h) {
    bokehParticles = Array.from({ length: BOKEH_COUNT }, (_, idx) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 16 + Math.random() * 44,
        vy: -(0.22 + Math.random() * 0.55),
        vx: (Math.random() - 0.5) * 0.3,
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.008 + Math.random() * 0.018,
        alpha: 0.16 + Math.random() * 0.28,
        colorIdx: idx % 4,
    }));
}

function resizeBokehCanvas() {
    if (!fpBokehCanvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = fpBokehCanvas.clientWidth || window.innerWidth;
    const h = fpBokehCanvas.clientHeight || window.innerHeight;
    if (fpBokehCanvas.width !== Math.round(w * dpr) || fpBokehCanvas.height !== Math.round(h * dpr)) {
        fpBokehCanvas.width = Math.round(w * dpr);
        fpBokehCanvas.height = Math.round(h * dpr);
        initBokehParticles(w, h);
    }
}

window.addEventListener('resize', () => {
    if (isFullPlayerOpen && userSettings.ambientStyle === 'bokeh') {
        resizeBokehCanvas();
    }
});

function stopAmbientRuntime() {
    if (ambientRafId !== null) {
        cancelAnimationFrame(ambientRafId);
        ambientRafId = null;
    }
    if (fpBokehCanvas && (userSettings.ambientStyle !== 'bokeh' || userSettings.ambientMotion === 'off' || !userSettings.ambientBg)) {
        const ctx = fpBokehCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, fpBokehCanvas.width, fpBokehCanvas.height);
    }
}

function syncAmbientRuntime() {
    const style = userSettings.ambientStyle || 'mesh';
    const motion = userSettings.ambientMotion || 'medium';
    const bgEnabled = Boolean(userSettings.ambientBg) && !userSettings.reducedMotion;
    const isPlayingOrSwitching = !audio.paused || isSwitchingTrack;
    const needsBokeh = isFullPlayerOpen && isPlayingOrSwitching && !document.hidden && bgEnabled && style === 'bokeh' && motion !== 'off';

    if (!needsBokeh) {
        stopAmbientRuntime();
        return;
    }

    resizeBokehCanvas();

    if (ambientRafId !== null) return;
    lastAmbientFrameTime = performance.now();

    const step = (now) => {
        const dt = Math.min(48, now - lastAmbientFrameTime) / 16.67;
        lastAmbientFrameTime = now;

        const curStyle = userSettings.ambientStyle || 'mesh';
        const curMotion = userSettings.ambientMotion || 'medium';
        const curBgOn = Boolean(userSettings.ambientBg) && !userSettings.reducedMotion;
        const activePlay = !audio.paused || isSwitchingTrack;
        const doBokeh = isFullPlayerOpen && activePlay && !document.hidden && curBgOn && curStyle === 'bokeh' && curMotion !== 'off';

        if (!doBokeh) {
            stopAmbientRuntime();
            return;
        }

        if (fpBokehCanvas) {
            const ctx = fpBokehCanvas.getContext('2d');
            if (ctx) {
                const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
                const w = fpBokehCanvas.width / dpr;
                const h = fpBokehCanvas.height / dpr;
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, w, h);

                const mul = curMotion === 'soft' ? 0.55 : (curMotion === 'vivid' ? 1.65 : 1);

                for (const p of bokehParticles) {
                    p.y += p.vy * mul * dt;
                    p.phase += p.twinkleSpeed * mul * dt;
                    p.x += (p.vx + Math.sin(p.phase) * 0.28) * mul * dt;

                    if (p.y < -p.r * 1.5) {
                        p.y = h + p.r * 1.2;
                        p.x = Math.random() * w;
                    }
                    if (p.x < -p.r * 1.5) p.x = w + p.r;
                    if (p.x > w + p.r * 1.5) p.x = -p.r;

                    const [r, g, b] = currentAmbientPalette[p.colorIdx] || DEFAULT_AMBIENT_PALETTE[0];
                    const twinkle = 0.65 + 0.35 * Math.sin(p.phase * 1.6);
                    const a = Math.min(0.75, p.alpha * twinkle);

                    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
                    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`);
                    grad.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${(a * 0.42).toFixed(3)})`);
                    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        ambientRafId = requestAnimationFrame(step);
    };

    ambientRafId = requestAnimationFrame(step);
}

document.addEventListener('visibilitychange', syncAmbientRuntime);

const preloadedCovers = new Map();

function preloadNeighborCovers() {
    const order = getActiveOrderIds();
    if (order.length < 2 || !currentFileId) return;
    const idx = order.indexOf(currentFileId);
    if (idx === -1) return;

    const offsets = [1, 2, -1, -2];
    for (const off of offsets) {
        const neighborId = order[(idx + off + order.length) % order.length];
        const t = allTracks.find(item => item.file_id === neighborId);
        if (t && t.cover_url && !preloadedCovers.has(t.cover_url)) {
            const img = new Image();
            img.decoding = 'async';
            img.src = t.cover_url;
            if (typeof img.decode === 'function') {
                img.decode().catch(() => {});
            }
            preloadedCovers.set(t.cover_url, img);
            if (preloadedCovers.size > 40) {
                const firstKey = preloadedCovers.keys().next().value;
                preloadedCovers.delete(firstKey);
            }
        }
    }
}

function crossfadeFullPlayerCover(coverUrl, instantCover = false) {
    const seq = ++fpCoverSeq;
    const prevIdx = fpActiveLayer;
    const nextIdx = 1 - fpActiveLayer;

    const prevCover = fpCovers[prevIdx];
    const nextCover = fpCovers[nextIdx];
    const prevBg = fpBgImgs[prevIdx];
    const nextBg = fpBgImgs[nextIdx];
    const prevAlt = fpBgAlts[prevIdx];
    const nextAlt = fpBgAlts[nextIdx];

    prevCover.style.zIndex = '1';
    nextCover.style.zIndex = '2';
    prevBg.style.zIndex = '1';
    nextBg.style.zIndex = '2';
    prevAlt.style.zIndex = '1';
    nextAlt.style.zIndex = '2';

    hideLayerInstantly(nextCover);
    hideLayerInstantly(nextBg);
    hideLayerInstantly(nextAlt);

    let applied = false;
    let fallbackTimer = null;

    const applyLoadedCover = (imgEl) => {
        if (applied || seq !== fpCoverSeq) return;
        applied = true;
        if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }
        fpCoverFallback.style.display = 'none';
        nextCover.src = coverUrl;
        nextBg.src = coverUrl;
        nextAlt.src = coverUrl;
        extractCoverPalette(imgEl, coverUrl);

        if (instantCover) {
            nextCover.style.transition = 'none';
            nextCover.classList.add('visible');
            hideLayerInstantly(prevCover);
            requestAnimationFrame(() => {
                if (seq === fpCoverSeq) nextCover.style.transition = '';
            });
        }

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (seq !== fpCoverSeq) return;
                if (!instantCover) {
                    nextCover.classList.add('visible');
                }
                nextBg.classList.add('visible');
                nextAlt.classList.add('visible');
                fpActiveLayer = nextIdx;
                setTimeout(() => {
                    if (seq === fpCoverSeq && fpActiveLayer === nextIdx) {
                        if (!instantCover) hideLayerInstantly(prevCover);
                        hideLayerInstantly(prevBg);
                        hideLayerInstantly(prevAlt);
                    }
                }, 700);
            });
        });
    };

    const cachedImg = preloadedCovers.get(coverUrl);
    if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
        applyLoadedCover(cachedImg);
        return;
    }

    const preload = cachedImg || new Image();
    preload.decoding = 'async';
    preload.onload = () => applyLoadedCover(preload);
    preload.onerror = () => {
        if (seq !== fpCoverSeq) return;
        if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }
        hideLayerInstantly(prevCover);
        hideLayerInstantly(nextCover);
        hideLayerInstantly(prevBg);
        hideLayerInstantly(nextBg);
        hideLayerInstantly(prevAlt);
        hideLayerInstantly(nextAlt);
        applyAmbientPalette(DEFAULT_AMBIENT_PALETTE);
        fpCoverFallback.style.display = 'block';
    };
    if (!cachedImg) {
        preload.src = coverUrl;
        preloadedCovers.set(coverUrl, preload);
    }

    if (preload.complete && preload.naturalWidth > 0) {
        applyLoadedCover(preload);
    } else if (instantCover) {
        // Ждём 90 мс перед показом заглушки 🎵, чтобы кэшированные обложки никогда не мигали
        hideLayerInstantly(prevCover);
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            if (!applied && seq === fpCoverSeq) {
                fpCoverFallback.style.display = 'block';
            }
        }, 90);
    }
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
let artSwipeTimer = null;

function animateArtSwipeChange(direction) {
    // direction: -1 (swipe left -> next track), +1 (swipe right -> prev track)
    if (artSwipeTimer) {
        clearTimeout(artSwipeTimer);
        artSwipeTimer = null;
    }
    const baseScale = audio.paused ? 0.92 : 1;
    fpArtBox.classList.remove('swiping');
    fpArtBox.classList.add('swipe-out');
    fpArtBox.style.transform = `translate3d(${direction * 110}%, 0, 0) rotate(${direction * 5}deg) scale(${baseScale * 0.95})`;
    fpArtBox.style.opacity = '0';

    artSwipeTimer = setTimeout(() => {
        artSwipeTimer = null;
        nextCoverInstant = true;
        if (direction < 0) {
            playNextTrack();
        } else {
            playPrevTrack();
        }
        nextCoverInstant = false;

        fpArtBox.classList.remove('swipe-out');
        fpArtBox.classList.add('swiping');
        fpArtBox.style.transform = `translate3d(${-direction * 54}px, 0, 0) scale(0.94)`;
        fpArtBox.style.opacity = '0';

        // Двойной rAF вместо синхронного offsetWidth — чистый 60fps вход без forced reflow
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                fpArtBox.classList.remove('swiping');
                fpArtBox.style.transform = '';
                fpArtBox.style.opacity = '';
            });
        });
    }, 150);
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

    if (Math.abs(distance) < 6) return;

    if (userSettings.reducedMotion) {
        window.scrollTo(0, clampedTarget);
        return;
    }

    // Ультраплавная длительность (620–1150 мс) + мягкая S-кривая easeInOutQuint
    const duration = Math.min(1150, Math.max(620, Math.abs(distance) * 0.65));
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const eased = progress < 0.5
            ? 16 * Math.pow(progress, 5)
            : 1 - Math.pow(-2 * progress + 2, 5) / 2;
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
    const nextWrap = Array.from(trackListEl.children).find(
        (el) => el.dataset && el.dataset.fileId === currentFileId
    );
    const nextItem = nextWrap ? (nextWrap.querySelector('.track-item') || nextWrap) : null;
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

        const viewTop = headerEl ? Math.max(0, headerEl.getBoundingClientRect().bottom) : 0;
        const playerVisible = playerBar.classList.contains('visible');
        let viewBottom = window.innerHeight;
        if (playerVisible) {
            const pRect = playerBar.getBoundingClientRect();
            const pH = playerBar.offsetHeight || 125;
            viewBottom = Math.min(window.innerHeight - pH, pRect.top > 0 ? pRect.top : window.innerHeight - pH);
        }
        const visibleHeight = Math.max(120, viewBottom - viewTop);

        const rect = activeItem.getBoundingClientRect();
        // Комфортная «безопасная зона»: трек должен быть виден ЦЕЛИКОМ с запасом от шапки и мини-плеера
        const edgePad = Math.max(20, Math.min(64, visibleHeight * 0.14));
        const safeTop = viewTop + edgePad;
        const safeBottom = viewBottom - edgePad;

        if (rect.top >= safeTop && rect.bottom <= safeBottom) {
            return;
        }

        const currentScrollY = window.scrollY || document.documentElement.scrollTop || 0;
        const itemAbsTop = rect.top + currentScrollY;

        let targetTop;
        if (rect.top < safeTop && rect.bottom > viewTop - rect.height * 2) {
            // Сверху обрезан или прижат к шапке — опускаем с комфортным отступом
            targetTop = itemAbsTop - viewTop - Math.min(84, visibleHeight * 0.22);
        } else if (rect.bottom > safeBottom && rect.top < viewBottom + rect.height * 2) {
            // Снизу обрезан мини-плеером или краем экрана — поднимаем целиком над плеером с запасом
            targetTop = itemAbsTop - viewTop - (visibleHeight - rect.height - Math.min(84, visibleHeight * 0.22));
        } else {
            // Далеко за экраном (например, в Shuffle) — плавно центрируем
            targetTop = itemAbsTop - viewTop - (visibleHeight - rect.height) / 2;
        }

        smoothScrollToY(Math.max(0, targetTop));
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

let audioLoadTimer = null;
let audioSwitchSeq = 0;
let lastTrackSwitchAt = 0;
let prefetchTimer = null;
let prefetchController = null;
const prefetchedStreamUrls = new Set();

function cancelNextTrackPrefetch() {
    if (prefetchTimer) {
        clearTimeout(prefetchTimer);
        prefetchTimer = null;
    }
    if (prefetchController) {
        try { prefetchController.abort(); } catch (e) {}
        prefetchController = null;
    }
}

function scheduleNextTrackPrefetch() {
    cancelNextTrackPrefetch();
    const order = getActiveOrderIds();
    if (order.length < 2 || !currentFileId) return;
    const idx = order.indexOf(currentFileId);
    if (idx === -1) return;
    const nextId = order[(idx + 1) % order.length];
    const nextTrack = allTracks.find(t => t.file_id === nextId);
    if (!nextTrack || !nextTrack.stream_url || prefetchedStreamUrls.has(nextTrack.stream_url)) return;

    const targetUrl = nextTrack.stream_url;
    prefetchTimer = setTimeout(() => {
        prefetchTimer = null;
        if (audio.paused || document.hidden) return;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        prefetchController = controller;
        // Прогреваем file_path на сервере и первые 192 КБ аудиопотока в HTTP-кэше браузера
        fetch(targetUrl, {
            headers: { Range: 'bytes=0-196607' },
            signal: controller ? controller.signal : undefined,
        }).then((res) => {
            if (res.ok) {
                prefetchedStreamUrls.add(targetUrl);
                if (prefetchedStreamUrls.size > 50) {
                    const first = prefetchedStreamUrls.values().next().value;
                    prefetchedStreamUrls.delete(first);
                }
                return res.arrayBuffer();
            }
        }).catch(() => {}).finally(() => {
            if (prefetchController === controller) {
                prefetchController = null;
            }
        });
    }, 1500);
}

function playTrackById(fileId, shouldScroll = false) {
    const track = filteredTracks.find(t => t.file_id === fileId) || allTracks.find(t => t.file_id === fileId);
    if (!track) return;
    if (listenSession.fileId && listenSession.fileId !== track.file_id) {
        flushListenSession(false);
    }
    currentFileId = track.file_id;
    const switchSeq = ++audioSwitchSeq;
    const now = performance.now();
    const isRapidSkip = (now - lastTrackSwitchAt) < 320;
    lastTrackSwitchAt = now;

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
    preloadNeighborCovers();

    pendingResumeTime = null;
    resetProgressSmoothly();

    // Сразу отменяем фоновый prefetch и глушим предыдущий поток
    cancelNextTrackPrefetch();
    if (audioLoadTimer) {
        clearTimeout(audioLoadTimer);
        audioLoadTimer = null;
    }
    cancelAudioFade();
    isSwitchingTrack = true;
    try { audio.pause(); } catch (e) {}
    try { audio.volume = 0; } catch (e) {}

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

    const startAudioStream = () => {
        if (switchSeq !== audioSwitchSeq) return;
        audio.src = track.stream_url;
        applyPlaybackRate();
        saveLastTrackState(true);
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
            playPromise.then(() => {
                if (switchSeq !== audioSwitchSeq) return;
                fadeAudioVolume(0, 1, userSettings.audioFade ? 120 : 35);
                scheduleNextTrackPrefetch();
            }).catch((err) => {
                if (switchSeq !== audioSwitchSeq) return;
                if (err && err.name === 'AbortError') return;
                isSwitchingTrack = false;
                try { audio.volume = 1; } catch (e) {}
                updatePlayButtons(false);
            });
        } else {
            fadeAudioVolume(0, 1, 35);
            scheduleNextTrackPrefetch();
        }
    };

    // Одиночное переключение стартует мгновенно (0 мс); дебаунс 140 мс включается только при быстром пролистывании
    if (isRapidSkip) {
        audioLoadTimer = setTimeout(() => {
            audioLoadTimer = null;
            startAudioStream();
        }, 140);
    } else {
        startAudioStream();
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
    if (audioLoadTimer) {
        clearTimeout(audioLoadTimer);
        audioLoadTimer = null;
        audioSwitchSeq++;
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
    fullPlayer.classList.toggle('is-playing', playing);
    fpPlayPauseBtn.classList.toggle('is-playing', playing);
    syncAmbientRuntime();
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
    resumeListenSession();
});
audio.addEventListener('play', () => {
    updatePlayButtons(true);
    startProgressLoop();
});
audio.addEventListener('waiting', () => {
    pauseListenSession();
});
audio.addEventListener('pause', () => {
    pauseListenSession();
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
    flushListenSession(false);
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
        clearSmoothProgressReset();
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
    flushListenSession(true);
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

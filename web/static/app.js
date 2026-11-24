const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

function applyTelegramTheme() {
    const scheme = tg.colorScheme || 'dark';
    document.documentElement.dataset.theme = scheme;
    const bgColor = tg.themeParams?.bg_color || '#0f0f13';
    try {
        if (isFullPlayerOpen) {
            tg.setHeaderColor?.('#0f0f13');
            tg.setBackgroundColor?.('#0f0f13');
        } else {
            tg.setHeaderColor?.(bgColor);
            tg.setBackgroundColor?.(bgColor);
        }
    } catch (e) {}
}

const initData = tg.initData || '';
const authHeaders = () => ({ 'X-Telegram-Init-Data': initData });

let allTracks = [];
let filteredTracks = [];
let shuffledIds = [];
let currentFileId = null;
let isRepeat = false;
let isShuffle = false;
let isSeeking = false;
let isFullPlayerOpen = false;
let isSwitchingTrack = false;

function haptic(style = 'light') {
    try {
        tg.HapticFeedback?.impactOccurred(style);
    } catch (e) {}
}

function rebuildShuffleQueue() {
    const ids = filteredTracks.map(t => t.file_id);
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
    if (isShuffle) {
        const validSet = new Set(filteredTracks.map(t => t.file_id));
        const cleaned = shuffledIds.filter(id => validSet.has(id));
        if (cleaned.length !== filteredTracks.length) {
            rebuildShuffleQueue();
            return shuffledIds;
        }
        return cleaned;
    }
    return filteredTracks.map(t => t.file_id);
}

function getCurrentIndex() {
    if (!currentFileId) return -1;
    return getActiveOrderIds().indexOf(currentFileId);
}

const audio = document.getElementById('audioElement');
const headerEl = document.getElementById('headerEl');
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

async function loadPlaylist() {
    if (!initData) {
        trackListEl.innerHTML = `<div class="empty-state">Откройте плейлист через кнопку в Telegram-боте.</div>`;
        return;
    }
    renderSkeleton(6);
    try {
        const res = await fetch('/api/playlist', { headers: authHeaders() });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        allTracks = data.tracks || [];
        filteredTracks = [...allTracks];
        renderTracks({ animateEntrance: true });
    } catch (err) {
        trackListEl.innerHTML = `<div class="empty-state">Ошибка загрузки плейлиста</div>`;
    }
}

function renderTracks(options = {}) {
    const { animateEntrance = false, highlightFileId = null } = options;
    trackCountEl.textContent = `${allTracks.length} треков`;

    if (filteredTracks.length === 0) {
        trackListEl.innerHTML = `<div class="empty-state">Плейлист пуст 🎧</div>`;
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
            playTrackById(track.file_id);
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

function openFullPlayer() {
    if (!currentFileId) return;
    isFullPlayerOpen = true;
    fullPlayer.style.transform = '';
    fullPlayer.classList.add('open');
    fullPlayer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('fp-open');
    applyTelegramTheme();
    refreshAllMarquees();
    haptic('light');
    try {
        tg.BackButton?.show();
    } catch (e) {}
}

function closeFullPlayer() {
    if (!isFullPlayerOpen) return;
    isFullPlayerOpen = false;
    fullPlayer.style.transform = '';
    fullPlayer.classList.remove('open', 'dragging');
    fullPlayer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('fp-open');
    applyTelegramTheme();
    try {
        tg.BackButton?.hide();
    } catch (e) {}
    scrollToActiveTrack();
}

applyTelegramTheme();
try {
    tg.onEvent?.('themeChanged', applyTelegramTheme);
} catch (e) {}

try {
    tg.BackButton?.onClick(() => {
        if (isFullPlayerOpen) closeFullPlayer();
    });
} catch (e) {}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullPlayerOpen) {
        closeFullPlayer();
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

function scrollToActiveTrack() {
    if (isFullPlayerOpen) return;
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
        window.scrollTo({ top: targetTop, behavior: 'smooth' });
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
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

    seekSlider.value = 0;
    fpSeekSlider.value = 0;
    setProgressVisual(0, 0);

    // Не даём внутреннему событию pause при смене audio.src сжимать обложку во время буферизации
    isSwitchingTrack = true;
    audio.src = track.stream_url;
    audio.play().catch(() => {
        isSwitchingTrack = false;
        updatePlayButtons(false);
    });
    updatePlayButtons(true);
    renderTracks();
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
        audio.play();
    } else {
        audio.pause();
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
});
audio.addEventListener('loadedmetadata', () => {
    setProgressVisual(audio.currentTime || 0, audio.duration || 0);
});
audio.addEventListener('seeked', () => {
    if (!isSeeking) {
        setProgressVisual(audio.currentTime || 0, audio.duration || 0);
    }
});

audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    setProgressVisual(audio.currentTime || 0, audio.duration || 0);
});

audio.addEventListener('ended', () => {
    stopProgressLoop();
    if (isRepeat) {
        audio.currentTime = 0;
        setProgressVisual(0, audio.duration || 0);
        audio.play();
    } else if (filteredTracks.length > 0) {
        playNextTrack();
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

function applySearchFilter(options = {}) {
    const q = searchInput.value.trim().toLowerCase();
    filteredTracks = allTracks.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.performer && t.performer.toLowerCase().includes(q)) ||
        (t.name && t.name.toLowerCase().includes(q))
    );
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

function commitServerDelete(fileId, keepalive = false) {
    fetch(`/api/playlist?file_id=${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: authHeaders(),
        keepalive
    }).catch(() => {});
}

function flushPendingDelete(keepalive = false) {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    const fileId = pendingDelete.track.file_id;
    pendingDelete = null;
    undoToast.classList.remove('visible');
    commitServerDelete(fileId, keepalive);
}

function showUndoToast(track) {
    undoToastText.textContent = `Удалён: ${track.title || track.name}`;
    undoToast.classList.add('visible');
}

undoDeleteBtn.addEventListener('click', () => {
    if (!pendingDelete) return;
    haptic('light');
    clearTimeout(pendingDelete.timer);
    const { track, allIndex } = pendingDelete;
    pendingDelete = null;
    undoToast.classList.remove('visible');

    const insertAt = Math.min(allIndex, allTracks.length);
    allTracks.splice(insertAt, 0, track);
    if (isShuffle) rebuildShuffleQueue();
    applySearchFilter({ highlightFileId: track.file_id });
});

window.addEventListener('pagehide', () => flushPendingDelete(true));

function finalizeDeleteUI(fileId) {
    const allIndex = allTracks.findIndex(t => t.file_id === fileId);
    if (allIndex === -1) return;
    const track = allTracks[allIndex];

    const wasCurrent = currentFileId === fileId;
    allTracks.splice(allIndex, 1);
    filteredTracks = filteredTracks.filter(t => t.file_id !== fileId);
    shuffledIds = shuffledIds.filter(id => id !== fileId);

    if (wasCurrent) {
        if (filteredTracks.length > 0) {
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
    renderTracks();

    showUndoToast(track);
    const timer = setTimeout(() => {
        if (pendingDelete && pendingDelete.track.file_id === fileId) {
            pendingDelete = null;
            undoToast.classList.remove('visible');
            commitServerDelete(fileId, false);
        }
    }, 5000);

    pendingDelete = { track, allIndex, timer };
}

function deleteTrack(fileId) {
    // Если есть предыдущее отложенное удаление — сразу подтверждаем его на сервере
    flushPendingDelete(false);

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
        setTimeout(() => finalizeDeleteUI(fileId), 220);
    } else {
        finalizeDeleteUI(fileId);
    }
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[s]));
}

loadPlaylist();

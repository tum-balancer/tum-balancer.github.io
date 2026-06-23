document.addEventListener('DOMContentLoaded', () => {
    const fetchBtn = document.getElementById('fetch-lectures-btn');
    const calculateBtn = document.getElementById('calculate-availability-btn');
    const resultsSection = document.getElementById('results-section');
    const lectureSection = document.getElementById('lecture-selection-section');
    const setupCard = document.getElementById('setup-card');
    const availabilityContainer = document.getElementById('availability-container');
    const lectureList = document.getElementById('lecture-list');
    const copyBtn = document.getElementById('copy-btn');
    const whatsappBtn = document.getElementById('whatsapp-btn');
    const loader = document.getElementById('loader');
    const monthTabs = document.getElementById('month-tabs');
    

    let allEvents = [];
    let privateEvents = [];
    let lastAvailabilitySlots = []; // For ICS export
    let config = {};
    let phpProxySupported = null; // null = untested, true = supported, false = unsupported

    const STORAGE_KEY = 'tum_balancer_settings_v1';
    const TUM_API_BASE = 'https://campus.tum.de/tumonline/';
    const EXAM_KEYWORDS = ['prüfung', 'exam', 'klausur', 'midterm', 'test', 'endterm'];

    // --- Private Calendar UI ---
    const addCalBtn = document.getElementById('add-cal-btn');
    const privateCalList = document.getElementById('private-cal-list');

    /**
     * Fetch data via production proxies with direct-fetch fallback.
     * Strategy 0: Direct fetch (for CORS-enabled APIs like TUMonline)
     * Strategy 1: Local PHP Proxy (for MVG or local setups)
     * Strategy 2: AllOrigins fallback
     */
    async function smartFetch(url, isJson = false, timeout = 15000) {
        // Prepare signals for timeout
        const getSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) 
            ? AbortSignal.timeout(ms) 
            : null;

        // Rewrite relative MVG API routes to absolute URLs
        let targetUrl = url;
        if (url.startsWith('/departures')) {
            const station = new URLSearchParams(url.split('?')[1] || '').get('station') || 'de:09178:3239';
            targetUrl = `https://www.mvg.de/api/bgw-pt/v3/departures?globalId=${station}&limit=30&offsetInMinutes=0&transportTypes=BAHN,SBAHN,UBAHN,TRAM,BUS,REGIONAL_BUS,SCHIFF`;
        } else if (url.startsWith('/nearby')) {
            const params = new URLSearchParams(url.split('?')[1] || '');
            const lat = params.get('latitude') || '';
            const lng = params.get('longitude') || '';
            targetUrl = `https://www.mvg.de/api/bgw-pt/v3/locations/nearby?latitude=${lat}&longitude=${lng}`;
        } else if (url.startsWith('/trips')) {
            const params = new URLSearchParams(url.split('?')[1] || '');
            const origin = params.get('origin') || '';
            const dest = params.get('dest') || '';
            targetUrl = `https://www.mvg.de/api/bgw-pt/v3/trips?originId=${origin}&destId=${dest}`;
        }

        // Ensure we have an absolute URL for cross-origin strategies
        const isAbsolute = targetUrl.startsWith('http');
        const absoluteUrl = isAbsolute ? targetUrl : (window.location.origin === 'null' || !window.location.origin ? '' : window.location.origin) + targetUrl;

        // Strategy 0: Direct Fetch (Try this first for absolute URLs, as TUM supports CORS)
        if (isAbsolute) {
            try {
                const r = await fetch(targetUrl, { signal: getSignal(timeout) });
                if (r.ok) return isJson ? await r.json() : await r.text();
            } catch (e) {
                console.warn('Direct fetch failed (likely CORS or network), trying proxies...', e.message);
            }
        }

        // Strategy 1: PHP Proxy (primary for hosted site / relative URLs)
        if (phpProxySupported !== false) {
            try {
                // Convert back to relative if it was a local absolute URL to avoid proxying our own site
                const cleanUrl = absoluteUrl.replace(window.location.origin, '');
                const bustUrl = cleanUrl.includes('?') ? `${cleanUrl}&_t=${Date.now()}` : `${cleanUrl}?_t=${Date.now()}`;
                const phpProxy = `proxy.php?url=${encodeURIComponent(bustUrl)}`;
                
                const r = await fetch(phpProxy, { signal: getSignal(timeout) });
                if (r.ok) {
                    const text = await r.text();
                    if (text.trim().startsWith('<?php') || text.includes('<?php')) {
                        phpProxySupported = false;
                        throw new Error('PHP proxy is not executed by the server (raw source returned)');
                    }
                    phpProxySupported = true;
                    return isJson ? JSON.parse(text) : text;
                }
                
                console.warn(`PHP proxy returned HTTP ${r.status}, trying AllOrigins fallback...`);
            } catch (e) { 
                console.warn('PHP proxy failed:', e.message, 'trying AllOrigins...'); 
            }
        }

        // Strategy 2: corsproxy.io (Very fast public CORS proxy)
        try {
            const cp = `https://corsproxy.io/?url=${encodeURIComponent(absoluteUrl)}`;
            const r = await fetch(cp, { signal: getSignal(timeout) });
            if (r.ok) return isJson ? await r.json() : await r.text();
            console.warn(`corsproxy.io failed (HTTP ${r.status}), trying AllOrigins...`);
        } catch (e) {
            console.warn('corsproxy.io failed:', e.message, 'trying AllOrigins...');
        }

        // Strategy 3: AllOrigins (Secondary external fallback)
        if (!absoluteUrl.startsWith('http')) {
            throw new Error('Relative URL fetch failed on file:// protocol. Please run on a server.');
        }

        const ao = `https://api.allorigins.win/raw?url=${encodeURIComponent(absoluteUrl)}`;
        try {
            const r = await fetch(ao, { signal: getSignal(timeout + 5000) });
            if (!r.ok) throw new Error(`Proxy failed (HTTP ${r.status})`);
            return isJson ? await r.json() : await r.text();
        } catch (e) {
            if (e.name === 'TimeoutError' || e.name === 'AbortError') {
                throw new Error(`Request timed out after ${timeout + 5000}ms. The server might be slow.`);
            }
            throw e;
        }
    }

    function parseXml(text) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(text, "text/xml");
            const parserError = xmlDoc.getElementsByTagName("parsererror");
            if (parserError.length > 0) {
                console.warn("XML Parsing Error:", parserError[0].textContent);
                return null;
            }
            return xmlDoc;
        } catch (e) {
            console.error("XML Parser crashed:", e);
            return null;
        }
    }

    function createCalEntry(prefill = {}) {
        const entry = document.createElement('div');
        entry.className = 'private-cal-entry';
        entry.innerHTML = `
            <input type="url" class="private-cal-url" placeholder="Paste iCal URL (Google/Apple secret link)" value="${prefill.url || ''}">
            <input type="text" class="cal-label" placeholder="Label (e.g. Work)" style="width:110px;" value="${prefill.label || ''}">
            <label style="display:flex;gap:4px;align-items:center;font-size:0.75rem;white-space:nowrap;cursor:pointer;">
                <input type="checkbox" class="mask-names-check" ${prefill.mask ? 'checked' : ''}> Hide names
            </label>
            <button type="button" class="remove-cal-btn" title="Remove">✕</button>
        `;
        entry.querySelector('.remove-cal-btn').addEventListener('click', () => entry.remove());
        return entry;
    }
    addCalBtn.addEventListener('click', () => privateCalList.appendChild(createCalEntry()));

    // --- Settings persistence ---
    async function loadSettings() {
        try {
            // 1. Try loading from server first
            let saved = {};
            try {
                const response = await fetch('proxy.php?action=load_settings');
                if (response.ok) {
                    const text = await response.text();
                    if (text.trim().startsWith('<?php') || text.includes('<?php')) {
                        phpProxySupported = false;
                        throw new Error('PHP proxy is not executed by the server (raw source returned)');
                    }
                    phpProxySupported = true;
                    const serverData = JSON.parse(text);
                    if (serverData && serverData.icalUrl) {
                        saved = serverData;
                        console.log("Loaded settings from server");
                    }
                }
            } catch (e) {
                console.warn('Server settings load failed, falling back to local', e);
            }

            // 2. Fallback to localStorage if server empty or failed
            if (!saved.icalUrl) {
                saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            }

            if (saved.icalUrl) document.getElementById('ical-url').value = saved.icalUrl;
            
            if (saved.workStart) document.getElementById('work-start').value = saved.workStart;
            if (saved.workEnd) document.getElementById('work-end').value = saved.workEnd;
            if (saved.minSlot) document.getElementById('min-slot').value = saved.minSlot;
            if (saved.commuteBuffer !== undefined) document.getElementById('commute-buffer').value = saved.commuteBuffer;
            if (saved.range) document.getElementById('view-range').value = saved.range;
            if (saved.customHolidays) document.getElementById('custom-holidays').value = saved.customHolidays;
            if (saved.selectedDays) {
                document.querySelectorAll('.day-check input').forEach(i => {
                    i.checked = saved.selectedDays.includes(parseInt(i.value));
                });
            }
            ['bonus-hours', 'show-transport', 'show-lectures-cal', 'show-bonus-badge'].forEach(id => {
                if (saved[id] !== undefined) document.getElementById(id).checked = saved[id];
            });
            (saved.privateCals || []).forEach(c => privateCalList.appendChild(createCalEntry(c)));
            if (saved.transportBase) document.getElementById('transport-base').value = saved.transportBase;
            if (saved.transportDestination) document.getElementById('transport-destination').value = saved.transportDestination;
            
            syncTransportRow();
        } catch (e) { console.warn('Failed to load settings', e); }
    }

    function syncTransportRow() {
        const row = document.getElementById('transport-row');
        if (row) row.style.display = document.getElementById('show-transport').checked ? 'flex' : 'none';
    }
    document.getElementById('show-transport').addEventListener('change', syncTransportRow);

    // --- Location and Smart Transport ---
    const locationBtn = document.getElementById('use-location-btn');
    const locationStatus = document.getElementById('location-status');
    const transportBaseSelect = document.getElementById('transport-base');
    const transportDestSelect = document.getElementById('transport-destination');
    const commuteBufferInput = document.getElementById('commute-buffer');

    if (locationBtn) {
        locationBtn.addEventListener('click', async () => {
            locationStatus.style.display = 'block';
            locationStatus.textContent = '📍 Getting location...';
            locationStatus.style.color = 'var(--text-secondary)';

            if (!navigator.geolocation) {
                locationStatus.textContent = '❌ Geolocation not supported';
                return;
            }

            navigator.geolocation.getCurrentPosition(async (pos) => {
                try {
                    const { latitude, longitude } = pos.coords;
                    // Use a reasonable radius or just nearest
                    const url = `/nearby?latitude=${latitude}&longitude=${longitude}`;
                    const stations = await smartFetch(url, true);
                    
                    if (stations && stations.length > 0) {
                        const nearest = stations[0];
                        // Add to dropdown if not present
                        if (!Array.from(transportBaseSelect.options).some(o => o.value === nearest.globalId)) {
                            const opt = document.createElement('option');
                            opt.value = nearest.globalId;
                            opt.textContent = `📍 ${nearest.name} (Nearest)`;
                            transportBaseSelect.prepend(opt);
                        }
                        transportBaseSelect.value = nearest.globalId;
                        locationStatus.textContent = `✅ Found: ${nearest.name}`;
                        locationStatus.style.color = '#28a745';
                        
                        updateCommuteBuffer();
                    } else {
                        locationStatus.textContent = '❌ No stations found nearby';
                    }
                } catch (err) {
                    locationStatus.textContent = '❌ Error finding stations';
                }
            }, (err) => {
                locationStatus.textContent = `❌ Location access denied`;
            }, { timeout: 10000 });
        });
    }

    async function updateCommuteBuffer() {
        const origin = transportBaseSelect?.value;
        const dest = transportDestSelect?.value;
        if (!origin || !dest || origin === dest) return;
        
        try {
            const url = `/trips?origin=${origin}&dest=${dest}`;
            const data = await smartFetch(url, true);
            const trips = Array.isArray(data) ? data : (data.trips || []);
            
            if (trips && trips.length > 0) {
                const bestTrip = trips[0];
                const durationMinutes = Math.round((bestTrip.arrival - bestTrip.departure) / 60000);
                if (durationMinutes > 0 && commuteBufferInput) {
                    commuteBufferInput.value = durationMinutes;
                    locationStatus.textContent = `✅ Commute: ${durationMinutes} min (${bestTrip.origin.name} → ${bestTrip.destination.name})`;
                    locationStatus.style.display = 'block';
                    locationStatus.style.color = '#28a745';
                }
            }
        } catch (err) {
            console.warn('Failed to calculate commute time', err);
        }
    }

    [transportBaseSelect, transportDestSelect].forEach(el => {
        el?.addEventListener('change', updateCommuteBuffer);
    });

    async function saveSettings() {
        try {
            const privateCals = Array.from(document.querySelectorAll('.private-cal-entry')).map(e => ({
                url: e.querySelector('.private-cal-url').value,
                label: e.querySelector('.cal-label').value,
                mask: e.querySelector('.mask-names-check').checked,
            }));
            const data = {
                icalUrl: document.getElementById('ical-url').value,
                workStart: document.getElementById('work-start').value,
                workEnd: document.getElementById('work-end').value,
                minSlot: document.getElementById('min-slot').value,
                commuteBuffer: document.getElementById('commute-buffer').value,
                range: document.getElementById('view-range').value,
                customHolidays: document.getElementById('custom-holidays').value,
                selectedDays: Array.from(document.querySelectorAll('.day-check input:checked')).map(i => parseInt(i.value)),
                'bonus-hours': document.getElementById('bonus-hours').checked,
                'show-transport': document.getElementById('show-transport').checked,
                'show-lectures-cal': document.getElementById('show-lectures-cal').checked,
                'show-bonus-badge': document.getElementById('show-bonus-badge').checked,
                privateCals,
                transportBase: document.getElementById('transport-base').value,
                transportDestination: document.getElementById('transport-destination').value,
            };
            
            // 1. Save to localStorage
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

            // 2. Save to server
            if (phpProxySupported !== false) {
                try {
                    await fetch('proxy.php?action=save_settings', {
                        method: 'POST',
                        body: JSON.stringify(data),
                        headers: { 'Content-Type': 'application/json' }
                    });
                } catch (e) {
                    console.warn('Failed to save settings to server', e);
                }
            }
        } catch (e) { console.warn('Failed to save settings', e); }
    }
    loadSettings();

    let holidays = {};

    async function fetchHolidays(year) {
        const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/DE`;
        try {
            const data = await smartFetch(url, true, 4000);
            if (data && Array.isArray(data)) {
                data.forEach(h => {
                    if (!h.counties || h.counties.includes('DE-BY')) {
                        holidays[h.date] = h.localName;
                    }
                });
            }
        } catch (e) { console.error('Holiday API failed', e); }
    }

    fetchBtn.addEventListener('click', async () => {
        let url = document.getElementById('ical-url').value.trim();

        console.log("Fetch Button Clicked. URL:", url);

        const rangeEl = document.getElementById('view-range');
        const holidayEl = document.getElementById('custom-holidays');
        
        const rangeRaw = rangeEl ? rangeEl.value : "31";
        let range = 31;
        let forcedStartDate = null;

        if (rangeRaw.startsWith('month:')) {
            const monthIdx = parseInt(rangeRaw.split(':')[1]);
            const now = new Date();
            const year = now.getFullYear();
            // Map index (0-4) to actual month (Apr-Aug)
            const actualMonth = monthIdx + 3; 
            forcedStartDate = new Date(year, actualMonth, 1);
            range = new Date(year, actualMonth + 1, 0).getDate();
        } else if (rangeRaw === "93") {
            const now = new Date();
            const year = now.getFullYear();
            let termEnd;
            if (now.getMonth() < 3 || now.getMonth() >= 9) { // Oct - Mar (Winter)
                termEnd = new Date(now.getMonth() >= 9 ? year + 1 : year, 2, 31);
            } else { // Apr - Sep (Summer)
                termEnd = new Date(year, 8, 30);
            }
            range = Math.ceil((termEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        } else {
            range = parseInt(rangeRaw);
        }

        const customHolidaysRaw = holidayEl ? holidayEl.value : "";

        config = {
            workStart: document.getElementById('work-start')?.value || "09:00",
            workEnd: document.getElementById('work-end')?.value || "17:00",
            bonusEnabled: document.getElementById('bonus-hours')?.checked ?? true,
            showTransport: document.getElementById('show-transport')?.checked ?? true,
            showLecturesInCal: document.getElementById('show-lectures-cal')?.checked ?? true,
            showBonusBadge: document.getElementById('show-bonus-badge')?.checked ?? true,
            selectedDays: Array.from(document.querySelectorAll('.day-check input:checked')).map(i => parseInt(i.value)),
            range: range,
            forcedStartDate: forcedStartDate,
            minSlotHours: parseFloat(document.getElementById('min-slot')?.value) || 4,
            commuteBuffer: parseFloat(document.getElementById('commute-buffer')?.value) || 0,
            customHolidays: customHolidaysRaw.split(',').map(s => s.trim()).filter(s => s.match(/^\d{4}-\d{2}-\d{2}$/))
        };

        if (!url) {
            alert('Please enter your TUM iCal URL');
            return;
        }
        if (config.selectedDays.length === 0) {
            alert('Please select at least one work day');
            return;
        }

        saveSettings();

        loader.style.display = 'block';
        fetchBtn.disabled = true;

        await fetchHolidays(new Date().getFullYear());

        try {
            const icsData = await smartFetch(url, false, 30000);
            
            if (icsData.trim().startsWith('<?xml')) {
                const xmlDoc = parseXml(icsData);
                const errorMsg = xmlDoc?.getElementsByTagName("error")[0]?.getAttribute("message") 
                              || xmlDoc?.getElementsByTagName("message")[0]?.textContent 
                              || "TUMonline returned an error. Check if your token has 'Calendar' permissions.";
                throw new Error(`TUMonline: ${errorMsg}`);
            }

            allEvents = parseICS(icsData, range);

            // Fetch private calendars
            privateEvents = [];
            const calEntries = document.querySelectorAll('.private-cal-entry');
            for (const entry of calEntries) {
                const calUrl = entry.querySelector('.private-cal-url').value.trim();
                const calLabel = entry.querySelector('.cal-label').value.trim() || 'Private';
                const maskNames = entry.querySelector('.mask-names-check').checked;
                if (!calUrl) continue;
                try {
                    const pIcs = await smartFetch(calUrl, false, 20000);
                    const parsed = parseICS(pIcs, range);
                    parsed.forEach(e => {
                        e.private = true;
                        e.calendarName = calLabel;
                        const lockIcon = `<svg style="width:12px; height:12px; display:inline; vertical-align:middle; margin-right:4px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>`;
                        e.displayTitle = maskNames ? `${lockIcon} Private` : `${lockIcon} ${e.title}`;
                    });
                    privateEvents.push(...parsed);
                } catch (err) { console.warn(`Private calendar "${calLabel}" failed:`, err); }
            }

            renderLectureFilters(allEvents);
            setupCard.style.display = 'none';
            lectureSection.style.display = 'block';
        } catch (error) {
            console.error(error);
            alert(`Error fetching calendar: ${error.message}\n\nIf you are on a hosted site, make sure proxy.php is uploaded.`);
        } finally {
            loader.style.display = 'none';
            fetchBtn.disabled = false;
        }
    });

    let isCalculating = false;
    async function runAvailabilityCalculation() {
        if (isCalculating) return;
        isCalculating = true;

        try {
            resultsSection.classList.add('calculating');
            // Refresh config before calculation to catch late changes
            config = {
                ...config,
                workStart: document.getElementById('work-start').value,
                workEnd: document.getElementById('work-end').value,
                bonusEnabled: document.getElementById('bonus-hours').checked,
                showTransport: document.getElementById('show-transport').checked,
                showLecturesInCal: document.getElementById('show-lectures-cal').checked,
                showBonusBadge: document.getElementById('show-bonus-badge').checked,
                minSlotHours: parseFloat(document.getElementById('min-slot').value) || 4,
                commuteBuffer: parseFloat(document.getElementById('commute-buffer').value) || 0,
                transportBase: document.getElementById('transport-base').value,
            };

            const attendedLectures = Array.from(document.querySelectorAll('.attendance-check:checked'))
                .map(input => input.value);
            const mandatoryLectures = Array.from(document.querySelectorAll('.mandatory-check:checked'))
                .map(input => input.value);

            const filteredEvents = [
                ...allEvents.filter(e => attendedLectures.includes(e.title)),
                ...privateEvents
            ];
            saveSettings();

            calculateBtn.disabled = true;
            document.querySelectorAll('.lecture-bulk-actions button').forEach(b => b.disabled = true);

            const originalText = calculateBtn.innerHTML;
            calculateBtn.innerHTML = config.showTransport ? 'Fetching Transport Info...' : 'Generating Availability...';

            await processAvailability(filteredEvents, config, mandatoryLectures);

            // Note: We don't force-hide the lecture section here anymore if it's a live update
            // but we ensure results are visible
            resultsSection.style.display = 'block';
            calculateBtn.innerHTML = originalText;
        } catch (error) {
            console.error('Calculation failed:', error);
        } finally {
            isCalculating = false;
            calculateBtn.disabled = false;
            resultsSection.classList.remove('calculating');
            document.querySelectorAll('.lecture-bulk-actions button').forEach(b => b.disabled = false);
        }
    }

    calculateBtn.addEventListener('click', () => {
        runAvailabilityCalculation();
        lectureSection.style.display = 'none';
    });

    // --- Bulk Lecture Actions ---
    const selectAllBtn = document.getElementById('select-all-lectures');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            document.querySelectorAll('.attendance-check').forEach(cb => cb.checked = true);
            runAvailabilityCalculation();
        });
    }

    const unselectAllBtn = document.getElementById('unselect-all-lectures');
    if (unselectAllBtn) {
        unselectAllBtn.addEventListener('click', () => {
            document.querySelectorAll('.attendance-check').forEach(cb => cb.checked = false);
            runAvailabilityCalculation();
        });
    }

    const smartUncheckBtn = document.getElementById('smart-uncheck-lectures');
    if (smartUncheckBtn) {
        smartUncheckBtn.addEventListener('click', () => {
            document.querySelectorAll('.attendance-check').forEach(cb => {
                const name = cb.value.toLowerCase();
                const isOptionalMatch = name.includes('vorlesung') || name.includes('(vo)') || name.includes(' lecture');
                const isMandatoryMatch = name.includes('übung') || name.includes('(ue)') || name.includes('praktikum') || name.includes('(pr)') || name.includes('seminar') || name.includes('(se)') || name.includes(' exercise');

                if (isOptionalMatch && !isMandatoryMatch) {
                    cb.checked = false;
                }
            });
            runAvailabilityCalculation();
        });
    }

    function parseICS(icsData, rangeDays) {
        const jcalData = ICAL.parse(icsData);
        const comp = new ICAL.Component(jcalData);
        const vevents = comp.getAllSubcomponents('vevent');

        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);

        const end = new Date(start);
        end.setDate(start.getDate() + rangeDays);

        return vevents.map(vevent => {
            const event = new ICAL.Event(vevent);
            const title = event.summary || '';
            return {
                title: title,
                isExam: EXAM_KEYWORDS.some(k => title.toLowerCase().includes(k)),
                start: event.startDate.toJSDate(),
                end: event.endDate.toJSDate(),
                location: event.location || ''
            };
        }).filter(e => e.start >= start && e.start < end);
    }

    function renderLectureFilters(events) {
        const uniqueLectures = [...new Set(events.map(e => e.title))].sort((a, b) => {
            const aFirst = events.filter(e => e.title === a).sort((x, y) => x.start - y.start)[0];
            const bFirst = events.filter(e => e.title === b).sort((x, y) => x.start - y.start)[0];
            if (!aFirst) return 1;
            if (!bFirst) return -1;
            return aFirst.start - bFirst.start;
        });
        lectureList.innerHTML = uniqueLectures.map(name => {
            const occurrences = events.filter(e => e.title === name).sort((a, b) => a.start - b.start);
            const nextOccurrence = occurrences[0];
            const timeInfo = nextOccurrence
                ? `${nextOccurrence.start.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} \u00B7 ${formatTime(nextOccurrence.start)}\u2013${formatTime(nextOccurrence.end)}`
                : '';
            return `
            <div class="lecture-filter-item">
                <div style="display: flex; gap: 12px; align-items: center; width: 100%;">
                    <input type="checkbox" class="attendance-check" value="${name}" checked title="Attend this lecture (Blocks work time)">
                    <div class="lecture-info">
                        <span class="lecture-name">${name}</span>
                        <div style="display: flex; gap: 10px; align-items: center; margin-top: 4px; flex-wrap: wrap;">
                            ${timeInfo ? `<span style="font-size: 0.75rem; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 4px;">
                                <svg style="width:14px; height:14px; opacity:0.7;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                                ${timeInfo} (${occurrences.length}\u00D7)${nextOccurrence.location ? ` @ ${nextOccurrence.location}` : ''}</span>` : ''}
                            <label style="display: flex; gap: 4px; align-items: center; font-size: 0.75rem; cursor: pointer;">
                                <input type="checkbox" class="mandatory-check" value="${name}">
                                <span>Mandatory Module</span>
                            </label>
                        </div>
                    </div>
                </div>
            </div>
        `}).join('');

        // Wire up live updates
        lectureList.querySelectorAll('input').forEach(input => {
            input.addEventListener('change', () => {
                runAvailabilityCalculation();
            });
        });
    }

    function toLocalDateStr(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function isHoliday(date) {
        const str = toLocalDateStr(date);
        if (config.customHolidays && config.customHolidays.includes(str)) return 'Custom Holiday';
        return holidays[str] || null;
    }

    let transportCache = null;
    const TRANSPORT_FAILED = Symbol('failed'); // sentinel so we don't retry after a failure

    async function getTransportInfo(date, time, showTransport, station) {
        if (!showTransport || !station) return null;

        // Return cached result (including cached failure — avoids hammering the API per slot)
        if (transportCache && transportCache.station === station) {
            if (transportCache.data === TRANSPORT_FAILED) return null;
            return findBestDeparture(transportCache.data, time, date);
        }

        try {
            // Send to proxy.php, which detects /departures, rewrites to the real MVG API, 
            // and returns live departure data.
            const url = `/departures?station=${station}`;
            const data = await smartFetch(url, true, 15000);
            if (!data || data.error) throw new Error(data?.error || 'Empty/error response');
            transportCache = { station, data };
            return findBestDeparture(data, time, date);
        } catch (e) {
            console.warn('Transport fetch failed:', e.message);
            transportCache = { station, data: TRANSPORT_FAILED };
            return null;
        }
    }

    function parseDepTime(d) {
        // Python server format:  d.time in Unix seconds
        // MVG v3 API format:     d.realtimeDepartureTime / d.plannedDepartureTime in milliseconds
        if (d.time != null) return new Date(d.time * 1000);
        if (d.realtimeDepartureTime != null) return new Date(d.realtimeDepartureTime);
        if (d.plannedDepartureTime != null) return new Date(d.plannedDepartureTime);
        return null;
    }

    function findBestDeparture(data, time, date) {
        const departures = Array.isArray(data) ? data : (data.departures || []);
        if (departures.length === 0) return null;
        const [h, m] = time.split(':').map(Number);
        const targetMin = h * 60 + m;

        const best = departures.find(d => {
            const depTime = parseDepTime(d);
            if (!depTime || isNaN(depTime.getTime())) return false;

            const depMin = depTime.getHours() * 60 + depTime.getMinutes();
            if (depMin < targetMin) return false;

            const line = d.line || d.label || '';
            const type = d.type || d.transportType || '';

            // Match S1 S-Bahn, bus line 635, or any bus type
            // transportType values from MVG v3: SBAHN, BUS, REGIONAL_BUS, UBAHN, TRAM
            return line.startsWith('S1')
                || line.includes('635')
                || type === 'SBAHN'
                || type === 'BUS'
                || type === 'REGIONAL_BUS'
                || type === 'Bus'; // Python server format
        });

        if (!best) return null;

        const depTime = parseDepTime(best);
        if (!depTime || isNaN(depTime.getTime())) return null;

        const line = best.line || best.label || '';
        const destination = best.destination || '';
        return {
            text: `${line} to ${destination} (${formatTime(depTime)})`,
            url: `https://www.mvv-muenchen.de/en/journey-planer/index.html?&origin=Freising&destination=Airport&time=${time}&date=${date.toLocaleDateString('de-DE')}`
        };
    }

    function switchMonth(monthId) {
        const tabs = document.querySelectorAll('.month-tab');
        const months = document.querySelectorAll('.month-section');
        
        tabs.forEach(t => t.classList.toggle('active', t.dataset.month === monthId));
        months.forEach(m => m.style.display = m.dataset.month === monthId ? 'block' : 'none');
        
        // Save preferred month view if needed, but usually we just stay in one
        console.log("Switched to month:", monthId);
    }

    async function processAvailability(events, cfg, mandatoryList = []) {
        // Only clear transport cache if station changed
        if (!transportCache || transportCache.station !== cfg.transportBase) {
            transportCache = null; 
        }
        lastAvailabilitySlots = [];
        
        if (monthTabs) monthTabs.innerHTML = ''; // Clear old tabs
        
        let html = '';
        let fullText = '';
        let whatsappText = '';
        let totalMinutes = 0;
        let weekCounter = 1;

        const start = cfg.forcedStartDate ? new Date(cfg.forcedStartDate) : new Date();
        start.setHours(0, 0, 0, 0);

        // Align to Monday of the current week for a consistent grid
        const startDay = start.getDay();
        const diffToMonday = (startDay === 0 ? -6 : 1) - startDay;
        const mondayOfStartWeek = new Date(start);
        mondayOfStartWeek.setDate(start.getDate() + diffToMonday);

        // Range starts from the Monday of that week
        const totalDaysToShow = Math.ceil((cfg.range + (start.getTime() - mondayOfStartWeek.getTime()) / (1000 * 3600 * 24)) / 7) * 7;

        let currentMonth = -1;
        let weekHtml = '';
        let weekAvailabilityCount = 0;
        let weekTotalMinutes = 0;

        for (let i = 0; i < totalDaysToShow; i++) {
            const dayDate = new Date(mondayOfStartWeek);
            dayDate.setDate(mondayOfStartWeek.getDate() + i);
            const dayOfWeek = dayDate.getDay();
            const month = dayDate.getMonth();
            const year = dayDate.getFullYear();

            const isSelected = cfg.selectedDays.includes(dayOfWeek);
            const dateStr = dayDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
            const dayLabel = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayOfWeek];

            const holidayName = isHoliday(dayDate);
            const isBonusDay = (dayOfWeek === 0 || holidayName);

            // Month Container Start
            if (month !== currentMonth) {
                if (currentMonth !== -1) {
                    // If a month ends mid-week, we must render the partial week in the old month
                    if (weekHtml.trim() !== '') {
                        const weekHours = (weekTotalMinutes / 60).toFixed(1);
                        html += `
                            <details class="week-collapsible">
                                <summary class="week-summary">
                                    <span class="week-title">Week ${weekCounter} (cont.)</span>
                                    <div class="week-meta">
                                        <span class="week-stat">${weekAvailabilityCount} Active Days</span>
                                        <span class="week-stat hours">${weekHours}h total</span>
                                    <span class="expand-icon">▾</span>
                                    </div>
                                </summary>
                                <div class="week-row">${weekHtml}</div>
                            </details>
                        `;
                        weekHtml = '';
                        weekAvailabilityCount = 0;
                        weekTotalMinutes = 0;
                        // Don't increment weekCounter here, keep it for the next part of the week in the new month
                    }
                    html += `</div>`; // Close previous month section
                }
                const monthName = dayDate.toLocaleString('default', { month: 'long' });
                const monthId = `${year}-${month}`;

                const existingTab = monthTabs ? Array.from(monthTabs.children).find(c => c.dataset.month === monthId) : null;
                
                if (!existingTab) {
                    const btn = document.createElement('button');
                    btn.className = 'month-tab';
                    btn.dataset.month = monthId;
                    btn.textContent = monthName;
                    btn.onclick = () => switchMonth(monthId);
                    monthTabs.appendChild(btn);
                }

                html += `
                    <div class="month-section" data-month="${monthId}">
                        <div class="month-header">
                            ${monthName} <span class="month-year">${year}</span>
                        </div>
                `;
                currentMonth = month;
                weekCounter = 1;
            }

            // Day Availability Logic
            let daySlotsHtml = '';
            let dayLecturesHtml = '';
            let hasDayAvailability = false;
            let daySlotsOnly = [];
            let isLabDay = false;
            let dayEvents = [];

            if (dayDate >= start && dayDate < new Date(start.getTime() + cfg.range * 24 * 3600 * 1000)) {
                dayEvents = events.filter(e => e.start.toDateString() === dayDate.toDateString());
                const hasExam = dayEvents.some(e => e.isExam);
                isLabDay = dayEvents.some(e => e.title.toLowerCase().includes('lab') || e.title.toLowerCase().includes('praktikum'));

                if (hasExam) {
                    // No availability on exam days
                    dayLecturesHtml = `<div class="holiday-label" style="background:#fff1f0;color:#cf1322;border-color:#ffa39e;padding:12px;margin:8px 0;">\uD83D\uDD25 Exam Day Detected. Availability hidden to ensure study focus.</div>`;
                } else if (cfg.showLecturesInCal && dayEvents.length > 0) {
                    dayLecturesHtml = `<div class="day-lectures">${dayEvents.map(e => {
                        if (e.private) {
                            return `
                                <div class="lecture-mini private-event">
                                    <span class="lecture-time-mini">${formatTime(e.start)}–${formatTime(e.end)}</span>
                                    <span class="lecture-name-mini">${e.displayTitle}</span>
                                </div>
                            `;
                        }
                        const isMandatory = mandatoryList.includes(e.title);
                        return `
                            <div class="lecture-mini ${isMandatory ? 'mandatory' : ''}">
                                <span class="lecture-time-mini">${formatTime(e.start)}–${formatTime(e.end)}</span>
                                <span class="lecture-name-mini">${e.title}${e.location ? ` @ ${e.location}` : ''}</span>
                                ${isMandatory ? '<span class="mandatory-badge" style="display:inline-flex; align-items:center; gap:4px;"><svg style="width:12px; height:12px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"></path></svg> Mandatory</span>' : ''}
                            </div>
                        `;
                    }).join('')}</div>`;
                }

                if (isSelected && !hasExam) {
                    const timeBlocks = [];
                    const [startH, startM] = cfg.workStart.split(':').map(Number);
                    const [endH, endM] = cfg.workEnd.split(':').map(Number);
                    timeBlocks.push({ start: new Date(dayDate).setHours(startH, startM, 0, 0), end: new Date(dayDate).setHours(endH, endM, 0, 0), type: 'base' });

                    if (cfg.bonusEnabled && isBonusDay) {
                        timeBlocks.push({ start: new Date(dayDate).setHours(0, 0, 0, 0), end: new Date(dayDate).setHours(8, 0, 0, 0), type: 'bonus' });
                        timeBlocks.push({ start: new Date(dayDate).setHours(22, 0, 0, 0), end: new Date(dayDate).setHours(23, 59, 59, 999), type: 'bonus' });
                    }

                    let dayText = `${dayLabel} ${dateStr}:\n`;
                    for (const block of timeBlocks) {
                        let current = new Date(block.start);
                        const blockEnd = new Date(block.end);
                        const blockEvents = dayEvents.filter(e => e.start < blockEnd && e.end > current).sort((a, b) => a.start - b.start);
                        const availability = [];

                        const bufferMs = (cfg.commuteBuffer || 0) * 60 * 60 * 1000;

                        blockEvents.forEach(event => {
                            const bufferedStart = new Date(event.start.getTime() - bufferMs);
                            if (bufferedStart > current) {
                                availability.push({ start: new Date(current), end: new Date(Math.min(bufferedStart, blockEnd)) });
                            }
                            current = new Date(Math.max(current.getTime(), event.end.getTime() + bufferMs));
                        });
                        if (current < blockEnd) availability.push({ start: new Date(current), end: new Date(blockEnd) });

                        const minSlotMs = (cfg.minSlotHours || 4) * 60 * 60 * 1000;
                        const filtered = availability.filter(a => (a.end - a.start) >= minSlotMs);
                        for (const slot of filtered) {
                            hasDayAvailability = true;
                            const slotMin = (slot.end - slot.start) / (1000 * 60);
                            totalMinutes += slotMin;
                            weekTotalMinutes += slotMin;
                            const timeStr = `${formatTime(slot.start)} - ${formatTime(slot.end)}`;
                            const transport = await getTransportInfo(dayDate, formatTime(slot.start), cfg.showTransport, cfg.transportBase);
                            const slotIdx = lastAvailabilitySlots.length;
                            lastAvailabilitySlots.push({
                                start: slot.start,
                                end: slot.end,
                                bonus: block.type === 'bonus',
                                dayLabel,
                                dateStr,
                                timeStr,
                                duration: getDurationText(slot.start, slot.end),
                                transport: transport ? transport.text : null,
                            });

                            daySlotsHtml += `
                                <label class="slot-mini ${block.type === 'bonus' ? 'bonus' : ''}" onclick="event.stopPropagation()">
                                    <input type="checkbox" class="slot-select" data-slot-idx="${slotIdx}">
                                    <div class="slot-body">
                                        <span class="slot-time">${timeStr}</span>
                                        ${transport ? `<a href="${transport.url}" target="_blank" class="slot-transport">\uD83D\uDE86 ${transport.text}</a>` : ''}
                                    </div>
                                </label>
                            `;
                            dayText += `  • ${timeStr} (${getDurationText(slot.start, slot.end)})${block.type === 'bonus' ? ' [BONUS]' : ''}\n`;
                            daySlotsOnly.push(getTimePeriodLabel(slot.start, slot.end));
                        }
                    }

                    if (hasDayAvailability) {
                        fullText += dayText + '\n';
                        whatsappText += `${dayLabel} ${dateStr}: ${daySlotsOnly.join(', ')}\n`;
                        weekAvailabilityCount++;
                    }
                }
            }

            // Don't show days that belong to a different month in the current month section
            if (month === currentMonth) {
                weekHtml += `
                    <div class="day-card collapsed ${!isSelected ? 'disabled' : ''} ${holidayName ? 'holiday' : ''} ${isBonusDay && isSelected ? 'bonus' : ''}" 
                         onclick="this.classList.toggle('collapsed'); this.classList.toggle('expanded');">
                        <div class="day-header">
                            <span class="day-label">${dayLabel}</span>
                            <span class="day-number">${dayDate.getDate()}</span>
                        </div>
                        ${holidayName ? `<div class="holiday-label" style="display:inline-flex; align-items:center; gap:4px;"><svg style="width:12px; height:12px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path></svg> ${holidayName}</div>` : ''}
                        ${dayEvents.some(e => e.isExam) ? `<div class="holiday-label" style="background:#ff4d4f;color:white;display:inline-flex; align-items:center; gap:4px;"><svg style="width:12px; height:12px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.99 7.99 0 0120 13a7.99 7.99 0 01-2.343 5.657z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.879 16.121A3 3 0 1012.015 11L11 14l.879 2.121z"></path></svg> EXAM DAY</div>` : ''}
                        ${dayOfWeek === 0 ? `<div class="holiday-label overtime" style="display:inline-flex; align-items:center; gap:4px;"><svg style="width:12px; height:12px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Sunday Overtime</div>` : ''}
                        ${isLabDay ? `<div class="holiday-label lab" style="display:inline-flex; align-items:center; gap:4px;"><svg style="width:12px; height:12px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.022.547l-2.387 2.387a2 2 0 000 2.828l.596.596a2 2 0 002.828 0l2.387-2.387a2 2 0 00.547-1.022l.477-2.387a6 6 0 00-.517-3.86l-.158-.318a6 6 0 01-.517-3.86l.477-2.387a2 2 0 00-.547-1.022l-2.387-2.387a2 2 0 00-2.828 0l-.596.596a2 2 0 000 2.828l2.387 2.387z"></path></svg> Lab Course</div>` : ''}
                        
                        <div class="collapsed-info">
                            ${daySlotsOnly.length > 0 ? `
                                <div class="collapsed-slots" style="display:flex; align-items:center; gap:4px;">
                                    <svg style="width:12px; height:12px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                    Available: ${[...new Set(daySlotsOnly)].join(', ')}
                                </div>` : ''}
                            ${dayEvents.length > 0 ? `
                                <div class="collapsed-lectures" style="display:flex; align-items:center; gap:4px;">
                                    <svg style="width:10px; height:10px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
                                    Unavailable: ${dayEvents.map(e => {
                                        const time = `${formatTime(e.start)}\u2013${formatTime(e.end)}`;
                                        const lock = e.private ? `<svg style="width:8px; height:8px; display:inline; margin-left:2px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>` : '';
                                        return time + lock;
                                    }).join(', ')}
                                </div>` : ''}
                        </div>
                        
                        <div class="day-content">
                            ${dayLecturesHtml ? `<div class="lectures-section">${dayLecturesHtml}</div>` : ''}
                            <div class="slots-container">${daySlotsHtml || (isSelected && dayDate >= start ? '<span class="no-slots">No slots</span>' : '')}</div>
                        </div>
                        
                        <div class="card-summary">
                            <span class="expand-hint">Click for details</span>
                        </div>
                    </div>
                `;
            }

            // Week Container End
            if (dayOfWeek === 0 || i === totalDaysToShow - 1) {
                if (weekHtml.trim() !== '') {
                    const weekHours = (weekTotalMinutes / 60).toFixed(1);
                    html += `
                        <details class="week-collapsible">
                            <summary class="week-summary">
                                <span class="week-title">Week ${weekCounter}</span>
                                <div class="week-meta">
                                    <span class="week-stat">${weekAvailabilityCount} Active Days</span>
                                    <span class="week-stat hours">${weekHours}h total</span>
                                    <span class="week-stat selected" style="display:none;">0h selected</span>
                                    <span class="expand-icon">▾</span>
                                </div>
                            </summary>
                            <div class="week-row">
                                ${weekHtml}
                            </div>
                        </details>
                    `;
                    weekCounter++;
                }
                weekHtml = '';
                weekAvailabilityCount = 0;
                weekTotalMinutes = 0;
            }
        }

        html += `</div>`; // Close last month

        availabilityContainer.innerHTML = html;

        // Auto-select first month tab
        const firstTab = document.querySelector('.month-tab');
        if (firstTab) {
            switchMonth(firstTab.dataset.month);
        }

        const totalHours = (totalMinutes / 60).toFixed(1);
        const isGoalReached = totalHours >= 80;

        document.getElementById('total-hours-container').innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <div class="total-badge ${isGoalReached ? 'goal' : ''}">${totalHours} Hours Total ${isGoalReached ? '✓' : ''}</div>
                <p style="font-size: 0.8rem; color: var(--text-secondary); margin: 0;">${isGoalReached ? 'Target 80h reached!' : 'Goal: 80h (Need ' + (80 - totalHours).toFixed(1) + 'h more)'}</p>
            </div>
        `;

        // Show results
        document.getElementById('results-section').style.display = 'block';

        // Show/hide selection bar based on results
        const selectionBar = document.querySelector('.selection-bar');
        if (selectionBar) {
            selectionBar.style.display = lastAvailabilitySlots.length > 0 ? 'flex' : 'none';
        }

        wireSelectionUI();
    }

    // --- Slot selection: live summary, master toggle, selective copy ---
    function getSelectedSlots() {
        const checked = document.querySelectorAll('.slot-select:checked');
        return Array.from(checked)
            .map(cb => lastAvailabilitySlots[parseInt(cb.dataset.slotIdx)])
            .filter(Boolean);
    }

    function updateSelectionSummary() {
        const summary = document.getElementById('selection-summary');
        const selectAll = document.getElementById('select-all-slots');
        if (!summary) return;
        const selected = getSelectedSlots();
        const total = lastAvailabilitySlots.length;
        const minutes = selected.reduce((acc, s) => acc + (s.end - s.start) / 60000, 0);
        summary.textContent = `${selected.length} of ${total} selected \u00b7 ${(minutes / 60).toFixed(1)}h`;

        // Update Week Headers
        document.querySelectorAll('.week-collapsible').forEach(week => {
            const selectedInWeek = week.querySelectorAll('.slot-select:checked');
            let minutesInWeek = 0;
            selectedInWeek.forEach(cb => {
                const s = lastAvailabilitySlots[parseInt(cb.dataset.slotIdx)];
                if (s) minutesInWeek += (s.end - s.start) / 60000;
            });
            const badge = week.querySelector('.week-stat.selected');
            if (badge) {
                badge.textContent = `${(minutesInWeek / 60).toFixed(1)}h selected`;
                badge.style.display = minutesInWeek > 0 ? 'inline-block' : 'none';
            }
        });

        // Sync master toggle without firing change loop
        if (selectAll) {
            selectAll.indeterminate = selected.length > 0 && selected.length < total;
            selectAll.checked = selected.length === total && total > 0;
        }
    }

    function wireSelectionUI() {
        const selectAll = document.getElementById('select-all-slots');
        if (selectAll) {
            selectAll.onchange = () => {
                document.querySelectorAll('.slot-select').forEach(cb => { cb.checked = selectAll.checked; });
                updateSelectionSummary();
            };
        }
        document.querySelectorAll('.slot-select').forEach(cb => {
            cb.addEventListener('change', updateSelectionSummary);
        });
        updateSelectionSummary();
    }

    function buildWhatsappFromSelection(selected) {
        const byDay = new Map();
        selected.forEach(s => {
            const key = `${s.dayLabel} ${s.dateStr}`;
            if (!byDay.has(key)) byDay.set(key, new Set());
            byDay.get(key).add(getTimePeriodLabel(s.start, s.end));
        });

        const lines = Array.from(byDay.entries())
            .map(([day, periods]) => {
                const p = Array.from(periods);
                if (p.includes('Whole Day')) return day;
                return `${day} – ${p.join(' & ')}`;
            });

        return lines.join('\n');
    }

    function buildFullSummaryFromSelection(selected) {
        const byDay = new Map();
        selected.forEach(s => {
            const key = `${s.dayLabel} ${s.dateStr}`;
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key).push(s);
        });
        let text = '';
        for (const [day, slots] of byDay.entries()) {
            // Deduplicate period labels per day
            const seen = new Set();
            const lines = [];
            slots.forEach(s => {
                let label = getTimePeriodLabel(s.start, s.end);
                if (s.bonus) label += ' [BONUS]';
                const key = label + (s.transport || '');
                if (!seen.has(key)) {
                    seen.add(key);
                    lines.push(`  • ${label}${s.transport ? ` \uD83D\uDE86 ${s.transport}` : ''}`);
                }
            });
            text += `${day}:\n${lines.join('\n')}\n\n`;
        }
        return text.trim();
    }

    async function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            // Fallback for HTTP or older browsers
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (!ok) throw new Error('execCommand copy failed');
        }
    }

    copyBtn.onclick = async () => {
        const selected = getSelectedSlots();
        if (!selected.length) { showToast('No slots selected'); return; }
        try {
            await copyToClipboard(buildFullSummaryFromSelection(selected));
            showToast(`Copied ${selected.length} slots`);
        } catch (e) {
            showToast('Copy failed – try HTTPS or grant clipboard permission');
            console.error('Clipboard write failed:', e);
        }
    };
    whatsappBtn.onclick = async () => {
        const selected = getSelectedSlots();
        if (!selected.length) { showToast('No slots selected'); return; }
        try {
            await copyToClipboard(buildWhatsappFromSelection(selected));
            showToast(`Copied ${selected.length} slots`);
        } catch (e) {
            showToast('Copy failed – try HTTPS or grant clipboard permission');
            console.error('Clipboard write failed:', e);
        }
    };

    function formatTime(d) {
        return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    function getTimePeriodLabel(start, end) {
        const startH = start.getHours() + start.getMinutes() / 60;
        const endH = end.getHours() + end.getMinutes() / 60;
        const durationH = endH - startH;
        const cut = 14; // 2pm divides morning from evening

        // Spans both sides of 2pm and at least 6h → Whole Day
        if (startH < cut && endH > cut && durationH >= 6) return 'Whole Day';
        // Ends at or before 2pm, at least 4h → Morning
        if (endH <= cut && durationH >= 4) return 'Morning';
        // Starts at or after 2pm, at least 4h → Evening
        if (startH >= cut && durationH >= 4) return 'Evening';
        // Short or oddly placed slot → show actual times
        return `${formatTime(start)} \u2013 ${formatTime(end)}`;
    }
    function getDurationText(s, e) {
        const diff = (e - s) / (1000 * 60);
        const h = Math.floor(diff / 60);
        const m = Math.round(diff % 60);
        return h > 0 ? `${h}h ${m > 0 ? m + 'm' : ''}` : `${m}m`;
    }
    function showToast(msg = 'Copied to clipboard!') {
        const toast = document.createElement('div');
        toast.className = 'copy-toast show';
        toast.innerText = msg;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    // --- ICS Export ---
    function pad(n) { return String(n).padStart(2, '0'); }
    function toIcsDate(d) {
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    }
    function buildIcs(slots) {
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//TUM Balancer//EN',
            'CALSCALE:GREGORIAN',
        ];
        slots.forEach((s, i) => {
            lines.push(
                'BEGIN:VEVENT',
                `UID:tum-balancer-${Date.now()}-${i}@local`,
                `DTSTAMP:${toIcsDate(new Date())}`,
                `DTSTART:${toIcsDate(s.start)}`,
                `DTEND:${toIcsDate(s.end)}`,
                `SUMMARY:Available for Work${s.bonus ? ' (Bonus)' : ''}`,
                'END:VEVENT'
            );
        });
        lines.push('END:VCALENDAR');
        return lines.join('\r\n');
    }
    const icsBtn = document.getElementById('ics-btn');
    if (icsBtn) {
        icsBtn.addEventListener('click', () => {
            const selected = getSelectedSlots();
            if (!selected.length) { showToast('No slots selected'); return; }
            const ics = buildIcs(selected);
            const blob = new Blob([ics], { type: 'text/calendar' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `tum-availability-${new Date().toISOString().slice(0, 10)}.ics`;
            a.click();
            URL.revokeObjectURL(a.href);
            showToast(`Exported ${selected.length} slots`);
        });
    }
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.onclick = () => {
            document.getElementById('setup-card').style.display = 'block';
            document.getElementById('lecture-selection-section').style.display = 'block';
            document.getElementById('results-section').style.display = 'none';
        };
    }
});

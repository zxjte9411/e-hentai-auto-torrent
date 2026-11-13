// ==UserScript==
// @name         E-Hentai Auto Torrent Downloader
// @namespace    https://e-hentai.org/
// @version      1.3.0
// @description  自動抓取 E-Hentai / ExHentai 作品最新種子檔 (.torrent)，支援編號勾選、Shift 區間、範圍輸入 (1, 2, 4-12)、單檔與打包 ZIP 下載
// @author       Antigravity
// @match        https://e-hentai.org/*
// @match        https://exhentai.org/*
// @connect      e-hentai.org
// @connect      exhentai.org
// @connect      ehtracker.org
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // 批次下載每筆間隔 (毫秒)，避免請求過快被 E-Hentai / EHTracker 暫時封鎖
    const BATCH_DELAY_MS = 1000;

    // 取得目前頁面所有作品項目（無種子者也保留連續編號）
    function getGalleryEntries() {
        const itg = document.querySelector('.itg');
        if (itg) {
            const thumbItems = Array.from(itg.querySelectorAll('.gl1t'));
            if (thumbItems.length > 0) {
                return thumbItems.map((el, idx) => ({
                    index: idx + 1,
                    container: el,
                    mode: 'thumb',
                    torrentLink: el.querySelector('.gldown > a[href*="gallerytorrents.php"]'),
                }));
            }
            if (itg.tagName === 'TABLE') {
                const rows = Array.from(itg.querySelectorAll('tr')).filter((tr) =>
                    tr.querySelector('.glname, .gldown')
                );
                if (rows.length > 0) {
                    return rows.map((el, idx) => ({
                        index: idx + 1,
                        container: el,
                        mode: 'table',
                        torrentLink: el.querySelector('.gldown > a[href*="gallerytorrents.php"]'),
                    }));
                }
            }
        }

        // 單一作品頁 (#gd5)
        const detailLink = document.querySelector('#gd5 a[onclick*="gallerytorrents.php"]');
        if (detailLink) {
            return [{
                index: 1,
                container: detailLink.parentElement,
                mode: 'detail',
                torrentLink: detailLink,
            }];
        }

        return [];
    }

    // 清理 Windows 不合法的檔名字元
    function sanitizeFilename(name) {
        return name.replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    // 從 Content-Disposition 解析檔名
    function parseFilenameFromHeaders(headersStr) {
        if (!headersStr) return null;
        const utf8Match = headersStr.match(/filename\*\s*=\s*UTF-8''([^\r\n;]+)/i);
        if (utf8Match) {
            try {
                return sanitizeFilename(decodeURIComponent(utf8Match[1].replace(/^["']|["']$/g, '')));
            } catch (_) { /* ignore */ }
        }
        const normalMatch = headersStr.match(/filename\s*=\s*"([^"]+)"/i) ||
                            headersStr.match(/filename\s*=\s*([^;\r\n]+)/i);
        if (normalMatch) {
            return sanitizeFilename(normalMatch[1].trim());
        }
        return null;
    }

    class RateLimitError extends Error {
        constructor(status) {
            super(`遇到伺服器限流 (${status})，已暫停以避免封鎖`);
            this.status = status;
        }
    }

    // 使用 fetch (帶入登入 Cookie) 取得 gallerytorrents.php，並選出最新的一份種子
    async function fetchLatestTorrentInfo(galleryTorrentsUrl, signal) {
        const res = await fetch(galleryTorrentsUrl, { credentials: 'include', signal });
        if (res.status === 429 || res.status === 503) {
            throw new RateLimitError(res.status);
        }
        if (!res.ok) {
            throw new Error(`無法讀取種子清單 (${res.status})`);
        }
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const forms = Array.from(doc.querySelectorAll('#torrentinfo form'));

        const candidates = [];
        for (const form of forms) {
            const linkEl = form.querySelector('a[href*="ehtracker.org/get/"]');
            if (!linkEl) continue;

            const text = form.textContent || '';
            const postedMatch = text.match(/Posted:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
            const postedTime = postedMatch ? Date.parse(postedMatch[1].replace(' ', 'T') + ':00Z') : 0;

            let fallbackName = linkEl.textContent.trim();
            if (!fallbackName.toLowerCase().endsWith('.torrent')) {
                fallbackName += '.torrent';
            }

            candidates.push({
                url: linkEl.href,
                postedTime: isNaN(postedTime) ? 0 : postedTime,
                fallbackName: sanitizeFilename(fallbackName),
            });
        }

        if (candidates.length === 0) {
            throw new Error('清單中找不到可下載的種子連結');
        }

        candidates.sort((a, b) => b.postedTime - a.postedTime);
        return candidates[0];
    }

    // 透過 GM_xmlhttpRequest 跨域取得 ehtracker.org 的 .torrent ArrayBuffer 與檔名
    function fetchTorrentData(torrentInfo, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }

            let aborted = false;
            const req = GM_xmlhttpRequest({
                method: 'GET',
                url: torrentInfo.url,
                responseType: 'arraybuffer',
                onload(response) {
                    cleanup();
                    if (aborted) return;
                    if (response.status === 429 || response.status === 503) {
                        reject(new RateLimitError(response.status));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`下載種子失敗 (${response.status})`));
                        return;
                    }
                    const headerFilename = parseFilenameFromHeaders(response.responseHeaders);
                    const finalName = headerFilename || torrentInfo.fallbackName;
                    resolve({ filename: finalName, buffer: response.response });
                },
                onerror() {
                    cleanup();
                    if (!aborted) reject(new Error('下載種子時發生網路錯誤'));
                },
                onabort() {
                    cleanup();
                    reject(new DOMException('Aborted', 'AbortError'));
                },
            });

            function onAbort() {
                aborted = true;
                if (req && typeof req.abort === 'function') req.abort();
                reject(new DOMException('Aborted', 'AbortError'));
            }

            function cleanup() {
                if (signal) signal.removeEventListener('abort', onAbort);
            }

            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    // 觸發瀏覽器儲存 Blob
    function triggerBrowserDownload(blob, filename) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    }

    async function downloadGalleryLatestTorrent(galleryTorrentsUrl, signal) {
        const latest = await fetchLatestTorrentInfo(galleryTorrentsUrl, signal);
        const { filename, buffer } = await fetchTorrentData(latest, signal);
        const blob = new Blob([buffer], { type: 'application/x-bittorrent' });
        triggerBrowserDownload(blob, filename);
        return filename;
    }

    // 避免壓縮包內檔名重複被覆蓋
    function getUniqueZipFilename(usedNames, filename) {
        if (!usedNames.has(filename)) {
            usedNames.add(filename);
            return filename;
        }
        const dotIdx = filename.lastIndexOf('.');
        const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
        const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';
        let n = 2;
        while (usedNames.has(`${base} (${n})${ext}`)) {
            n++;
        }
        const unique = `${base} (${n})${ext}`;
        usedNames.add(unique);
        return unique;
    }

    // 產生壓縮包檔名
    function buildZipArchiveName() {
        const params = new URLSearchParams(location.search);
        const rawLabel = params.get('f_search') || document.title.replace(/\s*-\s*E-Hentai.*$/i, '');
        const label = sanitizeFilename(rawLabel).slice(0, 50) || 'page';
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        return `e-hentai-torrents_${label}_${ts}.zip`;
    }

    // CRC-32 計算（標準 IEEE 802.3）
    const CRC32_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) {
            c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    }

    // 同步打包標準 ZIP (STORE 無壓縮，支援 UTF-8 檔名，無外部相依與沙盒卡死問題)
    function buildZipBlob(entries) {
        const encoder = new TextEncoder();
        const now = new Date();
        const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
        const dosDate = (((Math.max(now.getFullYear(), 1980) - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

        const parts = [];
        const centralRecords = [];
        let offset = 0;

        for (const entry of entries) {
            const nameBytes = encoder.encode(entry.name);
            const dataBytes = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
            const crc = crc32(dataBytes);

            const localHeader = new ArrayBuffer(30);
            const lv = new DataView(localHeader);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0x0800, true);
            lv.setUint16(8, 0, true);
            lv.setUint16(10, dosTime, true);
            lv.setUint16(12, dosDate, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, dataBytes.length, true);
            lv.setUint32(22, dataBytes.length, true);
            lv.setUint16(26, nameBytes.length, true);
            lv.setUint16(28, 0, true);

            parts.push(new Uint8Array(localHeader), nameBytes, dataBytes);

            const centralHeader = new ArrayBuffer(46);
            const cv = new DataView(centralHeader);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0x0800, true);
            cv.setUint16(10, 0, true);
            cv.setUint16(12, dosTime, true);
            cv.setUint16(14, dosDate, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, dataBytes.length, true);
            cv.setUint32(24, dataBytes.length, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint16(30, 0, true);
            cv.setUint16(32, 0, true);
            cv.setUint16(34, 0, true);
            cv.setUint16(36, 0, true);
            cv.setUint32(38, 0, true);
            cv.setUint32(42, offset, true);

            centralRecords.push(new Uint8Array(centralHeader), nameBytes);
            offset += 30 + nameBytes.length + dataBytes.length;
        }

        let cdSize = 0;
        for (const rec of centralRecords) {
            cdSize += rec.length;
            parts.push(rec);
        }

        const eocd = new ArrayBuffer(22);
        const ev = new DataView(eocd);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, entries.length, true);
        ev.setUint16(10, entries.length, true);
        ev.setUint32(12, cdSize, true);
        ev.setUint32(16, offset, true);
        ev.setUint16(20, 0, true);
        parts.push(new Uint8Array(eocd));

        return new Blob(parts, { type: 'application/zip' });
    }

    // 解析範圍字串（例如 "1, 2, 4-12"）
    function parseRangeExpression(raw, maxIndex) {
        const trimmed = raw.trim();
        if (!trimmed) {
            return { ok: true, indices: new Set() };
        }
        const tokens = trimmed.split(/[\s,，、]+/).filter(Boolean);
        const indices = new Set();

        for (const token of tokens) {
            const singleMatch = token.match(/^(\d+)$/);
            if (singleMatch) {
                const n = Number(singleMatch[1]);
                if (n < 1 || n > maxIndex) {
                    return { ok: false, error: `編號 ${n} 超出本頁範圍 (1-${maxIndex})` };
                }
                indices.add(n);
                continue;
            }
            const rangeMatch = token.match(/^(\d+)-(\d+)$/);
            if (rangeMatch) {
                const start = Number(rangeMatch[1]);
                const end = Number(rangeMatch[2]);
                if (start < 1 || end > maxIndex || start > end) {
                    return { ok: false, error: `區間 "${token}" 無效或超出範圍 (1-${maxIndex})` };
                }
                for (let i = start; i <= end; i++) {
                    indices.add(i);
                }
                continue;
            }
            return { ok: false, error: `無法解析 "${token}"，請使用如 1, 2, 4-12 的格式` };
        }

        return { ok: true, indices };
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const timer = setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);

            function onAbort() {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    // 在每個綠色種子圖示旁加上快速下載鈕
    function injectInlineButtons(entries) {
        for (const entry of entries) {
            const link = entry.torrentLink;
            if (!link) continue;
            const parent = link.parentElement;
            if (!parent || parent.querySelector('.eh-quick-torrent-btn')) continue;

            const cs = getComputedStyle(parent);
            parent.style.width = 'auto';
            parent.style.display = 'inline-flex';
            parent.style.alignItems = 'center';
            parent.style.gap = '3px';
            parent.style.whiteSpace = 'nowrap';
            if (cs.position === 'absolute') {
                parent.style.right = 'auto';
            }

            const btn = document.createElement('a');
            btn.href = '#';
            btn.className = 'eh-quick-torrent-btn';
            btn.textContent = '⚡';
            btn.title = '直接下載最新種子 (.torrent)';
            btn.style.cssText = 'text-decoration:none; font-size:12px; line-height:1; cursor:pointer; display:inline-flex; align-items:center;';

            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (btn.dataset.busy === '1') return;

                btn.dataset.busy = '1';
                btn.textContent = '⏳';
                try {
                    const savedName = await downloadGalleryLatestTorrent(link.href);
                    btn.textContent = '✅';
                    btn.title = `已下載: ${savedName}`;
                } catch (err) {
                    btn.textContent = '❌';
                    btn.title = err.message;
                    console.error('[EH Auto Torrent]', err);
                } finally {
                    btn.dataset.busy = '0';
                }
            });

            parent.appendChild(btn);
        }
    }

    // 為每件作品加上連續編號與勾選框（支援 Shift 區間選取）
    function injectSelectionCheckboxes(entries, onSelectionChange) {
        let lastClickedIdx = null;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.mode === 'detail') continue;
            if (entry.container.querySelector('.eh-select-badge')) continue;

            const badge = document.createElement('label');
            badge.className = 'eh-select-badge';
            badge.style.cssText = [
                'display:inline-flex',
                'align-items:center',
                'gap:3px',
                'padding:1px 5px',
                'font-size:11px',
                'font-weight:bold',
                'border-radius:3px',
                'user-select:none',
                entry.torrentLink
                    ? 'background:#EDEBDF; color:#5C0D12; border:1px solid #5C0D12; cursor:pointer;'
                    : 'background:#E5E5E5; color:#888; border:1px solid #BBB; cursor:not-allowed;',
            ].join(';');

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'eh-select-checkbox';
            checkbox.disabled = !entry.torrentLink;
            checkbox.style.cssText = 'margin:0; cursor:inherit;';

            const text = document.createElement('span');
            text.textContent = entry.torrentLink ? `#${entry.index}` : `#${entry.index} (無種子)`;

            badge.addEventListener('click', (e) => e.stopPropagation());
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.shiftKey && lastClickedIdx !== null) {
                    const start = Math.min(lastClickedIdx, i);
                    const end = Math.max(lastClickedIdx, i);
                    const targetState = checkbox.checked;
                    for (let k = start; k <= end; k++) {
                        if (entries[k].checkbox && !entries[k].checkbox.disabled) {
                            entries[k].checkbox.checked = targetState;
                        }
                    }
                }
                lastClickedIdx = i;
                onSelectionChange();
            });

            badge.appendChild(checkbox);
            badge.appendChild(text);

            if (entry.mode === 'thumb') {
                if (getComputedStyle(entry.container).position === 'static') {
                    entry.container.style.position = 'relative';
                }
                badge.style.position = 'absolute';
                badge.style.top = '4px';
                badge.style.left = '4px';
                badge.style.zIndex = '10';
                badge.style.boxShadow = '0 1px 3px rgba(0,0,0,0.25)';
                entry.container.appendChild(badge);
            } else {
                const firstCell = entry.container.querySelector('td');
                if (firstCell) {
                    badge.style.marginBottom = '3px';
                    firstCell.insertBefore(badge, firstCell.firstChild);
                }
            }

            entry.checkbox = checkbox;
        }
    }

    // 在列表頁上方加上選取與批次下載控制列
    function injectBatchToolbar(entries) {
        const container = document.querySelector('.ido');
        if (!container || document.querySelector('#eh-batch-torrent-bar')) return;

        const torrentEntries = entries.filter((e) => e.torrentLink);
        if (torrentEntries.length === 0) return;

        const bar = document.createElement('div');
        bar.id = 'eh-batch-torrent-bar';
        bar.style.cssText = 'margin:6px auto; padding:8px 10px; border:1px solid #5C0D12; background:#EDEBDF; color:#5C0D12; font-size:9pt; display:flex; flex-direction:column; gap:6px; align-items:center;';

        const isListMode = entries.some((e) => e.mode !== 'detail');

        // 選取列
        const selectRow = document.createElement('div');
        selectRow.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:center;';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.textContent = '全選';

        const clearAllBtn = document.createElement('button');
        clearAllBtn.type = 'button';
        clearAllBtn.textContent = '全不選';

        const invertBtn = document.createElement('button');
        invertBtn.type = 'button';
        invertBtn.textContent = '反選';

        const rangeInput = document.createElement('input');
        rangeInput.type = 'text';
        rangeInput.placeholder = '輸入編號如 1, 2, 4-12';
        rangeInput.style.cssText = 'width:160px; padding:2px 6px; font-size:9pt;';

        const applyRangeBtn = document.createElement('button');
        applyRangeBtn.type = 'button';
        applyRangeBtn.textContent = '套用選取';

        const selectionSummary = document.createElement('span');
        selectionSummary.style.fontWeight = 'bold';

        // 動作列
        const actionRow = document.createElement('div');
        actionRow.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:center;';

        const zipBtn = document.createElement('button');
        zipBtn.type = 'button';
        zipBtn.style.cssText = 'padding:3px 10px; cursor:pointer; font-weight:bold;';

        const singleBatchBtn = document.createElement('button');
        singleBatchBtn.type = 'button';
        singleBatchBtn.style.cssText = 'padding:3px 10px; cursor:pointer;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding:3px 10px; cursor:pointer; display:none;';

        const status = document.createElement('span');
        status.textContent = '';

        function getSelectedEntries() {
            if (!isListMode) return torrentEntries;
            return entries.filter((e) => e.torrentLink && e.checkbox && e.checkbox.checked);
        }

        function refreshCounts() {
            const selected = getSelectedEntries();
            const count = selected.length;
            selectionSummary.textContent = `已選 ${count} / ${torrentEntries.length} 個有種子作品`;
            zipBtn.textContent = `打包下載已選 (.zip，${count} 個)`;
            singleBatchBtn.textContent = `逐一下載已選 (${count} 個)`;
            if (!activeController) {
                zipBtn.disabled = count === 0;
                singleBatchBtn.disabled = count === 0;
            }
        }

        let activeController = null;
        function setRunning(controller) {
            activeController = controller;
            const busy = !!controller;
            selectAllBtn.disabled = busy;
            clearAllBtn.disabled = busy;
            invertBtn.disabled = busy;
            rangeInput.disabled = busy;
            applyRangeBtn.disabled = busy;
            cancelBtn.style.display = busy ? 'inline-block' : 'none';
            if (busy) {
                zipBtn.disabled = true;
                singleBatchBtn.disabled = true;
            } else {
                refreshCounts();
            }
        }

        if (isListMode) {
            injectSelectionCheckboxes(entries, refreshCounts);

            selectAllBtn.addEventListener('click', () => {
                for (const e of torrentEntries) {
                    if (e.checkbox) e.checkbox.checked = true;
                }
                refreshCounts();
            });

            clearAllBtn.addEventListener('click', () => {
                for (const e of torrentEntries) {
                    if (e.checkbox) e.checkbox.checked = false;
                }
                refreshCounts();
            });

            invertBtn.addEventListener('click', () => {
                for (const e of torrentEntries) {
                    if (e.checkbox) e.checkbox.checked = !e.checkbox.checked;
                }
                refreshCounts();
            });

            const applyRange = () => {
                const parsed = parseRangeExpression(rangeInput.value, entries.length);
                if (!parsed.ok) {
                    status.textContent = parsed.error;
                    return;
                }
                let skippedNoTorrent = 0;
                for (const e of entries) {
                    if (!e.checkbox) continue;
                    const want = parsed.indices.has(e.index);
                    if (want && !e.torrentLink) {
                        skippedNoTorrent++;
                    } else if (!e.checkbox.disabled) {
                        e.checkbox.checked = want;
                    }
                }
                refreshCounts();
                status.textContent = skippedNoTorrent > 0
                    ? `已套用選取（其中 ${skippedNoTorrent} 個無種子已略過）`
                    : '';
            };

            applyRangeBtn.addEventListener('click', applyRange);
            rangeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    applyRange();
                }
            });

            selectRow.append(
                selectAllBtn,
                clearAllBtn,
                invertBtn,
                rangeInput,
                applyRangeBtn,
                selectionSummary
            );
            bar.appendChild(selectRow);
        }

        cancelBtn.addEventListener('click', () => {
            if (activeController) {
                activeController.abort();
            }
        });

        async function runBatch(mode) {
            if (activeController) return;
            const targets = getSelectedEntries();
            if (targets.length === 0) return;

            const controller = new AbortController();
            const { signal } = controller;
            setRunning(controller);

            const zipEntries = [];
            const usedNames = new Set();
            let ok = 0;
            let fail = 0;
            let stoppedReason = null;

            for (let i = 0; i < targets.length; i++) {
                if (signal.aborted) break;
                const entry = targets[i];
                const prefix = mode === 'zip' ? '預存中' : '下載中';
                status.textContent = `${prefix}：#${entry.index} (${i + 1} / ${targets.length}｜成功 ${ok}，失敗 ${fail})`;

                try {
                    if (mode === 'zip') {
                        const latest = await fetchLatestTorrentInfo(entry.torrentLink.href, signal);
                        const { filename, buffer } = await fetchTorrentData(latest, signal);
                        const zipEntryName = getUniqueZipFilename(usedNames, filename);
                        zipEntries.push({ name: zipEntryName, data: buffer });
                    } else {
                        await downloadGalleryLatestTorrent(entry.torrentLink.href, signal);
                    }
                    ok++;
                } catch (err) {
                    if (err && err.name === 'AbortError') {
                        stoppedReason = '已取消操作';
                        break;
                    }
                    fail++;
                    console.error(`[EH Auto Torrent] #${entry.index} 失敗:`, entry.torrentLink.href, err);
                    if (err instanceof RateLimitError) {
                        stoppedReason = err.message;
                        break;
                    }
                }

                if (i < targets.length - 1 && !signal.aborted) {
                    try {
                        await sleep(BATCH_DELAY_MS, signal);
                    } catch (err) {
                        if (err && err.name === 'AbortError') {
                            stoppedReason = '已取消操作';
                            break;
                        }
                    }
                }
            }

            if (signal.aborted || stoppedReason === '已取消操作') {
                status.textContent = `已取消（已完成 ${ok} 個，未觸發壓縮下載）`;
            } else if (mode === 'zip' && ok > 0) {
                status.textContent = `正在產生壓縮檔 (共 ${ok} 個種子)...`;
                try {
                    const zipBlob = buildZipBlob(zipEntries);
                    const zipName = buildZipArchiveName();
                    triggerBrowserDownload(zipBlob, zipName);
                    status.textContent = stoppedReason
                        ? `${stoppedReason}｜已將目前完成的 ${ok} 個打包 (${zipName})`
                        : `打包完成！成功 ${ok} 個，失敗 ${fail} 個 (${zipName})`;
                } catch (err) {
                    status.textContent = `產生壓縮檔失敗：${err.message}`;
                    console.error('[EH Auto Torrent] ZIP 產生失敗:', err);
                }
            } else if (stoppedReason) {
                status.textContent = `${stoppedReason}（成功 ${ok}，失敗 ${fail}）`;
            } else {
                status.textContent = `完成！成功 ${ok} 個，失敗 ${fail} 個`;
            }

            setRunning(null);
        }

        zipBtn.addEventListener('click', () => runBatch('zip'));
        singleBatchBtn.addEventListener('click', () => runBatch('single'));

        actionRow.append(zipBtn, singleBatchBtn, cancelBtn, status);
        bar.appendChild(actionRow);
        container.insertBefore(bar, container.firstChild);

        refreshCounts();
    }

    function init() {
        const entries = getGalleryEntries();
        if (entries.length === 0) return;
        injectInlineButtons(entries);
        injectBatchToolbar(entries);
    }

    init();
})();

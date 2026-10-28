// ==UserScript==
// @name         Instagram Save
// @namespace    https://arda0.net/
// @version      0.8.2
// @description  Download button for Instagram posts: saves the photo or video on display (the current slide of a carousel, a reel, or the open story or highlight) at the best quality Instagram offers.
// @updateURL    https://arda0.net/ig-save.user.js
// @downloadURL  https://arda0.net/ig-save.user.js
// @match        https://www.instagram.com/*
// @grant        GM_download
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const APP_ID = "936619743392459"; // the web app's public ID, sent by instagram.com itself
    const BTN_CLASS = "igSaveBtn";
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    let busy = false;

    console.log("[IG Save] 0.8.2 loaded");

    // The shortcode in a post link is the media ID written in base 64.
    function shortcodeToId(code) {
        let id = 0n;
        for (const ch of code) id = id * 64n + BigInt(ALPHABET.indexOf(ch));
        return id.toString();
    }

    // Post links look like /p/CODE/ or /username/p/CODE/; reels like /reel/CODE/ or /reels/CODE/.
    function codeFromPath(path) {
        const m = path.match(/\/(?:p|reels?)\/([\w-]+)/);
        return m ? m[1] : null;
    }

    async function igGet(path) {
        const r = await fetch(`https://www.instagram.com${path}`, {
            credentials: "include",
            headers: { "X-IG-App-ID": APP_ID, "X-Requested-With": "XMLHttpRequest" },
        });
        if (!r.ok) {
            const e = new Error(r.status === 429
                ? "Instagram is limiting requests (HTTP 429). Wait a few minutes, then try again."
                : `Instagram answered HTTP ${r.status}`);
            e.status = r.status;
            throw e;
        }
        return r.json();
    }

    async function fetchMedia(id) {
        const item = (await igGet(`/api/v1/media/${id}/info/`)).items?.[0];
        if (!item) throw new Error("no post in reply");
        return item;
    }

    // The file name of a picture URL, which stays the same across Instagram's sizes of one picture.
    function fileName(url) {
        try { return new URL(url).pathname.split("/").pop(); } catch (e) { return null; }
    }

    // media_type: 1 = photo, 2 = video, 8 = carousel. Returns the slide on display (a single post has one).
    // `index` is the slide number from the dots under the post, if there are any. Otherwise `shown`
    // ({src, delta}: a picture on screen and how many slides the displayed one is after it) is matched to the
    // post's files, then the ?img_index= of the address is tried, then the first slide.
    function slideOf(item, index, shown) {
        const parts = item.media_type === 8 ? item.carousel_media : [item];
        let i = 0;
        if (index != null) {
            i = index;
        } else {
            const file = shown && fileName(shown.src);
            const hit = file ? parts.findIndex((p) => p.image_versions2?.candidates?.some((c) => fileName(c.url) === file)) : -1;
            if (hit >= 0) i = hit + shown.delta;
            else i = (parseInt(new URLSearchParams(location.search).get("img_index"), 10) || 1) - 1;
        }
        i = Math.max(0, Math.min(i, parts.length - 1));
        return { part: parts[i], number: i + 1, total: parts.length };
    }

    // The largest file of a slide, as {url, ext}, or null. Both lists are sorted largest first, but pick by size anyway.
    // Videos are progressive MP4 files with the sound included.
    function bestFile(part) {
        const largest = (list) => list.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)).url;
        if (part.media_type === 2 && part.video_versions?.length) return { url: largest(part.video_versions), ext: "mp4" };
        if (part.media_type === 1 && part.image_versions2?.candidates?.length) return { url: largest(part.image_versions2.candidates), ext: "jpg" };
        return null;
    }

    function save(url, name) {
        return new Promise((resolve, reject) =>
            GM_download({ url, name, onload: resolve, onerror: (e) => reject(new Error(e?.error || "download failed")), ontimeout: () => reject(new Error("timed out")) })
        );
    }

    // target is {code, index} for a normal post (index() = the slide on display), {story: true} for the open story,
    // or {img} for a post without a link (ads).
    async function run(target, say) {
        if (busy) return;
        busy = true;
        say("Working...", 0, "working");
        try {
            if (!target.code && !target.story && !target.img) throw new Error("Open a post or reel first.");
            if (!target.code && !target.story) {
                await save(target.img, `instagram_${Date.now()}.jpg`);
                return say("Saved 1 (as shown on screen)", 6000, "ok");
            }
            // A post is named by its shortcode, a story by its media ID.
            let code = target.code;
            let item;
            if (target.story) ({ item, code } = await fetchStory(activeStoryCard()));
            else item = await fetchMedia(shortcodeToId(code));
            const { part, number, total } = slideOf(item, target.story ? 0 : target.index(), target.shown?.());
            const file = bestFile(part);
            if (!file) throw new Error("No downloadable photo or video found in this post.");
            const user = item.user?.username || "instagram";
            await save(file.url, `${user}_${code}${total > 1 ? `_${number}` : ""}.${file.ext}`);
            say(total > 1 ? `Saved ${number} of ${total}` : "Saved", 6000, "ok");
        } catch (e) {
            console.error("[IG Save]", e);
            say(e.message, 8000, "error");
        } finally {
            busy = false;
        }
    }

    // ------------------------------------------------------------------- button

    function makeButton(target) {
        const b = document.createElement("button");
        b.className = BTN_CLASS;
        b.type = "button";
        b.textContent = "Save";
        b.title = "Download this post";
        Object.assign(b.style, {
            padding: "0 10px", height: "28px", margin: "0 8px", border: "0", borderRadius: "14px",
            background: "#2563eb", color: "#fff", font: "600 13px system-ui, sans-serif", cursor: "pointer",
        });
        let timer;
        const say = (msg, ms, state) => {
            b.title = msg;
            b.disabled = state === "working";
            b.style.opacity = b.disabled ? "0.5" : "1";
            b.textContent = state === "working" ? "..." : state === "ok" ? "Saved" : state === "error" ? "Failed" : "Save";
            clearTimeout(timer);
            if (ms) timer = setTimeout(() => { b.textContent = "Save"; b.title = "Download this post"; }, ms);
        };
        b.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            run(target, say);
        });
        return b;
    }

    // The action bar is the section that holds the like button. Its labels depend on the page language.
    const LIKE = /^(like|unlike|beğen|beğenmekten vazgeç)$/i;
    function actionBar(root) {
        for (const svg of root.querySelectorAll("svg[aria-label]")) {
            if (LIKE.test(svg.getAttribute("aria-label"))) return svg.closest("section");
        }
        return null;
    }

    // The active dot under a carousel has aria-current="step"; its position among the dots is the slide number.
    function slideIndex(post) {
        const dot = post.querySelector('[aria-current="step"]');
        return dot ? [...dot.parentElement.children].indexOf(dot) : null;
    }

    // The slide in view, as a picture of the post that is on screen and the distance from it to that slide.
    // The slide in view may be a video (no picture to match), so a neighboring picture is the reference.
    // Instagram draws only the slides next to the one in view, always in order, so the distance is exact.
    function shownSlide(post) {
        const items = [];
        for (const el of post.querySelectorAll("img, video")) {
            const r = el.getBoundingClientRect();
            if (r.width < 200 || r.height < 200) continue; // avatars and icons
            const slide = el.closest("li") || el;
            if (items.some((x) => x.slide === slide)) continue;
            const vis = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
            items.push({ el, slide, vis });
        }
        if (!items.length) return null;
        const cur = items.reduce((a, b) => (b.vis > a.vis ? b : a));
        const ci = items.indexOf(cur);
        let ai = -1;
        items.forEach((x, k) => {
            if (x.el.tagName === "IMG" && (ai < 0 || Math.abs(k - ci) < Math.abs(ai - ci))) ai = k;
        });
        return ai < 0 ? null : { src: items[ai].el.currentSrc || items[ai].el.src, delta: ci - ai };
    }

    // ------------------------------------------------------------------ stories

    // Story cards sit side by side in a slider; the open one is the biggest.
    function activeStoryCard() {
        let best = null;
        for (const c of document.querySelectorAll('div[style*="translateX(calc(-50%"]')) {
            if (!best || c.offsetHeight > best.offsetHeight) best = c;
        }
        return best;
    }

    // A photo story's picture URL carries its media ID: ig_cache_key = base64("<id>") + ".3-ccb7-5".
    function storyIdOf(card) {
        for (const img of card.querySelectorAll("img[src*='ig_cache_key=']")) {
            try {
                const id = atob(new URL(img.src).searchParams.get("ig_cache_key").split(".")[0]);
                if (/^\d+$/.test(id)) return id;
            } catch (e) { /* not an ID, try the next picture */ }
        }
        return null;
    }

    // Account IDs and story lists are remembered for a minute, so saving several stories makes few requests.
    const userIds = new Map();
    const storyLists = new Map(); // name -> {at, items}

    async function userIdOf(name) {
        if (userIds.has(name)) return userIds.get(name);
        // The stories tray lists everyone who has a story with their IDs: one request covers many accounts.
        try {
            for (const t of (await igGet("/api/v1/feed/reels_tray/")).tray || []) {
                const n = t.user?.username, id = t.user?.pk || t.id;
                if (n && id) userIds.set(n, String(id));
            }
        } catch (e) {
            if (e.status === 429) throw e;
            console.warn("[IG Save] stories tray failed, trying the profile lookup", e);
        }
        if (!userIds.has(name)) {
            // Not in the tray (an account you do not follow): the profile lookup is the strictest-limited call.
            const id = (await igGet(`/api/v1/users/web_profile_info/?username=${name}`)).data?.user?.id;
            if (!id) throw new Error("Could not find the account.");
            userIds.set(name, String(id));
        }
        return userIds.get(name);
    }

    // The items of a story reel: an account's active stories (reel ID = account ID) or a highlight ("highlight:ID").
    async function reelItems(reelId) {
        const hit = storyLists.get(reelId);
        if (hit && Date.now() - hit.at < 60000) return hit.items;
        const reel = await igGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`);
        const items = reel.reels_media?.[0]?.items || reel.reels?.[reelId]?.items || [];
        storyLists.set(reelId, { at: Date.now(), items });
        return items;
    }

    const storyList = async (name) => reelItems(await userIdOf(name));

    // The story on display, as {item, code}. A video story shows only a blob: video, so the picture has no ID.
    // Then use the ID in the page address (/stories/name/ID/). Failing that, take the story list (the account's
    // active stories, or the highlight in /stories/highlights/ID/) and pick the story whose time matches the card's <time>.
    async function fetchStory(card) {
        if (!card) throw new Error("No story is open.");
        const id = storyIdOf(card);
        if (id) return { item: await fetchMedia(id), code: id };
        const pathId = location.pathname.match(/^\/stories\/(?!highlights\/)[^/]+\/(\d+)/)?.[1];
        if (pathId) {
            try {
                return { item: await fetchMedia(pathId), code: pathId };
            } catch (e) {
                if (e.status === 429) throw e;
                console.warn("[IG Save] story lookup by address failed, trying the story list", e);
            }
        }
        const name = card.querySelector('a[href^="/"]')?.getAttribute("href").split("/").filter(Boolean)[0];
        const time = Date.parse(card.querySelector("time")?.getAttribute("datetime"));
        if (!name || !time) throw new Error("Could not tell which story is open.");
        const highlight = location.pathname.match(/^\/stories\/highlights\/(\d+)/)?.[1];
        const items = highlight ? await reelItems(`highlight:${highlight}`) : await storyList(name);
        const item = items.find((it) => it.taken_at * 1000 === time);
        if (!item) throw new Error("This story is not in the account's story list.");
        item.user = item.user || { username: name };
        return { item, code: String(item.pk || item.id).split("_")[0] };
    }

    // One floating button over the open story. It stays outside Instagram's own elements,
    // because Instagram redraws those while a story plays.
    let storyBtn = null;
    function ensureStories() {
        const card = activeStoryCard();
        if (!card) return storyBtn && (storyBtn.remove(), (storyBtn = null));
        if (!storyBtn || !storyBtn.isConnected) {
            storyBtn = makeButton({ story: true });
            Object.assign(storyBtn.style, { position: "fixed", zIndex: "2147483647", margin: "0" });
            document.body.appendChild(storyBtn);
        }
        const r = card.getBoundingClientRect();
        storyBtn.style.top = `${r.top + 60}px`;
        storyBtn.style.left = `${r.right - storyBtn.offsetWidth - 8}px`;
    }
    setInterval(() => {
        if (location.pathname.startsWith("/stories/")) ensureStories();
        else if (storyBtn) { storyBtn.remove(); storyBtn = null; }
    }, 300);

    // ------------------------------------------------------------------- reels

    // A reel has no stable action bar, so it gets a floating button over the video in view.
    // The reel is named by the page address, which changes as you scroll between reels.
    let reelBtn = null;
    function activeReelVideo() {
        let best = null, bestVis = 0;
        for (const v of document.querySelectorAll("video")) {
            const r = v.getBoundingClientRect();
            const vis = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
            if (vis > bestVis) { best = v; bestVis = vis; }
        }
        return best;
    }
    function ensureReels() {
        const video = codeFromPath(location.pathname) && activeReelVideo();
        if (!video) return reelBtn && (reelBtn.remove(), (reelBtn = null));
        if (!reelBtn || !reelBtn.isConnected) {
            reelBtn = makeButton({ get code() { return codeFromPath(location.pathname); }, index: () => 0 });
            Object.assign(reelBtn.style, { position: "fixed", zIndex: "2147483647", margin: "0" });
            document.body.appendChild(reelBtn);
        }
        const r = video.getBoundingClientRect();
        reelBtn.style.top = `${Math.max(r.top, 0) + 60}px`;
        reelBtn.style.left = `${Math.min(r.right, innerWidth) - reelBtn.offsetWidth - 8}px`;
    }
    setInterval(() => {
        if (/^\/reels?\//.test(location.pathname)) ensureReels();
        else if (reelBtn) { reelBtn.remove(); reelBtn = null; }
    }, 300);

    // The bar's first child is a flex row: like, comment, repost, share. Instagram's own save icon sits outside it.
    function placeButton(bar, btn) {
        (bar.firstElementChild || bar).appendChild(btn);
    }

    // Feed posts are <article>s; a post page has one <article> too.
    function ensure() {
        if (location.pathname.startsWith("/stories/") || /^\/reels?\//.test(location.pathname)) return;
        for (const post of document.querySelectorAll("article")) {
            if (post.querySelector(`.${BTN_CLASS}`)) continue;
            const link = post.querySelector('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]');
            const code = link ? codeFromPath(new URL(link.href).pathname) : codeFromPath(location.pathname);
            const img = post.querySelector("._aagu img");
            // Ads have no post link at all, so use their image.
            if (!code && !img) continue;
            const bar = actionBar(post);
            if (bar) placeButton(bar, makeButton(code ? { code, index: () => slideIndex(post), shown: () => shownSlide(post) } : { img: img.currentSrc || img.src }));
        }
    }
    new MutationObserver(ensure).observe(document.body, { childList: true, subtree: true });
    ensure();
})();

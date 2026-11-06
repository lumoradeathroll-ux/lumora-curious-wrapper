import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// --- 🎛️ THE MANAGER (Toggle via Telegram) ---
// Use /envrepo <id> ENABLE_CONSUMET false to turn it off.
const MANAGER = {
    enableCurious: process.env.ENABLE_CURIOUS !== 'false',
    enableConsumet: process.env.ENABLE_CONSUMET !== 'false',
    enableStremio: process.env.ENABLE_STREMIO !== 'false',
    // Add Stremio manifest URLs here or via environment variables
    stremioManifests: (process.env.STREMIO_URLS || 'https://torrentio.strem.fun').split(',')
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    
    // 1. Health Check
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
    }

    // 2. Manager Status (You can view this in /logsrepo)
    if (parsedUrl.pathname === '/manager') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(MANAGER, null, 2));
    }

    // 3. Resolve Endpoint
    if (parsedUrl.pathname === '/lumora/v1/resolve') {
        const query = parsedUrl.searchParams;
        const type = query.get('type');
        const imdb = query.get('imdb');
        const title = query.get('title');
        const season = query.get('season');
        const episode = query.get('episode');

        if (!imdb) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'IMDb ID is required.' }));
        }

        try {
            const promises = [];

            // 🟢 Path 1: Curious APIs
            if (MANAGER.enableCurious) {
                promises.push(getCuriousSources(imdb, type, season, episode));
            }

            // 🟢 Path 2: Consumet (Anime & Movies API)
            if (MANAGER.enableConsumet && title) {
                promises.push(getConsumetSources(title, type, season, episode));
            }

            // 🟢 Path 3: Stremio Add-ons (Torrentio, etc.)
            if (MANAGER.enableStremio) {
                promises.push(getStremioSources(imdb, type, season, episode));
            }

            // Execute all active providers in parallel
            const results = await Promise.allSettled(promises);
            
            let allSources = [];
            for (const result of results) {
                if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                    allSources.push(...result.value);
                }
            }

            // Deduplicate by URL
            const uniqueSources = Array.from(new Map(allSources.map(s => [s.url, s])).values());

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sources: uniqueSources }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    res.writeHead(404);
    res.end();
});

// ==========================================
// 🛠️ PROVIDER IMPLEMENTATIONS
// ==========================================

// Provider 1: Curious APIs
async function getCuriousSources(imdb, type, season, episode) {
    let sources = [];
    try {
        const base = 'https://curiousapis.name.ng/stream_movies';
        const url = type === 'movie' 
            ? `${base}/movies/stream/movie?id=${imdb}`
            : `${base}/movies/stream/tv?id=${imdb}&season=${season}&episode=${episode}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data && data.sources) {
            sources = data.sources.map(s => ({
                label: "Curious API",
                type: s.url?.includes('.m3u8') ? 'hls' : 'mp4',
                url: s.url,
                quality: s.quality || "1080p",
                lang: "en"
            }));
        }
    } catch (e) { console.error("Curious error:", e.message); }
    return sources;
}

// Provider 2: Consumet API (Great for Anime)
async function getConsumetSources(title, type, season, episode) {
    let sources = [];
    try {
        // We use the title because Consumet requires a search string
        const searchUrl = `https://api.consumet.org/anime/gogoanime/${encodeURIComponent(title)}`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();

        if (searchData.results && searchData.results.length > 0) {
            const animeId = searchData.results[0].id;
            // Get the stream (assuming episode 1 if it's a movie, or the specific episode)
            const ep = type === 'movie' ? 1 : (episode || 1);
            const streamUrl = `https://api.consumet.org/anime/gogoanime/watch/${animeId}-episode-${ep}`;
            
            const streamRes = await fetch(streamUrl);
            const streamData = await streamRes.json();

            if (streamData.sources) {
                sources = streamData.sources.map(s => ({
                    label: "Consumet Anime",
                    type: "hls",
                    url: s.url,
                    quality: s.quality || "auto",
                    lang: "ja" // Usually subbed
                }));
            }
        }
    } catch (e) { console.error("Consumet error:", e.message); }
    return sources;
}

// Provider 3: Stremio Bridge
async function getStremioSources(imdb, type, season, episode) {
    let sources = [];
    
    // Stremio uses a specific ID format: tt123456 (movie) or tt123456:1:1 (series)
    const stremioId = type === 'movie' ? imdb : `${imdb}:${season}:${episode}`;
    const stremioType = type === 'movie' ? 'movie' : 'series';

    for (const manifest of MANAGER.stremioManifests) {
        try {
            // Request the stream from the Stremio addon
            const url = `${manifest}/stream/${stremioType}/${stremioId}.json`;
            const response = await fetch(url);
            const data = await response.json();

            if (data && data.streams) {
                const parsed = data.streams.map(s => {
                    // Stremio streams can be torrents, URLs, or external links
                    // We prefer direct URLs or infoHash (if Lumora supports it, though Lumora usually prefers direct URLs)
                    const streamUrl = s.url || s.externalUrl;
                    if (!streamUrl) return null;

                    return {
                        label: s.name || "Stremio Source",
                        type: streamUrl.includes('.m3u8') ? 'hls' : 'mp4',
                        url: streamUrl,
                        quality: s.title || "Unknown",
                        lang: "en"
                    };
                }).filter(Boolean);
                
                sources.push(...parsed);
            }
        } catch (e) { 
            console.error(`Stremio error (${manifest}):`, e.message); 
        }
    }
    return sources;
}

server.listen(PORT, HOST, () => {
    console.log(`Lumora Ultimate Manager running on ${PORT}`);
    console.log(`Active Providers:`, MANAGER);
});

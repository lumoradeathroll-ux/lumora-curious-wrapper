import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const MANAGER = {
    enableCurious: process.env.ENABLE_CURIOUS !== 'false',
    enableStremio: process.env.ENABLE_STREMIO !== 'false',
    stremioManifests: (process.env.STREMIO_URLS || 'https://torrentio.strem.fun').split(',')
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200); return res.end('OK');
    }

    if (parsedUrl.pathname === '/lumora/v1/resolve') {
        const q = parsedUrl.searchParams;
        const type = q.get('type');
        const imdb = q.get('imdb');
        const season = q.get('season');
        const episode = q.get('episode');

        if (!imdb) { res.writeHead(400); return res.end('{"error":"IMDb ID required"}'); }

        try {
            const promises = [];
            if (MANAGER.enableCurious) promises.push(getCuriousSources(imdb, type, season, episode));
            if (MANAGER.enableStremio) promises.push(getStremioSources(imdb, type, season, episode));

            const results = await Promise.allSettled(promises);
            let allSources = [];
            for (const r of results) {
                if (r.status === 'fulfilled' && Array.isArray(r.value)) allSources.push(...r.value);
            }

            const unique = Array.from(new Map(allSources.map(s => [s.url, s])).values());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sources: unique }));
        } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    res.writeHead(404); res.end();
});

// --- PROVIDER 1: Curious APIs ---
async function getCuriousSources(imdb, type, season, episode) {
    let sources = [];
    try {
        const base = 'https://curiousapis.name.ng/stream_movies';
        const url = type === 'movie' ? `${base}/movies/stream/movie?id=${imdb}` : `${base}/movies/stream/tv?id=${imdb}&season=${season}&episode=${episode}`;
        const r = await fetch(url);
        const d = await r.json();
        if (d && d.sources) {
            sources = d.sources.map(s => ({
                label: "Curious", type: s.url?.includes('.m3u8') ? 'hls' : 'mp4', url: s.url, quality: s.quality || "1080p", lang: "en"
            }));
        }
    } catch (e) { console.error("Curious error:", e.message); }
    return sources;
}

// --- PROVIDER 2: Stremio (Torrentio) ---
async function getStremioSources(imdb, type, season, episode) {
    let sources = [];
    const sType = type === 'movie' ? 'movie' : 'series';
    const sId = type === 'movie' ? imdb : `${imdb}:${season}:${episode}`;

    for (const manifest of MANAGER.stremioManifests) {
        try {
            const url = `${manifest}/stream/${sType}/${sId}.json`;
            const r = await fetch(url);
            const d = await r.json();

            if (d && d.streams) {
                const parsed = d.streams.map(s => {
                    // Torrentio returns infoHash. We must convert it to a magnet link for Lumora.
                    let streamUrl = s.url;
                    if (!streamUrl && s.infoHash) {
                        streamUrl = `magnet:?xt=urn:btih:${s.infoHash}`;
                    }
                    if (!streamUrl) return null;

                    return {
                        label: s.name ? s.name.replace(/\n/g, ' ') : "Torrentio", // Clean up newlines
                        type: streamUrl.includes('.m3u8') ? 'hls' : 'mp4',
                        url: streamUrl,
                        quality: s.title || "Unknown",
                        lang: "en"
                    };
                }).filter(Boolean);
                sources.push(...parsed);
            }
        } catch (e) { console.error(`Stremio error:`, e.message); }
    }
    return sources;
}

server.listen(PORT, HOST, () => console.log(`Wrapper running on ${PORT}`));

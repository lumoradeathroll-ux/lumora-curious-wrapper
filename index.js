import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const MANAGER = {
    enableCurious: process.env.ENABLE_CURIOUS !== 'false',
    enableStremio: process.env.ENABLE_STREMIO !== 'false',
    stremioManifests: (process.env.STREMIO_URLS || '').split(',').filter(Boolean),
    proxyUrl: process.env.PROXY_URL || '',
    proxyPassword: process.env.PROXY_PASSWORD || ''
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    
    // 1. Health Check
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
    }

    // 2. Resolve Endpoint
    if (parsedUrl.pathname === '/lumora/v1/resolve') {
        const q = parsedUrl.searchParams;
        const type = q.get('type');
        const imdb = q.get('imdb');
        const season = q.get('season');
        const episode = q.get('episode');

        if (!imdb) { 
            res.writeHead(400, { 'Content-Type': 'application/json' }); 
            return res.end('{"error":"IMDb ID required"}'); 
        }

        try {
            const promises = [];
            if (MANAGER.enableCurious) promises.push(getCuriousSources(imdb, type, season, episode));
            if (MANAGER.enableStremio) promises.push(getStremioSources(imdb, type, season, episode));

            const results = await Promise.allSettled(promises);
            let allSources = [];
            
            for (const r of results) {
                if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                    allSources.push(...r.value);
                }
            }

            // Deduplicate by URL
            const unique = Array.from(new Map(allSources.map(s => [s.url, s])).values());
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sources: unique }));
            
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' }); 
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    res.writeHead(404); 
    res.end();
});

// 🛠️ The Fixed Proxy Function
function applyProxy(originalUrl) {
    if (!MANAGER.proxyUrl || !MANAGER.proxyPassword) return originalUrl;
    
    // Remove trailing slash if it exists
    const proxyBase = MANAGER.proxyUrl.replace(/\/$/, '');
    
    // MediaFlow requires specific paths for different video types
    let endpoint = '/proxy/stream'; 
    if (originalUrl.includes('.m3u8')) {
        endpoint = '/proxy/hls/manifest.m3u8';
    }
    
    return `${proxyBase}${endpoint}?url=${encodeURIComponent(originalUrl)}&api_password=${MANAGER.proxyPassword}`;
}

// --- PROVIDER 1: Curious APIs ---
async function getCuriousSources(imdb, type, season, episode) {
    let sources = [];
    try {
        const base = 'https://curiousapis.name.ng/stream_movies';
        const url = type === 'movie' 
            ? `${base}/movies/stream/movie?id=${imdb}` 
            : `${base}/movies/stream/tv?id=${imdb}&season=${season}&episode=${episode}`;
        
        console.log(`[Curious] Fetching: ${url}`);
        const r = await fetch(url);
        const d = await r.json();
        
        if (d && d.sources) {
            sources = d.sources.map(s => ({
                label: "Curious", 
                type: s.url?.includes('.m3u8') ? 'hls' : 'mp4', 
                url: applyProxy(s.url), 
                quality: s.quality || "1080p", 
                lang: "en"
            }));
        }
    } catch (e) { 
        console.error("[Curious] Error:", e.message); 
    }
    return sources;
}

// --- PROVIDER 2: Stremio Addons (PenguPlay) ---
async function getStremioSources(imdb, type, season, episode) {
    let sources = [];
    const sType = type === 'movie' ? 'movie' : 'series';
    const sId = type === 'movie' ? imdb : `${imdb}:${season}:${episode}`;

    if (!MANAGER.stremioManifests[0]) return sources;

    for (const manifest of MANAGER.stremioManifests) {
        try {
            const url = `${manifest}/stream/${sType}/${sId}.json`;
            console.log(`[Stremio] Fetching: ${url}`);
            const r = await fetch(url);
            
            // Check for HTML errors (Cloudflare blocks, etc.)
            const contentType = r.headers.get("content-type");
            if (contentType && contentType.includes("text/html")) {
                console.log(`[Stremio] Skipping ${manifest} (returned HTML)`);
                continue; 
            }

            const d = await r.json();

            if (d && d.streams) {
                const parsed = d.streams.map(s => {
                    let streamUrl = s.url;
                    if (!streamUrl && s.infoHash) streamUrl = `magnet:?xt=urn:btih:${s.infoHash}`;
                    if (!streamUrl || streamUrl.startsWith('magnet:')) return null;
                    
                    return {
                        label: s.name ? s.name.replace(/\n/g, ' ') : "HTTP Stream",
                        type: streamUrl.includes('.m3u8') ? 'hls' : 'mp4',
                        url: applyProxy(streamUrl), 
                        quality: s.title || "Unknown",
                        lang: "en"
                    };
                }).filter(Boolean);
                
                console.log(`[Stremio] Found ${parsed.length} playable streams.`);
                sources.push(...parsed);
            }
        } catch (e) { 
            console.error(`[Stremio] Error:`, e.message); 
        }
    }
    return sources;
}

server.listen(PORT, HOST, () => console.log(`Wrapper running on ${HOST}:${PORT}`));

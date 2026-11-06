import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    
    // 1. Health Check
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
    }

    // 2. Resolve Endpoint
    if (parsedUrl.pathname === '/lumora/v1/resolve') {
        const type = parsedUrl.searchParams.get('type');
        const imdb = parsedUrl.searchParams.get('imdb');
        const tmdb = parsedUrl.searchParams.get('tmdb');
        const season = parsedUrl.searchParams.get('season');
        const episode = parsedUrl.searchParams.get('episode');

        if (!imdb) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'IMDb ID is required for this source.' }));
        }

        try {
            let sources = [];
            if (type === 'movie') {
                sources = await getMovieSources(imdb);
            } else if (type === 'tv') {
                sources = await getTVSources(imdb, season, episode);
            }

            // Return in Lumora's contract format
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sources }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // 404 Fallback
    res.writeHead(404);
    res.end();
});

// --- HELPER FUNCTIONS ---

async function getMovieSources(imdbId) {
    let sources = [];
    try {
        const apiUrl = `https://curiousapis.name.ng/stream_movies/movies/stream/movie?id=${imdbId}`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        // ⚠️ YOU MUST VERIFY THIS MAPPING ⚠️
        // I am guessing the structure based on standard APIs. 
        // If data.sources is undefined, look at what the API actually returns and adjust this.
        if (data && data.sources && Array.isArray(data.sources)) {
            sources = data.sources.map(s => ({
                label: "Curious Stream",
                type: s.url && s.url.includes('.m3u8') ? 'hls' : 'mp4',
                url: s.url,
                quality: s.quality || "1080p",
                lang: "en"
            }));
        }
    } catch (e) {
        console.error("Stream Movies API failed:", e.message);
    }
    return sources;
}

async function getTVSources(imdbId, season, episode) {
    let sources = [];
    try {
        const apiUrl = `https://curiousapis.name.ng/stream_movies/movies/stream/tv?id=${imdbId}&season=${season}&episode=${episode}`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        // ⚠️ YOU MUST VERIFY THIS MAPPING ⚠️
        if (data && data.sources && Array.isArray(data.sources)) {
            sources = data.sources.map(s => ({
                label: "Curious TV",
                type: s.url && s.url.includes('.m3u8') ? 'hls' : 'mp4',
                url: s.url,
                quality: s.quality || "1080p",
                lang: "en"
            }));
        }
    } catch (e) {
        console.error("Stream TV API failed:", e.message);
    }
    return sources;
}

// Start Server
server.listen(PORT, HOST, () => {
    console.log(`Lumora Source Repo running at http://${HOST}:${PORT}`);
});

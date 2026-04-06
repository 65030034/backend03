const express = require('express');
const cors = require('cors');
const tls = require('tls');
const { simpleParser } = require('mailparser');

const app = express();
const IMAP_HOST = 'imap.smtp.dev';
const IMAP_PORT = 993;

app.use(cors({
    origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'https://unipony-03.netlify.app'
    ],
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-imap-user', 'x-imap-pass'],
    credentials: true
}));
app.use(express.json());

// ─────────────────────────────────────────────────────────
// 🔧 Core: Raw TLS IMAP session
//    Runs a sequence of commands and returns results.
//    cb(send, line, close) — called for every server line.
// ─────────────────────────────────────────────────────────
function imapSession(user, pass, cb) {
    return new Promise((resolve, reject) => {
        const sock = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, rejectUnauthorized: false });
        let buf = '';
        let tagN = 1;
        const results = {};

        const send = (cmd) => {
            const t = `M${tagN++}`;
            sock.write(`${t} ${cmd}\r\n`);
            return t;
        };
        const close = (data) => { results._final = data; sock.destroy(); };

        sock.setTimeout(20000, () => { sock.destroy(); reject(new Error('IMAP timeout')); });
        sock.on('error', reject);
        sock.on('close', () => resolve(results));

        let greeted = false;
        sock.on('data', chunk => {
            buf += chunk.toString();
            while (true) {
                const idx = buf.indexOf('\r\n');
                if (idx === -1) break;
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);

                if (!greeted && line.startsWith('* OK')) {
                    greeted = true;
                    const loginTag = send(`LOGIN ${user} ${pass}`);
                    cb(send, `__LOGIN_TAG__ ${loginTag}`, close, results);
                } else {
                    cb(send, line, close, results);
                }
            }
        });
    });
}

// ─────────────────────────────────────────────────────────
// 🔧 MIME decoder
// ─────────────────────────────────────────────────────────
function decodeMime(str) {
    if (!str) return '';
    str = str.replace(/\r?\n[ \t]+/g, ' ');
    return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, encoded) => {
        try {
            if (enc.toUpperCase() === 'B') {
                return Buffer.from(encoded, 'base64').toString('utf-8');
            } else {
                const qp = encoded.replace(/_/g, ' ')
                    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
                return Buffer.from(qp, 'latin1').toString('utf-8');
            }
        } catch { return encoded; }
    });
}

// ─────────────────────────────────────────────────────────
// 1. POST /api/login
// ─────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        await imapSession(email, password, (send, line, close, results) => {
            if (line.startsWith('M1 OK')) { results.ok = true; send('LOGOUT'); }
            if (line.startsWith('M2 OK') || line.startsWith('* BYE')) close();
            if (line.startsWith('M1 NO') || line.startsWith('M1 BAD')) {
                results.err = line; close();
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(401).json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────
// 2. GET /api/folders
// ─────────────────────────────────────────────────────────
app.get('/api/folders', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    let loginTag, listTag, logoutTag;
    const folders = [];

    try {
        await imapSession(user, pass, (send, line, close, results) => {
            if (line.startsWith('__LOGIN_TAG__')) { loginTag = line.split(' ')[1]; return; }
            if (loginTag && line.startsWith(`${loginTag} OK`)) {
                listTag = send('LIST "" "*"');
            }
            if (line.startsWith('* LIST')) {
                const m = line.match(/\* LIST \([^)]*\) "?" "?([^"]+)"?$/);
                if (m) folders.push({ name: m[1], path: m[1] });
            }
            if (listTag && line.startsWith(`${listTag} OK`)) {
                logoutTag = send('LOGOUT');
            }
            if (logoutTag && (line.startsWith(`${logoutTag} OK`) || line.startsWith('* BYE'))) {
                close();
            }
        });
        res.json({ success: true, data: folders });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────
// 3. GET /api/emails  ← fixed: uses BODY[HEADER.FIELDS]
// ─────────────────────────────────────────────────────────
app.get('/api/emails', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    const folder = req.query.folder || 'INBOX';

    let loginTag, selectTag, fetchTag, logoutTag;
    let total = 0;
    const emails = [];
    let currentMsg = null;
    let inBody = false;

    try {
        await imapSession(user, pass, (send, line, close, results) => {
            if (line.startsWith('__LOGIN_TAG__')) { loginTag = line.split(' ')[1]; return; }

            // Login OK → select folder
            if (loginTag && line.startsWith(`${loginTag} OK`)) {
                selectTag = send(`SELECT "${folder}"`);
                return;
            }

            // Capture EXISTS count
            const existsMatch = line.match(/^\* (\d+) EXISTS/);
            if (existsMatch) { total = parseInt(existsMatch[1]); return; }

            // Select OK → fetch last 15
            if (selectTag && line.startsWith(`${selectTag} OK`)) {
                if (total === 0) {
                    logoutTag = send('LOGOUT');
                    return;
                }
                const start = Math.max(1, total - 14);
                fetchTag = send(`FETCH ${start}:* (UID FLAGS BODY[HEADER.FIELDS (FROM SUBJECT DATE)])`);
                return;
            }

            // Parse FETCH lines
            if (fetchTag && !logoutTag) {
                const fetchStart = line.match(/^\* (\d+) FETCH/);
                if (fetchStart) {
                    if (currentMsg) emails.push(currentMsg);
                    const uidM   = line.match(/UID (\d+)/);
                    const flagsM = line.match(/FLAGS \(([^)]*)\)/);
                    currentMsg = {
                        uid:     uidM   ? parseInt(uidM[1])   : 0,
                        seq:     parseInt(fetchStart[1]),
                        flags:   flagsM ? flagsM[1]           : '',
                        from: '', subject: '', date: ''
                    };
                    inBody = true;
                    return;
                }
                if (inBody && currentMsg) {
                    if (/^From:/i.test(line))    { currentMsg.from    = line.replace(/^From:\s*/i, '');    return; }
                    if (/^Subject:/i.test(line)) { currentMsg.subject = line.replace(/^Subject:\s*/i, ''); return; }
                    if (/^Date:/i.test(line))    { currentMsg.date    = line.replace(/^Date:\s*/i, '');    return; }
                    if (/^[ \t]/.test(line) && currentMsg.subject) { currentMsg.subject += ' ' + line.trim(); return; }
                    if (line === ')') { inBody = false; return; }
                }
                if (line.startsWith(`${fetchTag} OK`)) {
                    if (currentMsg) emails.push(currentMsg);
                    logoutTag = send('LOGOUT');
                    return;
                }
            }

            if (logoutTag && (line.startsWith(`${logoutTag} OK`) || line.startsWith('* BYE'))) {
                close();
            }
        });

        const data = emails.reverse().map(m => ({
            uid:     m.uid || m.seq,
            seq:     m.seq,
            subject: decodeMime(m.subject) || '(No Subject)',
            from:    decodeMime(m.from)    || 'Unknown',
            date:    m.date,
            read:    m.flags.includes('\\Seen')
        }));

        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────
// 4. GET /api/email-content  ← fixed: fetches BODY[] raw
// ─────────────────────────────────────────────────────────
app.get('/api/email-content', async (req, res) => {
    const user   = req.headers['x-imap-user'];
    const pass   = req.headers['x-imap-pass'];
    const folder = req.query.folder || 'INBOX';
    const seq    = req.query.uid;   // still named uid in query for compat, but it's seq number

    let loginTag, selectTag, fetchTag, logoutTag;
    let bodyChunks = [];
    let capturingBody = false;
    let expectedBytes = 0;
    let capturedBytes = 0;

    try {
        await imapSession(user, pass, (send, line, close, results) => {
            if (line.startsWith('__LOGIN_TAG__')) { loginTag = line.split(' ')[1]; return; }

            if (loginTag && line.startsWith(`${loginTag} OK`)) {
                selectTag = send(`SELECT "${folder}"`);
                return;
            }

            if (selectTag && line.startsWith(`${selectTag} OK`)) {
                // Fetch full raw source of the specific message by sequence
                fetchTag = send(`FETCH ${seq} (BODY[])`);
                return;
            }

            if (fetchTag && !logoutTag) {
                // Detect literal start: {NNN}
                if (!capturingBody) {
                    const litMatch = line.match(/BODY\[\] \{(\d+)\}/);
                    if (litMatch) {
                        expectedBytes = parseInt(litMatch[1]);
                        capturingBody = true;
                        capturedBytes = 0;
                        return;
                    }
                }
                if (capturingBody) {
                    bodyChunks.push(line + '\r\n');
                    capturedBytes += Buffer.byteLength(line + '\r\n');
                    if (capturedBytes >= expectedBytes) {
                        capturingBody = false;
                    }
                    return;
                }
                if (line.startsWith(`${fetchTag} OK`)) {
                    logoutTag = send('LOGOUT');
                    return;
                }
            }

            if (logoutTag && (line.startsWith(`${logoutTag} OK`) || line.startsWith('* BYE'))) {
                close();
            }
        });

        const rawSource = bodyChunks.join('');
        if (!rawSource) return res.json({ success: true, content: '<p>No content</p>' });

        const parsed = await simpleParser(rawSource);
        res.json({
            success: true,
            content: parsed.html || parsed.textAsHtml || parsed.text || '<p>No content</p>'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────
// 🚀 Start
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🦄 UniPony Backend ready on port ${PORT}`);
    console.log(`✅ Mode: Raw TLS IMAP (smtp.dev compatible)`);
});

const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const IMAP_HOST = 'imap.smtp.dev'; // 📌 โฮสต์ที่พิสูจน์แล้วว่าล็อกอินผ่าน

// ==========================================
// ⚙️ ตั้งค่า CORS ให้รองรับ Netlify และ Localhost
// ==========================================
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

// ==========================================
// 🔑 1. Route: Login (วอร์มเครื่อง)
// ==========================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const client = new ImapFlow({
        host: IMAP_HOST,
        port: 993,
        secure: true,
        auth: { user: email, pass: password },
        logger: false,
        connectionTimeout: 15000
    });

    try {
        await client.connect();
        await client.logout();
        res.json({ success: true });
    } catch (err) {
        res.status(401).json({ success: false, error: err.message });
    }
});

// ==========================================
// 📂 2. Route: Folders (ดึงรายชื่อห้อง)
// ==========================================
app.get('/api/folders', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];

    const client = new ImapFlow({
        host: IMAP_HOST,
        port: 993,
        secure: true,
        auth: { user, pass },
        logger: false
    });

    try {
        await client.connect();
        let folders = await client.list();
        res.json({ success: true, data: folders.map(f => ({ name: f.name, path: f.path })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await client.logout();
    }
});

// ==========================================
// 📩 3. Route: Emails (โหมดสไนเปอร์ ดึงทีละฉบับ!)
// ==========================================
app.get('/api/emails', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    const folderPath = req.query.folder || 'INBOX';

    const client = new ImapFlow({
        host: IMAP_HOST,
        port: 993,
        secure: true,
        auth: { user, pass },
        logger: false
    });

    try {
        await client.connect();
        let lock = await client.getMailboxLock(folderPath);
        try {
            const total = client.mailbox.exists;
            if (total === 0) return res.json({ success: true, data: [] });

            let emails = [];
            // ดึงสูงสุด 15 ฉบับล่าสุด
            let start = Math.max(1, total - 14);

            // 🎯 ท่าไม้ตาย V10: วนลูปดึงทีละฉบับ (ป้องกัน Server สำลักเมลคนนอก)
            for (let i = total; i >= start; i--) {
                try {
                    // ใช้ fetchOne ดึงแถวตรงๆ (Sequence) ไม่ใช้ UID ที่รวนๆ
                    let msg = await client.fetchOne(i.toString(), { envelope: true }, { uid: false });
                    
                    if (msg && msg.envelope) {
                        emails.push({
                            uid: i, // ใช้เลขแถวแทน UID ไปเลย ชัวร์กว่า
                            subject: msg.envelope.subject || '(No Subject)',
                            from: msg.envelope.from?.[0]?.address || 'Unknown',
                            date: msg.envelope.date
                        });
                    }
                } catch (fetchErr) {
                    console.error(`❌ ข้ามฉบับที่ ${i}:`, fetchErr.message);
                }
            }
            res.json({ success: true, data: emails });
        } finally {
            lock.release();
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await client.logout();
    }
});

// ==========================================
// 📄 4. Route: Content (ดึงเนื้อหาเมล)
// ==========================================
app.get('/api/email-content', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    const { folder, uid } = req.query; // uid ในที่นี้คือเลขแถว (Sequence)

    const client = new ImapFlow({
        host: IMAP_HOST,
        port: 993,
        secure: true,
        auth: { user, pass },
        logger: false
    });

    try {
        await client.connect();
        let lock = await client.getMailboxLock(folder || 'INBOX');
        try {
            // ดึง Source ดิบมา parse เอง ป้องกันเซิร์ฟเวอร์เอ๋อ
            let message = await client.fetchOne(uid, { source: true }, { uid: false });
            const parsed = await simpleParser(message.source);
            
            res.json({ 
                success: true, 
                content: parsed.html || parsed.textAsHtml || parsed.text || "No Content" 
            });
        } finally {
            lock.release();
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await client.logout();
    }
});

// ==========================================
// 🚀 Start Server
// ==========================================
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🦄 UniPony Sniper-Backend ready on port ${PORT}`);
    console.log(`✅ Mode: Sequence Fetching (Anti-Server-Lag)`);
});

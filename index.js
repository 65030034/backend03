const { ImapFlow } = require('imapflow');

const client = new ImapFlow({
    host: 'imap.rambler.ru',
    port: 993,
    secure: true, 
    auth: {
        user: 'imetintuquae@ro.ru',
        pass: '3AYysH94WCl' 
    },
    logger: false,
    // เพิ่ม Timeout ป้องกันกรณีเน็ตค้างแล้วโปรแกรมรันไม่จบ
    connectionTimeout: 10000 
});

const run = async () => {
    try {
        // 1. ลองเชื่อมต่อ
        await client.connect();
        console.log('✅ เชื่อมต่อ Rambler สำเร็จ!');

        // 2. ดึงรายชื่อ Folder
        try {
            let folders = await client.list();
            console.log('\n📂 รายการกล่องจดหมายของคุณ:');
            folders.forEach(f => console.log(`  - ${f.name}`));
        } catch (folderErr) {
            console.error('❌ ดึงรายการ Folder ไม่สำเร็จ:', folderErr.message);
        }

        // 3. เข้าถึง INBOX อย่างปลอดภัย
        let lock;
        try {
            // ขอสิทธิ์เข้าไปจัดการ INBOX
            lock = await client.getMailboxLock('INBOX');
            const mailbox = client.mailbox; 
            
            console.log(`\n📥 สถานะ INBOX: มีจดหมายทั้งหมด ${mailbox.exists} ฉบับ`);

            // เช็คว่ามีจดหมายไหม ถ้าเป็น 0 จะไม่สั่ง fetch (แก้ปัญหา Command failed)
            if (mailbox.exists === 0) {
                console.log('--- 📭 ยังไม่มีจดหมายใน Inbox ---');
            } else {
                console.log('--- ⏳ กำลังดึงข้อมูลจดหมาย... ---');
                
                // ดึงเฉพาะ 10 ฉบับล่าสุด (ลดภาระ Server และทำงานไวขึ้น)
                // ถ้าน้อยกว่า 10 ฉบับ ก็ดึงตั้งแต่ฉบับที่ 1
                let start = Math.max(1, mailbox.exists - 9);
                let sequence = `${start}:*`; 

                // ใช้ for await วนอ่านข้อมูล
                for await (let msg of client.fetch(sequence, { envelope: true })) {
                    // ป้องกัน Error กรณีอีเมลไม่มีผู้ส่งหรือหัวข้อ (บางทีเป็นเมลสแปมระบบจะส่งมาเป็น null)
                    const subject = msg.envelope.subject || '(ไม่มีหัวข้อ)';
                    const from = (msg.envelope.from && msg.envelope.from.length > 0) 
                                 ? msg.envelope.from[0].address 
                                 : '(ไม่ระบุผู้ส่ง)';
                    
                    console.log(`[UID: ${msg.uid}] จาก: ${from} | หัวข้อ: ${subject}`);
                }
            }
        } catch (inboxErr) {
            console.error('❌ เกิดข้อผิดพลาดในการอ่าน INBOX:', inboxErr.message);
        } finally {
            // ปลดล็อค INBOX เสมอ ไม่ว่าโค้ดข้างบนจะพังหรือไม่ (สำคัญมาก)
            if (lock) {
                lock.release();
            }
        }

    } catch (err) {
        console.error('❌ เกิดข้อผิดพลาดหลัก (เช่น Login ไม่ผ่าน หรือ เน็ตหลุด):', err.message);
    } finally {
        // เช็คว่ายังเชื่อมต่ออยู่ไหม ค่อยสั่ง Logout (ป้องกัน Error ซ้ำซ้อน)
        if (client && client.usable) {
            await client.logout();
            console.log('\n🔒 ตัดการเชื่อมต่อเรียบร้อย');
        }
    }
};

run();
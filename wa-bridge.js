if (!global.crypto) {
    try {
        global.crypto = require('node:crypto').webcrypto;
    } catch (e) {
        global.crypto = require('crypto');
    }
}

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

// Konfigurasi Folder Sesi & Antrean
const SESSION_DIR = path.join(__dirname, "wa_session");
const QUEUE_DIR = path.join(__dirname, "wa_queue");
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR);

const logger = pino({ level: "info" });

// Argumen dari Python: (Dibalik layar sekarang cuma untuk trigger start, argumen diabaikan saat queue berjalan)
const args = process.argv.slice(2);
const mode = getArg("--mode") || "standby";

function getArg(key) {
    const idx = args.indexOf(key);
    return idx !== -1 ? args[idx + 1] : null;
}

let sock;
let isProcessingQueue = false;
let standbyTimeout = null;

// Fungsi untuk auto-shutdown setelah 1 jam tidak ada aktivitas (Hemat RAM)
function resetStandbyTimer() {
    if (standbyTimeout) clearTimeout(standbyTimeout);
    // 3600000 ms = 1 Jam
    standbyTimeout = setTimeout(() => {
        console.log("[STATUS] Timeout: 1 Jam tidak ada pesan. Standby dihentikan untuk hemat RAM.");
        process.exit(0);
    }, 3600000);
}

// Fungsi membersihkan file pre-key usang agar tidak menumpuk dan merusak sesi
function cleanOldPreKeys() {
    try {
        const files = fs.readdirSync(SESSION_DIR);
        let deleted = 0;
        files.forEach(f => {
            // Hapus file pre-key (bukan session config utama)
            if (f.startsWith('pre-key-') || f.startsWith('sender-key-')) {
                fs.unlinkSync(path.join(SESSION_DIR, f));
                deleted++;
            }
        });
        if (deleted > 0) {
            console.log(`[CLEANUP] Berhasil membersihkan ${deleted} file pre-key/sender-key lama.`);
        }
    } catch (err) {
        console.log("[CLEANUP] Gagal membersihkan pre-keys:", err.message);
    }
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json"));
        if (files.length > 0) {
            files.sort(); // Urutkan berdasarkan nama (waktu pembuatan)

            for (const file of files) {
                const filePath = path.join(QUEUE_DIR, file);
                try {
                    const data = fs.readFileSync(filePath, "utf-8");
                    const task = JSON.parse(data);

                    console.log(`[QUEUE] Memproses antrean: ${file}`);

                    if (task.mode === "test" || task.mode === "single") {
                        await sendSingle(sock, task.to, task.msg, task.image, task.id || "manual");
                    } else if (task.mode === "batch") {
                        if (task.file && fs.existsSync(task.file)) {
                            const batchTasks = JSON.parse(fs.readFileSync(task.file, "utf-8"));
                            console.log(`[QUEUE] Memproses BATCH ${batchTasks.length} antrean dari ${task.file}...`);
                            for (let i = 0; i < batchTasks.length; i++) {
                                const t = batchTasks[i];
                                await sendSingle(sock, t.to, t.msg, t.image, t.id || `bc_${i}`);
                                if (i < batchTasks.length - 1) {
                                    // Throttling 30 detik untuk batch
                                    await delay(30000);
                                }
                            }
                            fs.unlinkSync(task.file); // Hapus antrean batch
                        }
                    }

                    // Hapus job setelah selesai
                    fs.unlinkSync(filePath);
                } catch (taskErr) {
                    console.log(`[QUEUE ERROR] Gagal proses ${file}:`, taskErr.message);
                    // Pindahkan ke folder error jika gagal dibaca agar tidak stuck
                    fs.renameSync(filePath, filePath + ".error");
                }
            }
        }
    } catch (err) {
        console.log("[QUEUE ERROR] Gagal membaca antrean:", err.message);
    }

    isProcessingQueue = false;
    resetStandbyTimer(); // Reset timer setiap kali selesai proses
}

async function startWA() {
    // Bersihkan sesi lawas sebelum mulai
    cleanOldPreKeys();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    let versionParams;

    try {
        versionParams = await fetchLatestBaileysVersion();
    } catch (err) {
        // Fallback jika tidak bisa fetch versi
        versionParams = { version: [2, 3000, 1015901307] };
    }

    sock = makeWASocket({
        version: versionParams.version,
        auth: state,
        printQRInTerminal: true,
        logger,
        // Optimasi untuk koneksi jangka panjang
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        browser: ['NMS-Gateway (Pro)', 'Chrome', '1.0.0'],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            fs.writeFileSync(path.join(__dirname, "wa_qr.txt"), qr);
            console.log("[QR] Silakan scan QR Code yang muncul di terminal atau UI.");
            // Reset timer khusus saat nunggu QR agar mati jika kelamaan (5 menit)
            if (standbyTimeout) clearTimeout(standbyTimeout);
            standbyTimeout = setTimeout(() => {
                console.log("[STATUS] Timeout: Tidak ada aktivitas pairing selama 5 menit. Mematikan service...");
                process.exit(0);
            }, 300000);
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log("[STATUS] Koneksi terputus. Kodenya:", statusCode);

            // Logged Out (401)
            if (statusCode === DisconnectReason.loggedOut) {
                console.log("[STATUS] Sesi dihentikan (Logged Out). File sesi akan direset.");
                try {
                    // Hapus auth state yang korup
                    const sessionFiles = fs.readdirSync(SESSION_DIR);
                    sessionFiles.forEach(f => fs.unlinkSync(path.join(SESSION_DIR, f)));
                } catch (e) { }
                process.exit(1);
            }

            // Restart Required (503) -> Harus langsung connect lagi
            if (statusCode === DisconnectReason.restartRequired) {
                console.log("[STATUS] Restart Required dari server WhatsApp, mencoba menyambung ulang...");
                startWA();
            } else {
                console.log("[STATUS] Koneksi gagal, mencoba menyambung ulang dalam 5 detik...");
                setTimeout(() => startWA(), 5000);
            }

        } else if (connection === "open") {
            console.log("[STATUS] Terhubung ke WhatsApp (Singleton Mode)!");
            try { fs.unlinkSync(path.join(__dirname, "wa_qr.txt")); } catch (e) { }

            // Langsung scan antrean saat terhubung
            resetStandbyTimer();
            // Polling folder secara berkala setiap 5 detik
            setInterval(processQueue, 5000);
            processQueue(); // Jalankan sekali diawal
        }
    });
}

async function sendSingle(targetSock, to, msg, imagePath = null, id = "manual") {
    if (!to || (!msg && !imagePath)) {
        console.log(`[ERROR] [ID:${id}] Nomor tujuan atau konten pesan kosong.`);
        return;
    }

    let jid = to.replace(/[^0-9]/g, "");
    if (jid.startsWith("0")) jid = "62" + jid.slice(1);
    jid = jid.includes("@s.whatsapp.net") ? jid : jid + "@s.whatsapp.net";

    const logPrefix = `[ID:${id}]`;
    console.log(`[SEND] ${logPrefix} Mengirim ke ${jid}...`);
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            await targetSock.sendMessage(jid, {
                image: fs.readFileSync(imagePath),
                caption: msg
            });
            console.log(`[SUCCESS] ${logPrefix} Gambar + Pesan terkirim ke ${to}`);
        } else {
            await targetSock.sendMessage(jid, { text: msg });
            console.log(`[SUCCESS] ${logPrefix} Pesan teks terkirim ke ${to}`);
        }
    } catch (err) {
        console.log(`[FAILED] ${logPrefix} Gagal kirim ke ${to}: ${err.message}`);
    }
}

// Tangani shutdown dari Python dengan bersih
process.on('SIGINT', () => {
    console.log("[STATUS] Menerima sinyal mati dari sistem. Menyimpan sesi...");
    process.exit(0);
});

// Start
startWA().catch(err => {
    console.error("[CRITICAL ERROR]", err);
    process.exit(1);
});

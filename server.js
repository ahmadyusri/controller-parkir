const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const url = require('url');

const activeDevices = new Map();
let eventLogs = [];
const MAX_LOGS = 50;

// Daftar kartu RFID yang terdaftar
const registeredCardIds = ["706547715", "2071513441", "975045768"];

const httpServer = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    // Web Dashboard Static File
    if (pathname === '/' || pathname === '/index.html') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Gagal memuat file index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    // HTTP API Endpoints
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 1. Endpoint /tiket (Tombol Start)
    if (pathname === '/tiket' || pathname === '/tiket/') {
        const deviceId = query.gate || 'UNKNOWN';
        recordLog('HTTP', deviceId, 'HTTP_TIKET', query);

        // Contoh logika: Tombol selalu diberikan akses (true)
        res.writeHead(200);
        res.end(JSON.stringify({ access: true, message: "Tiket diproses" }));
        return;
    }

    // Endpoint /member (Cek RFID / Card)
    if (pathname === '/member' || pathname === '/member/') {
        const deviceId = query.gate || 'UNKNOWN';
        const cardId = query.text || query.card_id || '';
        recordLog('HTTP', deviceId, 'HTTP_MEMBER', query);

        // Validasi kartu RFID
        const hasAccess = registeredCardIds.includes(cardId);

        res.writeHead(200);
        res.end(JSON.stringify({ access: hasAccess }));
        return;
    }

    // Endpoint /bantuan (Help)
    if (pathname === '/bantuan' || pathname === '/bantuan/') {
        const deviceId = query.gate || 'UNKNOWN';
        recordLog('HTTP', deviceId, 'HTTP_BANTUAN', query);

        res.writeHead(200);
        res.end(JSON.stringify({ access: true, message: "Bantuan dicatat" }));
        return;
    }

    // Endpoint /capture
    if (pathname === '/capture' || pathname === '/capture/') {
        const deviceId = query.gate || 'UNKNOWN';
        recordLog('HTTP', deviceId, 'HTTP_CAPTURE', query);

        // Cek sensor vld1 atau vld2
        const vld1 = query.vld1_kios === 'true';
        const vld2 = query.vld2_kios === 'true';
        const allow = vld1 || vld2;

        res.writeHead(200);
        res.end(JSON.stringify({ access: allow, process: allow ? "allowProcess" : "disallowProcess" }));
        return;
    }

    // Jika rute tidak ditemukan
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
});

const io = new Server(httpServer, {
    cors: { origin: "*" }
});

function recordLog(socketId, deviceId, eventName, eventData) {
    const logEntry = {
        time: new Date().toLocaleString(),
        deviceId: deviceId || 'Unknown',
        socketId: socketId,
        event: eventName,
        data: eventData || {}
    };

    console.log(`${logEntry.time} - [${eventName}] Device: ${logEntry.deviceId} | Source: ${socketId}`, eventData || '');

    eventLogs.unshift(logEntry);
    if (eventLogs.length > MAX_LOGS) eventLogs.pop();

    broadcastDashboardData();
}

function broadcastDashboardData() {
    const devicesArr = [];
    activeDevices.forEach((value, key) => {
        devicesArr.push({
            socketId: key,
            deviceId: value.deviceId || 'Menunggu ID...',
            connectedAt: value.isOnline ? value.connectedAt : '-',
            timestamp: value.timestamp,
            isOnline: value.isOnline
        });
    });

    io.emit('update_monitoring', {
        devices: devicesArr,
        logs: eventLogs
    });
}

// Middleware Auth Socket.IO
io.use((socket, next) => {
    const token = socket.handshake.headers.authorization;

    if (!token) {
        socket.isWebDashboard = true;
        return next();
    }

    if (token !== "1234567890") {
        console.log(new Date().toLocaleString() + " - Authentication error: Invalid token");
        return next(new Error("Authentication error: Invalid token"));
    }

    socket.user = token;
    next();
});

io.on('connection', (socket) => {
    const deviceId = socket.handshake.query.id;

    if (socket.isWebDashboard) {
        console.log(new Date().toLocaleString() + ' - Web Dashboard terhubung. SocketID:', socket.id);

        socket.emit('update_monitoring', {
            devices: Array.from(activeDevices.entries()).map(([k, v]) => ({
                socketId: k,
                deviceId: v.deviceId || 'Menunggu ID...',
                connectedAt: v.isOnline ? v.connectedAt : '-',
                timestamp: v.timestamp,
                isOnline: v.isOnline
            })),
            logs: eventLogs
        });

        socket.on('admin_command', ({ targetSocketId, action, ...extraData }) => {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (!targetSocket) return;

            const commandPayload = { action, ...extraData };
            targetSocket.emit('command', commandPayload);
            recordLog(targetSocketId, activeDevices.get(targetSocketId)?.deviceId || 'UNKNOWN', 'ADMIN_CMD', commandPayload);
        });

        socket.on('clear_logs', () => {
            eventLogs = [];
            console.log(new Date().toLocaleString() + ' - Event logs dibersihkan oleh admin.');
            broadcastDashboardData();
        });

        return;
    }

    // Fallback Socket.IO handler
    const connectTime = new Date();
    activeDevices.set(socket.id, {
        timestamp: Date.now(),
        connectedAt: connectTime.toLocaleString(),
        deviceId: deviceId,
        isOnline: true
    });
    checkAndUpdateDeviceId({ id: deviceId });

    recordLog(socket.id, deviceId, 'CONNECT', { message: 'Device terhubung via Socket' });

    const testingInterval = setInterval(() => {
        socket.emit('command', { "action": "playAudio", "folder": "02", "track": "02" });
        setTimeout(() => {
            socket.emit('command', { "action": "openGate" });
        }, 10000);
    }, 60000 * 60);

    socket.on('disconnect', () => {
        clearInterval(testingInterval);

        const devInfo = activeDevices.get(socket.id);
        const devId = devInfo ? devInfo.deviceId : deviceId;

        if (devInfo && devInfo.deviceId) {
            devInfo.isOnline = false;
        } else {
            activeDevices.delete(socket.id);
        }

        recordLog(socket.id, devId, 'DISCONNECT', { message: 'Device terputus' });
        broadcastDashboardData();
    });

    function checkAndUpdateDeviceId(data) {
        if (data && data.id) {
            const newDeviceId = data.id;
            for (const [existingSocketId, devData] of activeDevices.entries()) {
                if (existingSocketId !== socket.id && devData.deviceId === newDeviceId) {
                    activeDevices.delete(existingSocketId);
                }
            }

            const dev = activeDevices.get(socket.id);
            if (dev) {
                dev.deviceId = newDeviceId;
                dev.isOnline = true;
                broadcastDashboardData();
            }
        }
    }

    socket.on('message', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        recordLog(socket.id, dev ? dev.deviceId : 'UNKNOWN', 'message', data);
    });

    socket.on('help', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        recordLog(socket.id, dev ? dev.deviceId : 'UNKNOWN', 'help', data);
    });

    socket.on('start', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        const devId = dev ? dev.deviceId : 'UNKNOWN';

        recordLog(socket.id, devId, 'start', data);

        if (data.type === "button") {
            setTimeout(() => {
                socket.emit('command', { "action": "openGate" });
            }, 2000);
        } else {
            if (registeredCardIds.includes(data.card_id)) {
                setTimeout(() => {
                    socket.emit('command', { "action": "openGate" });
                }, 2000);
            } else {
                setTimeout(() => {
                    socket.emit('command', { "action": "playAudio", "folder": "02", "track": "04" });
                }, 2000);
            }
        }
    });

    socket.on('capture', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        const devId = dev ? dev.deviceId : 'UNKNOWN';

        recordLog(socket.id, devId, 'capture', data);

        if (data.vld1_kios || data.vld2_kios) {
            socket.emit('command', { "action": 'allowProcess' });
        } else {
            socket.emit('command', { "action": 'disallowProcess' });
        }
    });
});

httpServer.listen(9010, () => {
    console.log(new Date().toLocaleString() + ' - Server HTTP & Monitoring berjalan di port 9010');
});
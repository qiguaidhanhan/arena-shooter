// 竞技场射手 - 联机中继服务器
// 使用方法: node server.js [端口号，默认8765]
// 纯 Node.js 内置模块，无第三方依赖

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2]) || 8765;
const clients = new Map();
let clientIdCounter = 0;

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return false;
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return true;
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const firstByte = buffer[0];
  const opcode = firstByte & 0x0f;
  if (opcode === 0x8) return { type: 'close' }; // close frame
  if (opcode === 0x9) return { type: 'ping', data: buffer }; // ping
  if (opcode === 0xa) return { type: 'pong' }; // pong
  if (opcode !== 0x1 && opcode !== 0x2) return null;
  const secondByte = buffer[1];
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;
  if (payloadLen === 126) { payloadLen = buffer.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  const mask = masked ? buffer.slice(offset, offset + 4) : null;
  if (mask) offset += 4;
  if (buffer.length < offset + payloadLen) return null;
  let payload = buffer.slice(offset, offset + payloadLen);
  if (mask) {
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buffer[offset + i] ^ mask[i % 4];
    }
  }
  return { type: 'message', data: payload, totalLen: offset + payloadLen - (mask ? 4 : 0) + (mask ? 4 : 0) };
}

function encodeFrame(data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(senderId, message) {
  const frame = encodeFrame(message);
  for (const [id, ws] of clients) {
    if (id !== senderId && ws.ready) {
      try { ws.socket.write(frame); } catch(e) { ws.ready = false; }
    }
  }
}

function sendTo(clientId, message) {
  const ws = clients.get(clientId);
  if (ws && ws.ready) {
    try { ws.socket.write(encodeFrame(message)); } catch(e) { ws.ready = false; }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Arena Shooter Relay Server - Running');
});

server.on('upgrade', (req, socket, head) => {
  if (!acceptWebSocket(req, socket)) {
    socket.destroy();
    return;
  }

  const clientId = 'P' + (++clientIdCounter);
  const ws = { socket, ready: true, buf: Buffer.alloc(0) };
  clients.set(clientId, ws);

  console.log(`[+] ${clientId} 已连接 (在线: ${clients.size})`);

  // 告知新客户端它的 ID
  sendTo(clientId, JSON.stringify({ type: 'welcome', id: clientId }));

  // 告知其他客户端有新玩家
  broadcast(clientId, JSON.stringify({ type: 'player_joined', id: clientId }));

  // 将现有玩家列表发给新客户端
  for (const [id, c] of clients) {
    if (id !== clientId && c.ready) {
      sendTo(clientId, JSON.stringify({ type: 'player_joined', id }));
    }
  }

  socket.on('data', (chunk) => {
    ws.buf = Buffer.concat([ws.buf, chunk]);
    while (ws.buf.length > 0) {
      const frame = decodeFrame(ws.buf);
      if (!frame) break;
      if (frame.type === 'close') {
        ws.ready = false;
        socket.destroy();
        break;
      }
      if (frame.type === 'ping') {
        // 响应 ping
        const pongBuf = Buffer.from(frame.data);
        pongBuf[0] = 0x8a; // pong opcode
        try { socket.write(pongBuf); } catch(e) {}
      }
      if (frame.type === 'message') {
        try {
          const msg = JSON.parse(frame.data.toString('utf8'));
          if (!msg.from) msg.from = clientId;
          broadcast(clientId, JSON.stringify(msg));
        } catch(e) {}
      }
      const consumed = frame.type === 'message' || frame.type === 'pong'
        ? (frame.totalLen || 0) + (frame.data ? (frame.data.length + (frame.data._headerLen || 0)) : 0)
        : 0;
      // 简化：根据实际解析计算
      if (frame.type === 'close') { ws.buf = Buffer.alloc(0); break; }
      if (frame.type === 'ping') { ws.buf = ws.buf.slice(frame.data.length + 2); continue; }
      if (frame.type === 'pong') break;
      if (frame.type === 'message') {
        const rawLen = frame.data.length;
        // 计算帧头长度
        let headerLen = 2;
        if (rawLen >= 126 && rawLen < 65536) headerLen = 4;
        else if (rawLen >= 65536) headerLen = 10;
        headerLen += 4; // mask
        ws.buf = ws.buf.slice(headerLen + rawLen);
      } else {
        break;
      }
    }
  });

  socket.on('close', () => {
    clients.delete(clientId);
    console.log(`[-] ${clientId} 已断开 (在线: ${clients.size})`);
    broadcast(clientId, JSON.stringify({ type: 'player_left', id: clientId }));
  });

  socket.on('error', () => {
    clients.delete(clientId);
    broadcast(clientId, JSON.stringify({ type: 'player_left', id: clientId }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  console.log('═══════════════════════════════════════');
  console.log('  竞技场射手 - 联机服务器已启动');
  console.log('═══════════════════════════════════════');
  console.log(`  端口: ${PORT}`);
  console.log(`  本机: ws://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log('  局域网地址:');
    ips.forEach(ip => console.log(`    ws://${ip}:${PORT}`));
  }
  console.log('═══════════════════════════════════════');
  console.log('  其他玩家在游戏输入框填入:');
  if (ips.length > 0) {
    console.log(`    ${ips[0]}:${PORT}`);
  }
  console.log('  然后点击"加入房间"');
  console.log('═══════════════════════════════════════');
});

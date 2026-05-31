# 竞技场射手 - 联机中继服务器 (Python 版)
# 使用方法: python server.py [端口号，默认8765]
# 纯 Python 标准库，无需 pip install 任何东西

import asyncio
import hashlib
import base64
import struct
import json
import sys
import socket

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
clients = {}
client_counter = 0
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def get_local_ips():
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            ip = info[4][0]
            if ip not in ips and not ip.startswith('127.'):
                ips.append(ip)
    except:
        pass
    return ips


def make_accept_key(key):
    return base64.b64encode(
        hashlib.sha1((key + GUID).encode()).digest()
    ).decode()


def encode_frame(payload):
    data = payload.encode('utf-8') if isinstance(payload, str) else payload
    length = len(data)
    if length < 126:
        header = struct.pack('!BB', 0x81, length)
    elif length < 65536:
        header = struct.pack('!BBH', 0x81, 126, length)
    else:
        header = struct.pack('!BBQ', 0x81, 127, length)
    return header + data


def decode_frame(data):
    """解码 WebSocket 帧，返回 (opcode, payload, consumed_bytes) 或 None"""
    if len(data) < 2:
        return None
    byte1, byte2 = data[0], data[1]
    opcode = byte1 & 0x0f
    masked = (byte2 & 0x80) != 0
    length = byte2 & 0x7f
    offset = 2

    if length == 126:
        if len(data) < 4:
            return None
        length = struct.unpack('!H', data[2:4])[0]
        offset = 4
    elif length == 127:
        if len(data) < 10:
            return None
        length = struct.unpack('!Q', data[2:10])[0]
        offset = 10

    mask = None
    if masked:
        if len(data) < offset + 4:
            return None
        mask = data[offset:offset + 4]
        offset += 4

    if len(data) < offset + length:
        return None

    payload = bytearray(data[offset:offset + length])
    if mask:
        for i in range(length):
            payload[i] ^= mask[i % 4]

    consumed = offset + length
    return (opcode, bytes(payload), consumed)


async def broadcast(sender_id, message):
    frame = encode_frame(message)
    for cid, writer in clients.items():
        if cid != sender_id and not writer.is_closing():
            try:
                writer.write(frame)
                await writer.drain()
            except:
                pass


async def send_to(client_id, message):
    writer = clients.get(client_id)
    if writer and not writer.is_closing():
        try:
            writer.write(encode_frame(message))
            await writer.drain()
        except:
            pass


async def handle_client(reader, writer):
    global client_counter
    client_counter += 1
    client_id = f"P{client_counter}"
    clients[client_id] = writer
    addr = writer.get_extra_info('peername')
    print(f"[+] {client_id} 已连接 ({addr[0]}:{addr[1]}, 在线: {len(clients)})")

    # --- HTTP 升级握手 ---
    request_data = b''
    while b'\r\n\r\n' not in request_data:
        chunk = await reader.read(4096)
        if not chunk:
            break
        request_data += chunk
        if len(request_data) > 8192:
            break

    # 关键：分离 HTTP 头后面的 WebSocket 帧数据
    split_pos = request_data.find(b'\r\n\r\n') + 4
    http_part = request_data[:split_pos]
    buf = request_data[split_pos:]  # 剩余的是 WebSocket 帧

    request_text = http_part.decode('utf-8', errors='replace')
    key = None
    for line in request_text.split('\r\n'):
        if line.lower().startswith('sec-websocket-key:'):
            key = line.split(':', 1)[1].strip()
            break

    if not key:
        print(f"[-] {client_id} 非 WebSocket 请求")
        writer.close()
        del clients[client_id]
        return

    accept = make_accept_key(key)
    response = (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Accept: {accept}\r\n\r\n'
    )
    writer.write(response.encode())
    await writer.drain()

    # 发送欢迎 + 现有玩家列表
    await send_to(client_id, json.dumps({'type': 'welcome', 'id': client_id}))
    for cid in clients:
        if cid != client_id:
            await send_to(client_id, json.dumps({'type': 'player_joined', 'id': cid}))
    await broadcast(client_id, json.dumps({'type': 'player_joined', 'id': client_id}))

    # --- WebSocket 帧主循环 ---
    try:
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                break
            buf += chunk

            while True:
                result = decode_frame(buf)
                if result is None:
                    break
                opcode, payload, consumed = result

                if opcode == 0x8:  # close
                    close_code = 1000
                    if len(payload) >= 2:
                        close_code = struct.unpack('!H', payload[:2])[0]
                    print(f"[-] {client_id} 主动断开 ({close_code})")
                    # 发送 close 帧回应
                    try:
                        close_frame = struct.pack('!BBH', 0x88, 2, 1000)
                        writer.write(close_frame)
                        await writer.drain()
                    except:
                        pass
                    buf = b''
                    break
                elif opcode == 0x9:  # ping
                    # 回复 pong（同样的 payload）
                    pong_frame = bytearray([0x8a, len(payload) & 0x7f]) + payload
                    try:
                        writer.write(bytes(pong_frame))
                        await writer.drain()
                    except:
                        pass
                    buf = buf[consumed:]
                elif opcode == 0x1:  # text message
                    buf = buf[consumed:]
                    try:
                        msg = json.loads(payload.decode('utf-8'))
                        if 'from' not in msg:
                            msg['from'] = client_id
                        await broadcast(client_id, json.dumps(msg))
                    except:
                        pass
                else:
                    # 其他帧类型直接跳过
                    buf = buf[consumed:]
    except Exception as e:
        print(f"[!] {client_id} 异常: {e}")
    finally:
        if client_id in clients:
            del clients[client_id]
        print(f"[-] {client_id} 已断开 (在线: {len(clients)})")
        await broadcast(client_id, json.dumps({'type': 'player_left', 'id': client_id}))
        try:
            writer.close()
        except:
            pass


async def main():
    ips = get_local_ips()
    print('═══════════════════════════════════════')
    print('  竞技场射手 - 联机服务器 (Python)')
    print('═══════════════════════════════════════')
    print(f'  端口: {PORT}')
    if ips:
        print('  局域网地址:')
        for ip in ips:
            print(f'    ws://{ip}:{PORT}')
    print('═══════════════════════════════════════')
    if ips:
        print(f'  客机输入: {ips[0]}:{PORT}')
    print('═══════════════════════════════════════')

    server = await asyncio.start_server(handle_client, '0.0.0.0', PORT)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('\n服务器已停止')

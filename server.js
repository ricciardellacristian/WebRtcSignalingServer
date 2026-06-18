const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const port = Number(process.env.PORT || 8787);
const staticRoot = path.resolve(process.argv[2] || process.env.WEBGL_DIR || path.join(__dirname, "..", "..", "Builds", "WebGL"));
const rooms = new Map();

function send(socket, message) {
  if (!socket || socket.destroyed) {
    return;
  }

  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = [];
  header.push(0x81);

  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, payload.length >> 8, payload.length & 255);
  } else {
    header.push(127, 0, 0, 0, 0, (payload.length / 0x1000000) & 255, (payload.length >> 16) & 255, (payload.length >> 8) & 255, payload.length & 255);
  }

  socket.write(Buffer.concat([Buffer.from(header), payload]));
}

function closeSocket(socket, code = 1000, reason = "") {
  if (!socket || socket.destroyed) {
    return;
  }

  const reasonBuffer = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
  socket.end();
}

function parseFrames(socket, data) {
  socket._buffer = socket._buffer ? Buffer.concat([socket._buffer, data]) : data;

  while (socket._buffer.length >= 2) {
    const first = socket._buffer[0];
    const second = socket._buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (socket._buffer.length < offset + 2) {
        return;
      }
      length = socket._buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (socket._buffer.length < offset + 8) {
        return;
      }
      const high = socket._buffer.readUInt32BE(offset);
      const low = socket._buffer.readUInt32BE(offset + 4);
      if (high !== 0 || low > 8 * 1024 * 1024) {
        closeSocket(socket, 1009, "Message too large");
        return;
      }
      length = low;
      offset += 8;
    }

    if (!masked || socket._buffer.length < offset + 4 + length) {
      return;
    }

    const mask = socket._buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(socket._buffer.subarray(offset, offset + length));
    socket._buffer = socket._buffer.subarray(offset + length);

    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i & 3];
    }

    if (opcode === 0x8) {
      socket.end();
      return;
    }

    if (opcode === 0x9) {
      send(socket, { type: "pong" });
      continue;
    }

    if (opcode !== 0x1) {
      continue;
    }

    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      send(socket, { type: "error", message: "Invalid JSON" });
      continue;
    }

    handleMessage(socket, message);
  }
}

function createRoomCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(code)) {
      return code;
    }
  }

  throw new Error("Could not allocate room code");
}

function handleMessage(socket, message) {
  if (!message || typeof message.type !== "string") {
    send(socket, { type: "error", message: "Bad message" });
    return;
  }

  if (message.type === "ping") {
    send(socket, { type: "pong" });
    return;
  }

  if (message.type === "host") {
    leaveRoom(socket);
    const code = createRoomCode();
    const room = {
      code,
      host: socket,
      client: null,
      lastOffer: null,
      lastAnswer: null,
      createdAt: Date.now()
    };

    socket._role = "host";
    socket._roomCode = code;
    rooms.set(code, room);
    send(socket, { type: "room", code });
    console.log(`[room ${code}] host created`);
    return;
  }

  if (message.type === "join") {
    const code = String(message.code || "").replace(/\D/g, "");
    const paddedCode = code.length > 0 && code.length < 6 ? code.padStart(6, "0") : code;
    const room = rooms.get(code) || rooms.get(paddedCode);
    if (!room || !room.host || room.host.destroyed) {
      send(socket, { type: "error", message: "Room not found. Press HOST again and use the new code." });
      return;
    }

    if (room.client && !room.client.destroyed && room.client !== socket) {
      send(socket, { type: "error", message: "Room already has a client" });
      return;
    }

    leaveRoom(socket);
    room.client = socket;
    socket._role = "client";
    socket._roomCode = room.code;
    send(socket, { type: "joined", code: room.code });
    send(room.host, { type: "peer-joined", code: room.code });
    if (room.lastOffer) {
      send(socket, { type: "signal", from: "host", data: room.lastOffer });
    }
    console.log(`[room ${room.code}] client joined`);
    return;
  }

  if (message.type === "signal") {
    const room = rooms.get(socket._roomCode);
    if (!room) {
      send(socket, { type: "error", message: "Not in a room" });
      return;
    }

    const data = message.data;
    if (!data || typeof data !== "object") {
      send(socket, { type: "error", message: "Empty signal" });
      return;
    }

    if (socket._role === "host") {
      room.lastOffer = data;
      if (room.client && !room.client.destroyed) {
        send(room.client, { type: "signal", from: "host", data });
      }
      return;
    }

    if (socket._role === "client") {
      room.lastAnswer = data;
      if (room.host && !room.host.destroyed) {
        send(room.host, { type: "signal", from: "client", data });
      }
      return;
    }
  }
}

function leaveRoom(socket) {
  const code = socket._roomCode;
  if (!code) {
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    socket._roomCode = null;
    socket._role = null;
    return;
  }

  const other = socket._role === "host" ? room.client : room.host;
  if (socket._role === "host") {
    rooms.delete(code);
    if (other && !other.destroyed) {
      send(other, { type: "closed", message: "Host left" });
      closeSocket(other, 1000, "Host left");
    }
    console.log(`[room ${code}] closed`);
  } else {
    room.client = null;
    if (other && !other.destroyed) {
      send(other, { type: "peer-left", code });
    }
    console.log(`[room ${code}] client left`);
  }

  socket._roomCode = null;
  socket._role = null;
}

function serveStatic(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  if (pathname === "/signal") {
    response.writeHead(426, { "Content-Type": "text/plain" });
    response.end("WebSocket endpoint");
    return;
  }

  if (!fs.existsSync(staticRoot)) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<h1>WebRTC signaling server</h1><p>Server OK.</p><p>Build folder not found: ${escapeHtml(staticRoot)}</p>`);
    return;
  }

  let filePath = path.join(staticRoot, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(staticRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }

    const headers = {
      "Content-Type": contentType(filePath),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    };

    const encoding = contentEncoding(filePath);
    if (encoding) {
      headers["Content-Encoding"] = encoding;
    }

    response.writeHead(200, headers);
    response.end(content);
  });
}

function contentType(filePath) {
  let effectivePath = filePath;
  if (effectivePath.endsWith(".br") || effectivePath.endsWith(".gz")) {
    effectivePath = effectivePath.substring(0, effectivePath.lastIndexOf("."));
  }

  const extension = path.extname(effectivePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript";
    case ".wasm":
      return "application/wasm";
    case ".json":
      return "application/json";
    case ".data":
      return "application/octet-stream";
    case ".css":
      return "text/css";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function contentEncoding(filePath) {
  if (filePath.endsWith(".br")) {
    return "br";
  }

  if (filePath.endsWith(".gz")) {
    return "gzip";
  }

  return "";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[character]));
}

function localAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        result.push(entry.address);
      }
    }
  }

  return result;
}

const server = http.createServer(serveStatic);

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.setKeepAlive(true, 15000);

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  socket.on("data", (data) => parseFrames(socket, data));
  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 30 * 60 * 1000) {
      if (room.host && !room.host.destroyed) {
        closeSocket(room.host, 1000, "Room expired");
      }
      if (room.client && !room.client.destroyed) {
        closeSocket(room.client, 1000, "Room expired");
      }
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(port, "0.0.0.0", () => {
  console.log(`WebRTC signaling server on port ${port}`);
  console.log(`Serving WebGL from: ${staticRoot}`);
  for (const address of localAddresses()) {
    console.log(`Open from headset: http://${address}:${port}/`);
    console.log(`Signaling URL:    ws://${address}:${port}/signal`);
  }
});

# WebRTC Signaling Server

Tiny WebSocket signaling server for the Unity WebGL build.

## Render

Create a new **Web Service** on Render and use this folder as the root directory:

```text
Tools/WebRtcSignalingServer
```

Settings:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

After deploy, Render gives an HTTPS URL like:

```text
https://your-service.onrender.com
```

Use it from the WebGL build as:

```text
https://ricciardellacristian.github.io/BuildWeb/?signal=wss://your-service.onrender.com/signal
```

## Local PC

For LAN tests where the PC also serves the WebGL build:

```bat
start-signaling-server.bat C:\Path\To\WebGLBuild
```

Then open the printed `http://PC_IP:8787/` address on both headsets.

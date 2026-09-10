const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? 'http://localhost:3000' 
  : 'https://drift-backend-nkru.onrender.com';

const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });

let rtcConfig = null;
let currentRoomId = null;
let currentPassword = null;
let e2eeKey = null;

let peerConnection;
let dataChannel;
let isCreator = false;

let pendingChatIce = []; 
let pendingCallIce = []; 

let mediaRecorder;
let audioChunks = [];
let isRecording = false;

let callConnection = null;
let callStream = null;
let amICaller = false;
let isCallActive = false;
let audioCtx = null;
let gainNode = null;
let sourceNode = null;

let confirmCallback = null;

// Phantom Transfer Variables
let phantomBuffer = [];
let phantomMeta = null;
let phantomReceivedSize = 0;

// Config
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const CHUNK_SIZE = 16384; 

window.addEventListener('beforeunload', (e) => {
  if (currentRoomId) {
    e.preventDefault();
    e.returnValue = 'Warning: Leaving or reloading destroys this ephemeral chat.';
  }
});

// ==========================================
// FEATURE TABS NAVIGATION
// ==========================================
function switchFeatureView(view) {
  document.getElementById('view-messages').classList.toggle('hidden', view !== 'messages');
  document.getElementById('view-transfers').classList.toggle('hidden', view !== 'transfers');
  document.getElementById('nav-messages').classList.toggle('active', view === 'messages');
  document.getElementById('nav-transfers').classList.toggle('active', view === 'transfers');
}

// ==========================================
// MILITARY-GRADE E2EE CRYPTOGRAPHY ENGINE
// ==========================================
async function setupE2EEKey(password) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.digest('SHA-256', enc.encode(password));
  e2eeKey = await window.crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function hashPasswordForServer(password) {
  const enc = new TextEncoder();
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', enc.encode(password + "drift_server_salt"));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

function bufferToBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return window.btoa(bin);
}
function base64ToBuffer(base64) {
  const bin = window.atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Generates unique message IDs for Read Receipts & Blur events
function generateMsgId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }

async function sendEncryptedPayload(payloadObj) {
  if (!e2eeKey || !dataChannel || dataChannel.readyState !== 'open') return;
  try {
    const plainText = JSON.stringify(payloadObj);
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv }, e2eeKey, enc.encode(plainText)
    );
    
    dataChannel.send(JSON.stringify({
      e2ee: true,
      iv: bufferToBase64(iv),
      ct: bufferToBase64(ciphertext)
    }));
  } catch (e) {
    console.error("Encryption failed:", e);
  }
}

// ==========================================
// UI EFFECTS & UTILITIES
// ==========================================
function switchTab(tab) {
  document.getElementById('error-message').textContent = '';
  document.getElementById('create-form').classList.toggle('hidden', tab !== 'create');
  document.getElementById('join-form').classList.toggle('hidden', tab !== 'join');
  document.getElementById('tab-create-btn').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join-btn').classList.toggle('active', tab === 'join');
}
function universalCopy(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve) => {
    const ta = document.createElement('textarea'); ta.value = text;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); resolve();
  });
}
function copyData(id, btn) {
  universalCopy(document.getElementById(id).innerText).then(() => {
    btn.innerText = "COPIED!"; setTimeout(() => { btn.innerText = "COPY"; }, 1500);
  });
}
function quickCopyText(id, iconId) {
  universalCopy(document.getElementById(id).innerText).then(() => {
    const icon = document.getElementById(iconId);
    const orig = icon.innerHTML;
    icon.innerHTML = `<span style="color:var(--primary); font-size: 0.75rem; font-weight: bold;">COPIED!</span>`;
    setTimeout(() => { icon.innerHTML = orig; }, 1500);
  });
}
function showConfirm(msg, cb) { document.getElementById('confirm-message').textContent = msg; document.getElementById('confirm-modal').classList.remove('hidden'); confirmCallback = cb; }
function executeConfirm() { document.getElementById('confirm-modal').classList.add('hidden'); if (confirmCallback) confirmCallback(); }
function cancelConfirm() { document.getElementById('confirm-modal').classList.add('hidden'); confirmCallback = null; }
function openInfoModal() { document.getElementById('info-modal').classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ==========================================
// HANDSHAKE & SIGNALING
// ==========================================
async function handleCreate(e) {
  e.preventDefault();
  currentPassword = document.getElementById('create-password').value;
  await setupE2EEKey(currentPassword);
  
  socket.emit('create-room', { password: await hashPasswordForServer(currentPassword) }, (res) => {
    if (res.success) {
      isCreator = true; currentRoomId = res.id;
      rtcConfig = { iceServers: res.iceServers, iceCandidatePoolSize: 10 };
      
      document.getElementById('lobby-view').classList.add('hidden');
      document.getElementById('success-view').classList.remove('hidden');
      document.getElementById('disp-id').innerText = currentRoomId;
      document.getElementById('disp-pass').innerText = currentPassword; 
      setupWebRTC();
    }
  });
}

function enterGeneratedRoom() {
  document.getElementById('lobby-view').classList.add('hidden');
  document.getElementById('success-view').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = currentRoomId;
  document.getElementById('room-pass-display').textContent = currentPassword;
  displaySystemMessage('Waiting for your peer to join...');
}

async function handleJoin(e) {
  e.preventDefault();
  currentRoomId = document.getElementById('join-code').value.toUpperCase();
  currentPassword = document.getElementById('join-password').value;
  await setupE2EEKey(currentPassword);

  socket.emit('join-room', { id: currentRoomId, password: await hashPasswordForServer(currentPassword) }, (res) => {
    if (res.success) {
      isCreator = false; rtcConfig = { iceServers: res.iceServers, iceCandidatePoolSize: 10 };
      if (!peerConnection) setupWebRTC(); 
      enterGeneratedRoom();
      displaySystemMessage('[SYSTEM] Room joined. Negotiating direct P2P tunnel...', 'normal');
    } else {
      document.getElementById('error-message').textContent = res.error || 'Incorrect Room ID or Password.';
    }
  });
}

// ==========================================
// WEBRTC & DATA CHANNEL LOGIC
// ==========================================
function setupWebRTC() {
  if (peerConnection || !rtcConfig) return; 
  peerConnection = new RTCPeerConnection(rtcConfig);
  let hasIce = false;
  
  peerConnection.onicecandidate = (e) => {
    if (e.candidate) { hasIce = true; socket.emit('webrtc-ice', e.candidate); }
  };
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') displaySystemMessage('[SYSTEM] Direct encrypted P2P tunnel active.', 'success');
  };

  if (isCreator) {
    dataChannel = peerConnection.createDataChannel('drift-chat', { ordered: true, maxRetransmits: 3 });
    setupDataChannel();
  } else {
    peerConnection.ondatachannel = (e) => { dataChannel = e.channel; setupDataChannel(); };
  }
}

function setupDataChannel() {
  dataChannel.onopen = () => displaySystemMessage('Secure data tunnel ready.', 'success');
  dataChannel.onclose = () => displaySystemMessage('Connection lost.', 'danger');
  
  dataChannel.onmessage = async (event) => {
    let payload;
    try {
      const parsed = JSON.parse(event.data);
      if (parsed.e2ee) {
        const decrypted = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.iv)) }, e2eeKey, base64ToBuffer(parsed.ct)
        );
        payload = JSON.parse(new TextDecoder().decode(decrypted));
      } else { payload = parsed; }
    } catch (err) { return; }

    if (payload.type === 'obfuscation') return;

    // READ RECEIPT LOGIC (Sender receives this)
    if (payload.type === 'seen_ack') {
      const statusEl = document.getElementById('status-' + payload.msgId);
      if (statusEl && !statusEl.classList.contains('expired')) {
        statusEl.textContent = '✓✓ Seen';
        statusEl.classList.add('seen');
      }
      return;
    }
    
    // IMAGE BLUR EVENT (Sender receives this when receiver closes modal)
    if (payload.type === 'image_expired') {
      const localImg = document.querySelector(`#msg-${payload.msgId} img`);
      if (localImg) localImg.classList.add('blurred-media');
      const statusEl = document.getElementById('status-' + payload.msgId);
      if (statusEl) {
        statusEl.textContent = 'Expired';
        statusEl.classList.add('expired');
      }
      return;
    }

    // NEW MESSAGE (Receiver renders and replies with seen_ack)
    if (payload.type === 'text' || payload.type === 'image' || payload.type === 'voice') {
      renderMessage(payload, false);
      // Auto-reply read receipt
      if (payload.msgId) sendEncryptedPayload({ type: 'seen_ack', msgId: payload.msgId });
    }

    // === PHANTOM TRANSFER LOGIC ===
    else if (payload.type === 'phantom_start') {
      phantomMeta = payload; phantomBuffer = []; phantomReceivedSize = 0;
      document.getElementById('phantom-transfer-status').classList.remove('hidden');
      document.getElementById('transfer-text').innerText = "Receiving File...";
      document.getElementById('transfer-progress').value = 0;
    }
    else if (payload.type === 'phantom_chunk') {
      if (phantomMeta && phantomMeta.fileId === payload.fileId) {
        const buffer = base64ToBuffer(payload.data);
        phantomBuffer.push(buffer);
        phantomReceivedSize += buffer.byteLength;
        document.getElementById('transfer-progress').value = (phantomReceivedSize / phantomMeta.size) * 100;
      }
    }
    else if (payload.type === 'phantom_end') {
      if (phantomMeta && phantomMeta.fileId === payload.fileId) {
        document.getElementById('transfer-text').innerText = "Wiping RAM Cache...";
        const blob = new Blob(phantomBuffer, { type: phantomMeta.mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = phantomMeta.name; a.click();
        
        setTimeout(() => {
          URL.revokeObjectURL(url); phantomBuffer = []; phantomMeta = null;
          document.getElementById('phantom-transfer-status').classList.add('hidden');
          displaySystemMessage(`[PHANTOM] Received anonymous file. RAM wiped.`, 'success');
        }, 1500);
      }
    }
  };
}

socket.on('peer-joined', async () => {
  displaySystemMessage('[SYSTEM] Peer detected. Exchanging coordinates...', 'normal');
  if (isCreator) {
    if (!peerConnection) setupWebRTC();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', offer);
  }
});

socket.on('webrtc-offer', async (offer) => {
  if (!isCreator) {
    if (!peerConnection) setupWebRTC();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('webrtc-answer', answer);
  }
});

socket.on('webrtc-answer', async (answer) => { if (isCreator) await peerConnection.setRemoteDescription(new RTCSessionDescription(answer)); });
socket.on('webrtc-ice', async (candidate) => { if (peerConnection) peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{}); });

// ==========================================
// CHAT & MEDIA RENDERING
// ==========================================
async function handleSendText() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== 'open') return;
  
  const payload = { type: 'text', data: text, msgId: generateMsgId() };
  await sendEncryptedPayload(payload);
  renderMessage(payload, true);
  input.value = '';
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) { displaySystemMessage('[ERROR] Limit is 25MB.', 'danger'); event.target.value = ''; return; }

  showConfirm(`Send view-once image? It will blur after viewing.`, () => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const payload = { type: 'image', data: e.target.result, msgId: generateMsgId() };
      await sendEncryptedPayload(payload);
      renderMessage(payload, true);
    };
    reader.readAsDataURL(file);
    event.target.value = ''; 
  });
}

function renderMessage(payload, isMe) {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div');
  msgEl.className = `msg ${isMe ? 'outgoing' : 'incoming'}`;
  msgEl.id = `msg-${payload.msgId}`;

  if (payload.type === 'text') {
    const textNode = document.createElement('div');
    textNode.textContent = payload.data; 
    msgEl.appendChild(textNode);
  } else if (payload.type === 'image') {
    const img = document.createElement('img');
    img.src = payload.data;
    img.className = 'media-content clickable-media';
    
    // View-Once Modal Trigger
    img.onclick = () => {
      if (img.classList.contains('blurred-media')) return; // Block reopening
      document.getElementById('modal-img').src = payload.data;
      const modal = document.getElementById('media-modal');
      modal.dataset.activeMsgId = payload.msgId; // Link modal to message
      modal.classList.remove('hidden');
    };
    msgEl.appendChild(img);
  }

  // Inject Sent Status at bottom if sender
  if (isMe && payload.msgId) {
    const status = document.createElement('div');
    status.className = 'msg-status';
    status.id = `status-${payload.msgId}`;
    status.textContent = '✓ Sent';
    msgEl.appendChild(status);
  }

  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

function triggerMediaExpire(event) {
  if(event) event.stopPropagation(); // Stop bubbling
  const modal = document.getElementById('media-modal');
  modal.classList.add('hidden');
  
  const msgId = modal.dataset.activeMsgId;
  if (msgId) {
    // Blur receiver's local image
    const localImg = document.querySelector(`#msg-${msgId} img`);
    if (localImg) localImg.classList.add('blurred-media');
    
    // Tell sender we finished viewing
    sendEncryptedPayload({ type: 'image_expired', msgId: msgId });
    modal.dataset.activeMsgId = '';
  }
}

function displaySystemMessage(text, type = 'normal') {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div'); msgEl.className = `msg system ${type}`; msgEl.textContent = text;
  container.appendChild(msgEl); container.scrollTop = container.scrollHeight;
}

// ==========================================
// PHANTOM FILE TRANSFER SENDER
// ==========================================
async function startPhantomTransfer(event) {
  const file = event.target.files[0];
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

  if (file.size > MAX_FILE_SIZE) { displaySystemMessage('[ERROR] File exceeds 25MB limit.', 'danger'); event.target.value = ''; return; }

  const ext = file.name.split('.').pop();
  const anonymousName = "drift_phantom_" + Math.random().toString(36).substring(2, 10) + (ext ? `.${ext}` : '');
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const fileId = Date.now().toString();

  document.getElementById('phantom-transfer-status').classList.remove('hidden');
  document.getElementById('transfer-text').innerText = "Encrypting & Sending...";
  document.getElementById('transfer-progress').value = 0;

  await sendEncryptedPayload({ type: 'phantom_start', fileId, name: anonymousName, size: file.size, mime: file.type, totalChunks });

  let currentChunk = 0; const reader = new FileReader();

  const sendNext = async () => {
    if (dataChannel.readyState !== 'open') return;
    const start = currentChunk * CHUNK_SIZE;
    const slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));

    reader.onload = async (e) => {
      await sendEncryptedPayload({ type: 'phantom_chunk', fileId, chunkIndex: currentChunk, data: bufferToBase64(e.target.result) });
      currentChunk++;
      document.getElementById('transfer-progress').value = (currentChunk / totalChunks) * 100;
      
      if (currentChunk < totalChunks) { setTimeout(sendNext, 5); } 
      else {
        await sendEncryptedPayload({ type: 'phantom_end', fileId });
        document.getElementById('transfer-text').innerText = "Complete. Memory wiped.";
        displaySystemMessage(`[PHANTOM] Sent anonymous file. Cache cleared.`, 'success');
        setTimeout(() => document.getElementById('phantom-transfer-status').classList.add('hidden'), 3000);
        event.target.value = '';
      }
    };
    reader.readAsArrayBuffer(slice);
  };
  sendNext();
}

// ==========================================
// VOICE CALLING ENGINE
// ==========================================
function requestCall() {
  if (isCallActive) return; amICaller = true; socket.emit('call-request', { isVideo: false });
  displaySystemMessage(`Dialing peer for Voice Call...`);
}
socket.on('call-request', () => {
  if (isCallActive) return socket.emit('call-response', { accepted: false, reason: 'Busy' });
  amICaller = false; document.getElementById('incoming-call-type').textContent = `Incoming Voice Call`;
  document.getElementById('incoming-call-modal').classList.remove('hidden');
});
async function acceptCall() {
  document.getElementById('incoming-call-modal').classList.add('hidden'); displaySystemMessage('[SYSTEM] Connecting voice...', 'normal');
  await startCallEngine(); socket.emit('call-response', { accepted: true }); 
}
function rejectCall() { document.getElementById('incoming-call-modal').classList.add('hidden'); socket.emit('call-response', { accepted: false }); }

socket.on('call-response', async (data) => {
  if (data.accepted) { displaySystemMessage('Call accepted. Connecting...', 'success'); await startCallEngine(); } 
  else { displaySystemMessage(`Call declined.`, 'danger'); amICaller = false; }
});

async function startCallEngine() {
  isCallActive = true; document.getElementById('call-ui').classList.remove('hidden');
  try {
    callStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    callConnection = new RTCPeerConnection(rtcConfig);
    callConnection.onicecandidate = (e) => { if (e.candidate) socket.emit('call-ice', e.candidate); };
    callConnection.ontrack = (e) => {
      const audio = document.getElementById('remote-audio');
      if (audio.srcObject !== e.streams[0]) {
        audio.srcObject = e.streams[0]; audio.muted = true;
        setupAudioAmplifier(e.streams[0]); audio.play().catch(()=>{});
      }
    };
    callStream.getTracks().forEach(t => callConnection.addTrack(t, callStream));
    if (amICaller) { const offer = await callConnection.createOffer(); await callConnection.setLocalDescription(offer); socket.emit('call-offer', offer); }
  } catch (err) { endCall(); }
}

socket.on('call-offer', async (offer) => {
  if (!isCallActive) return; await callConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await callConnection.createAnswer(); await callConnection.setLocalDescription(answer); socket.emit('call-answer', answer);
});
socket.on('call-answer', async (answer) => { if (isCallActive) await callConnection.setRemoteDescription(new RTCSessionDescription(answer)); });
socket.on('call-ice', async (candidate) => { if (callConnection) callConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{}); });

function toggleCallMic() {
  if (!callStream) return; const audioTrack = callStream.getAudioTracks()[0];
  if (audioTrack) { audioTrack.enabled = !audioTrack.enabled; document.getElementById('toggle-call-mic-btn').style.color = audioTrack.enabled ? 'inherit' : 'var(--danger)'; }
}

function setupAudioAmplifier(stream) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (sourceNode) sourceNode.disconnect(); if (gainNode) gainNode.disconnect();
  sourceNode = audioCtx.createMediaStreamSource(stream); gainNode = audioCtx.createGain();
  gainNode.gain.value = 1.5; sourceNode.connect(gainNode); gainNode.connect(audioCtx.destination);
}
function adjustVolume(value) { if (gainNode) gainNode.gain.value = parseFloat(value); }

function endCall() {
  if (!isCallActive) return; isCallActive = false; amICaller = false;
  if (callStream) callStream.getTracks().forEach(t => t.stop()); if (callConnection) callConnection.close();
  if (sourceNode) sourceNode.disconnect(); if (gainNode) gainNode.disconnect();
  document.getElementById('remote-audio').srcObject = null; document.getElementById('call-ui').classList.add('hidden');
  socket.emit('call-end'); displaySystemMessage('Call ended.', 'normal');
}
socket.on('call-end', () => { if (isCallActive) endCall(); });

// ==========================================
// MEMORY PURGE
// ==========================================
function performLocalPurge() {
  if (peerConnection) peerConnection.close(); if (callConnection) callConnection.close();
  if (callStream) callStream.getTracks().forEach(t => t.stop()); if (audioCtx) audioCtx.close();
  document.getElementById('messages-container').innerHTML = '';
  document.getElementById('chat-view').classList.add('hidden');
  document.getElementById('lobby-view').classList.remove('hidden');
  currentRoomId = null; currentPassword = null; e2eeKey = null; phantomBuffer = [];
}
function requestPurge() {
  showConfirm("Destroy chat?", () => { socket.emit('shred-room'); document.getElementById('purge-alert').classList.remove('hidden'); performLocalPurge(); setTimeout(() => document.getElementById('purge-alert').classList.add('hidden'), 3500); });
}
socket.on('room-shredded', () => { document.getElementById('purge-alert').classList.remove('hidden'); performLocalPurge(); setTimeout(() => document.getElementById('purge-alert').classList.add('hidden'), 3500); });

// ==========================================
// MANDATORY MANIFESTO
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  const agreeBtn = document.getElementById('agree-manifesto-btn'); let timeLeft = 5; 
  const timerInterval = setInterval(() => {
    timeLeft--; if (timeLeft <= 0) {
      clearInterval(timerInterval);
      document.getElementById('large-manifesto-timer').textContent = '00:00';
      agreeBtn.textContent = 'I UNDERSTAND AND AGREE'; agreeBtn.disabled = false;
      agreeBtn.addEventListener('click', () => document.getElementById('manifesto-overlay').classList.add('hidden'));
    }
  }, 1000);
});

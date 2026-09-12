const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? 'http://localhost:3000' 
  : 'https://drift-backend-nkru.onrender.com';

const socket = io(BACKEND_URL, {
  transports: ['websocket', 'polling'] 
});

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

// --- NEW: File Transfer Queue Engine ---
const CHUNK_SIZE = 65536; 
const incomingFiles = {};
let activeSendAborts = new Map();
let fileUploadQueue = [];
let isUploading = false;
// ---------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

window.addEventListener('beforeunload', (e) => {
  if (currentRoomId) {
    e.preventDefault();
    e.returnValue = 'Warning: Leaving or reloading destroys this ephemeral chat.';
  }
});

// ==========================================
// DYNAMIC HARDWARE & STORAGE BUDGETING
// ==========================================
async function calculateStorageBudget() {
  let safeLimit = 100 * 1024 * 1024; 
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota) safeLimit = Math.floor((quota - (usage || 0)) * 0.35);
    } else if (navigator.deviceMemory) {
      safeLimit = Math.floor(navigator.deviceMemory * 256 * 1024 * 1024);
    }
  } catch (err) {}
  return Math.max(50 * 1024 * 1024, Math.min(safeLimit, 4 * 1024 * 1024 * 1024));
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024, dm = decimals < 0 ? 0 : decimals, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function refreshDynamicQuotaDisplay() {
  try {
    const budget = await calculateStorageBudget();
    const label = document.getElementById('storage-budget-display');
    if (label) label.textContent = `DEVICE LIMIT: ~${formatBytes(budget)}`;
  } catch (err) {}
}

// ==========================================
// E2EE CRYPTOGRAPHY ENGINE
// ==========================================
async function setupE2EEKey(password) {
  try {
    const keyMaterial = await window.crypto.subtle.digest('SHA-256', textEncoder.encode(password));
    e2eeKey = await window.crypto.subtle.importKey(
      'raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    );
  } catch (err) {
    displaySystemMessage('[ERROR] Cryptography engine failed to initialize.', 'danger');
    throw err;
  }
}

async function hashPasswordForServer(password) {
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', textEncoder.encode(password + "drift_server_salt"));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return window.btoa(bin);
}

function base64ToBuffer(base64) {
  const bin = window.atob(base64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function sendEncryptedPayload(payloadObj) {
  if (!e2eeKey || !dataChannel || dataChannel.readyState !== 'open') {
    displaySystemMessage('[ERROR] Cannot send data. Secure tunnel is not open.', 'danger');
    return;
  }
  try {
    const plainText = JSON.stringify(payloadObj);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, e2eeKey, textEncoder.encode(plainText));
    dataChannel.send(JSON.stringify({ e2ee: true, iv: bufferToBase64(iv), ct: bufferToBase64(ciphertext) }));
  } catch (e) { displaySystemMessage('[ERROR] Payload encryption failed.', 'danger'); }
}

// ==========================================
// UI UTILITIES
// ==========================================
function switchTab(tab) {
  document.getElementById('error-message').textContent = '';
  document.getElementById('create-form').classList.toggle('hidden', tab !== 'create');
  document.getElementById('join-form').classList.toggle('hidden', tab !== 'join');
  document.getElementById('tab-create-btn').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join-btn').classList.toggle('active', tab === 'join');
}

function universalCopy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const textArea = document.createElement('textarea'); textArea.value = text;
    textArea.style.position = 'fixed'; textArea.style.left = '-999999px';
    document.body.appendChild(textArea); textArea.focus(); textArea.select();
    document.execCommand('copy'); textArea.remove();
    return Promise.resolve();
  } catch (err) { return Promise.reject(err); }
}

function copyData(elementId, btn) {
  universalCopy(document.getElementById(elementId).innerText).then(() => {
    btn.innerText = "COPIED!"; setTimeout(() => { btn.innerText = "COPY"; }, 1500);
  }).catch(() => { btn.innerText = "FAILED"; });
}

function quickCopyText(textElementId, iconContainerId) {
  universalCopy(document.getElementById(textElementId).innerText).then(() => {
    const iconNode = document.getElementById(iconContainerId); const originalHTML = iconNode.innerHTML;
    iconNode.innerHTML = `<span style="color:var(--primary); font-size: 0.75rem; font-weight: bold;">COPIED!</span>`;
    setTimeout(() => { iconNode.innerHTML = originalHTML; }, 1500);
  });
}

function showConfirm(message, callback) {
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-modal').classList.remove('hidden'); confirmCallback = callback;
}
function executeConfirm() { document.getElementById('confirm-modal').classList.add('hidden'); if (confirmCallback) confirmCallback(); }
function cancelConfirm() { document.getElementById('confirm-modal').classList.add('hidden'); confirmCallback = null; }
function openInfoModal() { document.getElementById('info-modal').classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ==========================================
// SECURE HANDSHAKE
// ==========================================
async function handleCreate(e) {
  if (e) e.preventDefault();
  try {
    currentPassword = document.getElementById('create-password').value;
    await setupE2EEKey(currentPassword);
    const serverSafePassword = await hashPasswordForServer(currentPassword);

    socket.emit('create-room', { password: serverSafePassword }, (res) => {
      if (res.success) {
        isCreator = true; currentRoomId = res.id;
        rtcConfig = { iceServers: res.iceServers, iceCandidatePoolSize: 10 };
        document.getElementById('lobby-view').classList.add('hidden');
        document.getElementById('success-view').classList.remove('hidden');
        document.getElementById('disp-id').innerText = currentRoomId;
        document.getElementById('disp-pass').innerText = currentPassword; 
        
        const inviteLink = `${window.location.origin}${window.location.pathname}#r=${currentRoomId}&p=${encodeURIComponent(currentPassword)}`;
        const linkDisp = document.getElementById('disp-link');
        if (linkDisp) linkDisp.innerText = inviteLink;
        
        setupWebRTC();
      } else {
        document.getElementById('error-message').textContent = '[ERROR] Server failed to create room.';
      }
    });
  } catch (err) { document.getElementById('error-message').textContent = 'Error during creation: ' + err.message; }
}

function enterGeneratedRoom() {
  openChatInterface(); displaySystemMessage('Waiting for your peer to join...');
}

async function handleJoin(e) {
  if (e) e.preventDefault();
  try {
    currentRoomId = document.getElementById('join-code').value.toUpperCase();
    currentPassword = document.getElementById('join-password').value;
    await setupE2EEKey(currentPassword);
    const serverSafePassword = await hashPasswordForServer(currentPassword);

    socket.emit('join-room', { id: currentRoomId, password: serverSafePassword }, (res) => {
      if (res.success) {
        isCreator = false; rtcConfig = { iceServers: res.iceServers, iceCandidatePoolSize: 10 };
        if (!peerConnection) setupWebRTC(); 
        openChatInterface();
        displaySystemMessage('[SYSTEM] Room joined. Negotiating direct P2P tunnel...', 'normal');
      } else {
        document.getElementById('error-message').textContent = res.error || 'Incorrect Room ID or Password.';
      }
    });
  } catch (err) { document.getElementById('error-message').textContent = 'Error joining: ' + err.message; }
}

function openChatInterface() {
  document.getElementById('lobby-view').classList.add('hidden');
  document.getElementById('success-view').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = currentRoomId;
  document.getElementById('room-pass-display').textContent = currentPassword;
  refreshDynamicQuotaDisplay();
}

// ==========================================
// WEBRTC & BINARY DATA CHANNEL
// ==========================================
function setupWebRTC() {
  try {
    if (peerConnection || !rtcConfig) return; 
    peerConnection = new RTCPeerConnection(rtcConfig);
    
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) socket.emit('webrtc-ice', event.candidate);
    };

    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      if (state === 'failed') {
        displaySystemMessage('[ERROR] Network firewall blocked connection. The TURN server may be unreachable.', 'danger');
      } else if (state === 'disconnected') {
        displaySystemMessage('[WARNING] Peer disconnected or network lost.', 'danger');
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') {
        displaySystemMessage('[SYSTEM] Direct encrypted P2P tunnel active. You can now chat securely.', 'success');
      }
    };

    if (isCreator) {
      dataChannel = peerConnection.createDataChannel('drift-chat', { ordered: true });
      setupDataChannel();
    } else {
      peerConnection.ondatachannel = (event) => { dataChannel = event.channel; setupDataChannel(); };
    }
  } catch (err) { displaySystemMessage(`[ERROR] WebRTC Init Failed: ${err.message}`, 'danger'); }
}

async function flushChatIceCandidates() {
  while (pendingChatIce.length > 0) {
    const candidate = pendingChatIce.shift();
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
  }
}

function setupDataChannel() {
  dataChannel.binaryType = 'arraybuffer';
  dataChannel.bufferedAmountLowThreshold = 256 * 1024; 

  dataChannel.onopen = () => displaySystemMessage('Secure binary tunnel ready.', 'success');
  dataChannel.onclose = () => displaySystemMessage('Connection lost.', 'danger');
  dataChannel.onerror = () => displaySystemMessage('[ERROR] Data channel error.', 'danger');
  
  dataChannel.onmessage = async (event) => {
    try {
      if (event.data instanceof ArrayBuffer) { await handleIncomingBinaryChunk(event.data); return; }

      let payload; const parsed = JSON.parse(event.data);
      if (parsed.e2ee) {
        const decrypted = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.iv)) }, e2eeKey, base64ToBuffer(parsed.ct)
        );
        payload = JSON.parse(textDecoder.decode(decrypted));
      } else { payload = parsed; }

      if (payload.type === 'obfuscation') return;
      if (payload.type === 'file_start') handleRemoteFileStart(payload);
      else if (payload.type === 'file_end') handleRemoteFileEnd(payload);
      else renderMessage(payload, false);
    } catch (err) {}
  };
}

// ==========================================
// HIGH-PERFORMANCE QUEUED FILE HANDLING
// ==========================================

function enqueueFile(file) {
  fileUploadQueue.push(file);
  if (!isUploading) processFileUploadQueue();
}

async function processFileUploadQueue() {
  isUploading = true;
  while (fileUploadQueue.length > 0) {
    const file = fileUploadQueue.shift();
    await sendFileStream(file);
  }
  isUploading = false;
}

async function sendFileStream(file) {
  return new Promise(async (resolveTransfer) => {
    try {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        displaySystemMessage('[ERROR] Cannot send file. Connection not active.', 'danger');
        return resolveTransfer();
      }

      const budget = await calculateStorageBudget();
      if (file.size > budget) {
        displaySystemMessage(`[SECURITY] File (${formatBytes(file.size)}) exceeds device safety limit (${formatBytes(budget)}).`, 'danger');
        return resolveTransfer();
      }

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const fileToken = Math.floor(Math.random() * 2147483647);
      const fileIdStr = fileToken.toString();

      await sendEncryptedPayload({
        type: 'file_start', fileId: fileIdStr, fileName: file.name, fileSize: file.size, mime: file.type || 'application/octet-stream', totalChunks: totalChunks
      });

      renderTransferProgress(fileIdStr, file.name, file.size, true);
      let currentChunk = 0; activeSendAborts.set(fileIdStr, false);

      async function pushStream() {
        try {
          while (currentChunk < totalChunks) {
            if (activeSendAborts.get(fileIdStr) || !dataChannel || dataChannel.readyState !== 'open') {
              removeTransferProgress(fileIdStr); activeSendAborts.delete(fileIdStr); return resolveTransfer();
            }

            if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
              await new Promise(r => { dataChannel.onbufferedamountlow = () => { dataChannel.onbufferedamountlow = null; r(); }; });
            }

            const rawChunk = await file.slice(currentChunk * CHUNK_SIZE, Math.min((currentChunk + 1) * CHUNK_SIZE, file.size)).arrayBuffer();
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encryptedData = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, e2eeKey, rawChunk);
            
            const packet = new Uint8Array(20 + encryptedData.byteLength);
            const view = new DataView(packet.buffer);
            view.setUint32(0, fileToken); view.setUint32(4, currentChunk);
            packet.set(iv, 8); packet.set(new Uint8Array(encryptedData), 20);

            dataChannel.send(packet.buffer);
            currentChunk++; updateTransferProgress(fileIdStr, currentChunk, totalChunks);

            // --- YIELD THREAD: Keeps UI buttery smooth ---
            if (currentChunk % 4 === 0) await new Promise(r => setTimeout(r, 2));
          }

          await sendEncryptedPayload({ type: 'file_end', fileId: fileIdStr });
          removeTransferProgress(fileIdStr); activeSendAborts.delete(fileIdStr);
          renderCompletedFileCard({ name: file.name, size: file.size, mime: file.type }, null, true);
          resolveTransfer();
        } catch (err) {
          displaySystemMessage(`[ERROR] File transmission interrupted.`, 'danger');
          resolveTransfer();
        }
      }
      pushStream();
    } catch (err) {
      displaySystemMessage(`[ERROR] Failed to initiate file transfer.`, 'danger');
      resolveTransfer();
    }
  });
}

function handleRemoteFileStart(meta) {
  incomingFiles[meta.fileId] = {
    name: meta.fileName, size: meta.fileSize, mime: meta.mime, totalChunks: meta.totalChunks, receivedChunks: 0, chunks: new Array(meta.totalChunks)
  };
  renderTransferProgress(meta.fileId, meta.fileName, meta.size, false);
}

async function handleIncomingBinaryChunk(buffer) {
  if (buffer.byteLength < 20 || !e2eeKey) return;
  try {
    const view = new DataView(buffer);
    const fileIdStr = view.getUint32(0).toString();
    const session = incomingFiles[fileIdStr];
    if (!session) return;

    const decryptedChunk = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(buffer, 8, 12) }, e2eeKey, new Uint8Array(buffer, 20));

    session.chunks[view.getUint32(4)] = decryptedChunk;
    session.receivedChunks++;
    updateTransferProgress(fileIdStr, session.receivedChunks, session.totalChunks);

    // --- YIELD THREAD ON RECEIVE ---
    if (session.receivedChunks % 4 === 0) await new Promise(r => setTimeout(r, 2));
  } catch (err) {}
}

function handleRemoteFileEnd(payload) {
  try {
    const session = incomingFiles[payload.fileId]; if (!session) return;
    removeTransferProgress(payload.fileId);
    const fileBlob = new Blob(session.chunks, { type: session.mime || 'application/octet-stream' });
    delete incomingFiles[payload.fileId]; 
    renderCompletedFileCard({ name: session.name, size: session.size, mime: session.mime }, URL.createObjectURL(fileBlob), false);
  } catch (err) { displaySystemMessage(`[ERROR] Failed to compile received file.`, 'danger'); }
}

// ==========================================
// FILE UI & CARD RENDERING
// ==========================================
function renderTransferProgress(id, name, size, isUploading) {
  const container = document.getElementById('messages-container');
  const progressBox = document.createElement('div');
  progressBox.className = `msg system file-progress-card`; progressBox.id = `transfer-${id}`;
  progressBox.innerHTML = `
    <div class="progress-info"><span class="file-name">${name}</span><span class="file-action">${isUploading ? 'UPLOADING' : 'RECEIVING'} (${formatBytes(size)})</span></div>
    <div class="progress-track"><div class="progress-fill" id="bar-${id}" style="width: 0%;"></div></div>
    <div class="progress-percent" id="pct-${id}">0%</div>`;
  container.appendChild(progressBox); container.scrollTop = container.scrollHeight;
}
function updateTransferProgress(id, current, total) {
  const percent = Math.min(100, Math.round((current / total) * 100));
  const bar = document.getElementById(`bar-${id}`); const text = document.getElementById(`pct-${id}`);
  if (bar) bar.style.width = `${percent}%`; if (text) text.textContent = `${percent}%`;
}
function removeTransferProgress(id) { const card = document.getElementById(`transfer-${id}`); if (card) card.remove(); }
function renderCompletedFileCard(fileInfo, blobUrl, isMe) {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div'); msgEl.className = `msg ${isMe ? 'outgoing' : 'incoming'} file-msg-card`;

  if (fileInfo.mime.startsWith('image/') && blobUrl && fileInfo.size < 50 * 1024 * 1024) {
    const img = document.createElement('img'); img.src = blobUrl; img.className = 'media-content clickable-media';
    img.onclick = () => { document.getElementById('modal-img').src = blobUrl; document.getElementById('media-modal').classList.remove('hidden'); };
    msgEl.appendChild(img);
  } else if (fileInfo.mime.startsWith('audio/') && blobUrl) {
    const audio = document.createElement('audio'); audio.src = blobUrl; audio.controls = true; audio.playsInline = true; audio.className = 'media-content';
    msgEl.appendChild(audio);
  }

  const fileDetail = document.createElement('div'); fileDetail.className = 'file-payload-details';
  fileDetail.innerHTML = `<div class="file-meta"><svg class="file-icon" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg><div class="file-info-text"><strong class="file-title">${fileInfo.name}</strong><span class="file-size-badge">${formatBytes(fileInfo.size)}</span></div></div>`;

  if (blobUrl) {
    const downloadBtn = document.createElement('a'); downloadBtn.href = blobUrl; downloadBtn.download = fileInfo.name; downloadBtn.className = 'btn-file-download'; downloadBtn.textContent = 'DOWNLOAD FILE';
    fileDetail.appendChild(downloadBtn);
  } else {
    const sentBadge = document.createElement('span'); sentBadge.className = 'sent-badge'; sentBadge.textContent = 'SENT SUCCESSFULLY';
    fileDetail.appendChild(sentBadge);
  }
  msgEl.appendChild(fileDetail); container.appendChild(msgEl); container.scrollTop = container.scrollHeight;
}

// ==========================================
// TEXT, AUDIO & CALL LOGIC
// ==========================================
async function handleSendText() {
  const input = document.getElementById('message-input'); const text = input.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== 'open') return;
  try {
    const payload = { type: 'text', data: text };
    await sendEncryptedPayload(payload);
    renderMessage(payload, true); input.value = '';
  } catch(e) { displaySystemMessage('[ERROR] Failed to send text.', 'danger'); }
}

function handleFileSelect(event) {
  try {
    const files = Array.from(event.target.files);
    if (!files.length) return;
    showConfirm(`Send ${files.length} file(s)?`, () => { 
      files.forEach(file => enqueueFile(file)); 
      event.target.value = ''; 
    });
  } catch (err) { displaySystemMessage(`[ERROR] File selection failed.`, 'danger'); }
}

async function toggleMic() {
  if (!dataChannel || dataChannel.readyState !== 'open') { displaySystemMessage('[ERROR] Connection not ready.', 'danger'); return; }
  try {
    if (!isRecording) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let selectedMimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
      mediaRecorder = new MediaRecorder(stream, selectedMimeType ? { mimeType: selectedMimeType } : {});
      audioChunks = [];
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: selectedMimeType || 'audio/mp4' });
        enqueueFile(new File([audioBlob], `voice_${Date.now()}.${selectedMimeType.includes('mp4') ? 'mp4' : 'webm'}`, { type: audioBlob.type }));
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorder.start(); isRecording = true; document.getElementById('mic-btn').classList.add('recording');
    } else {
      mediaRecorder.stop(); isRecording = false; document.getElementById('mic-btn').classList.remove('recording');
    }
  } catch (err) { displaySystemMessage(`[ERROR] Mic denied.`, 'danger'); }
}

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
  document.getElementById('incoming-call-modal').classList.add('hidden'); displaySystemMessage('[SYSTEM] Connecting voice hardware...', 'normal');
  try { await startCallEngine(); socket.emit('call-response', { accepted: true }); }
  catch (err) { displaySystemMessage(`[ERROR] Call start failed.`, 'danger'); }
}

function rejectCall() { document.getElementById('incoming-call-modal').classList.add('hidden'); socket.emit('call-response', { accepted: false }); }

socket.on('call-response', async (data) => {
  if (data.accepted) {
    displaySystemMessage('Call accepted. Connecting...', 'success');
    try { await startCallEngine(); } catch (err) {}
  } else {
    displaySystemMessage(`Call declined${data.reason ? ' (' + data.reason + ')' : ''}.`, 'danger'); amICaller = false;
  }
});

async function startCallEngine() {
  isCallActive = true; document.getElementById('call-ui').classList.remove('hidden');
  try {
    callStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    callConnection = new RTCPeerConnection(rtcConfig);
    
    callConnection.onicecandidate = (event) => { if (event.candidate) socket.emit('call-ice', event.candidate); };
    callConnection.ontrack = (event) => {
      const remoteAudio = document.getElementById('remote-audio');
      if (remoteAudio.srcObject !== event.streams[0]) {
        remoteAudio.srcObject = event.streams[0]; remoteAudio.muted = true;
        setupAudioAmplifier(event.streams[0]); remoteAudio.play().catch(() => {});
      }
    };
    callStream.getTracks().forEach(track => { callConnection.addTrack(track, callStream); });

    if (amICaller) {
      const offer = await callConnection.createOffer(); await callConnection.setLocalDescription(offer);
      socket.emit('call-offer', offer);
    }
  } catch (err) { displaySystemMessage(`[CALL ERROR] Mic setup failed.`, 'danger'); endCall(); }
}

socket.on('call-offer', async (offer) => {
  if (!isCallActive || !callConnection) return;
  try {
    await callConnection.setRemoteDescription(new RTCSessionDescription(offer));
    while (pendingCallIce.length) { callConnection.addIceCandidate(new RTCIceCandidate(pendingCallIce.shift())).catch(() => {}); }
    const answer = await callConnection.createAnswer(); await callConnection.setLocalDescription(answer);
    socket.emit('call-answer', answer);
  } catch (err) {}
});

socket.on('call-answer', async (answer) => {
  if (!isCallActive || !callConnection) return;
  try {
    await callConnection.setRemoteDescription(new RTCSessionDescription(answer));
    while (pendingCallIce.length) { callConnection.addIceCandidate(new RTCIceCandidate(pendingCallIce.shift())).catch(() => {}); }
  } catch (err) {}
});

socket.on('call-ice', async (candidate) => {
  if (callConnection && callConnection.remoteDescription && callConnection.remoteDescription.type) {
    callConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  } else { pendingCallIce.push(candidate); }
});

function toggleCallMic() {
  if (!callStream) return; const audioTrack = callStream.getAudioTracks()[0];
  if (audioTrack) { audioTrack.enabled = !audioTrack.enabled; document.getElementById('toggle-call-mic-btn').style.color = audioTrack.enabled ? 'inherit' : 'var(--danger)'; }
}

function setupAudioAmplifier(stream) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (sourceNode) sourceNode.disconnect(); if (gainNode) gainNode.disconnect();
    sourceNode = audioCtx.createMediaStreamSource(stream); gainNode = audioCtx.createGain();
    const slider = document.getElementById('volume-slider'); gainNode.gain.value = slider ? parseFloat(slider.value) : 1.5;
    sourceNode.connect(gainNode); gainNode.connect(audioCtx.destination);
  } catch (err) {}
}

function adjustVolume(value) {
  if (gainNode) { gainNode.gain.value = parseFloat(value); }
  else { const remoteAudio = document.getElementById('remote-audio'); if (remoteAudio) { remoteAudio.muted = false; remoteAudio.volume = Math.min(parseFloat(value), 1.0); } }
}

function endCall() {
  if (!isCallActive) return; isCallActive = false; amICaller = false;
  if (callStream) { callStream.getTracks().forEach(track => track.stop()); callStream = null; }
  if (callConnection) { callConnection.close(); callConnection = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (gainNode) { gainNode.disconnect(); gainNode = null; }
  const remoteAudio = document.getElementById('remote-audio'); if (remoteAudio) remoteAudio.srcObject = null;
  document.getElementById('call-ui').classList.add('hidden'); socket.emit('call-end'); displaySystemMessage('Call ended.', 'normal');
}
socket.on('call-end', () => { if (isCallActive) endCall(); });

function renderMessage(payload, isMe) {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div'); msgEl.className = `msg ${isMe ? 'outgoing' : 'incoming'}`;
  if (payload.type === 'text') { const textNode = document.createElement('div'); textNode.textContent = payload.data; msgEl.appendChild(textNode); }
  container.appendChild(msgEl); container.scrollTop = container.scrollHeight;
}
function displaySystemMessage(text, type = 'normal') {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div'); msgEl.className = `msg system ${type}`; msgEl.textContent = text;
  container.appendChild(msgEl); container.scrollTop = container.scrollHeight;
}

function performLocalPurge() {
  try {
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (callConnection) { callConnection.close(); callConnection = null; }
    if (callStream) { callStream.getTracks().forEach(t => t.stop()); callStream = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (gainNode) { gainNode.disconnect(); gainNode = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }

    pendingChatIce = []; pendingCallIce = []; fileUploadQueue = []; isUploading = false;
    document.getElementById('messages-container').innerHTML = '';
    document.getElementById('chat-view').classList.add('hidden'); document.getElementById('call-ui').classList.add('hidden');
    document.getElementById('incoming-call-modal').classList.add('hidden'); document.getElementById('lobby-view').classList.remove('hidden');
    currentRoomId = null; currentPassword = null; e2eeKey = null; isCallActive = false;
  } catch (err) {}
}

function requestPurge() {
  showConfirm("Are you sure you want to leave and destroy the chat?", () => {
    socket.emit('shred-room'); const alertModal = document.getElementById('purge-alert'); alertModal.classList.remove('hidden');
    performLocalPurge(); setTimeout(() => alertModal.classList.add('hidden'), 3500); 
  });
}
socket.on('room-shredded', () => {
  const alertModal = document.getElementById('purge-alert'); alertModal.classList.remove('hidden');
  performLocalPurge(); setTimeout(() => alertModal.classList.add('hidden'), 3500); 
});

setInterval(() => {
  if (dataChannel && dataChannel.readyState === 'open') {
    try {
      const randomSize = Math.floor(Math.random() * 128) + 16;
      const garbage = new Uint8Array(randomSize); crypto.getRandomValues(garbage);
      sendEncryptedPayload({ type: 'obfuscation', data: Array.from(garbage) });
    } catch (e) {}
  }
}, Math.random() * 4000 + 2000);

socket.on('peer-joined', async () => {
  displaySystemMessage('[SYSTEM] Peer detected. Exchanging coordinates...', 'normal');
  if (isCreator) {
    try {
      if (!peerConnection) setupWebRTC();
      const offer = await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc-offer', offer);
    } catch (err) { displaySystemMessage(`[ERROR] Offer creation failed.`, 'danger'); }
  }
});

socket.on('webrtc-offer', async (offer) => {
  if (!isCreator) {
    try {
      if (!peerConnection) setupWebRTC();
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer(); await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc-answer', answer);
      await flushChatIceCandidates();
    } catch (err) { displaySystemMessage(`[ERROR] Processing offer failed.`, 'danger'); }
  }
});

socket.on('webrtc-answer', async (answer) => {
  if (isCreator) {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      await flushChatIceCandidates();
    } catch (err) { displaySystemMessage(`[ERROR] Processing answer failed.`, 'danger'); }
  }
});

socket.on('webrtc-ice', async (candidate) => {
  try {
    if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } else { pendingChatIce.push(candidate); }
  } catch (err) {}
});

// ==========================================
// AUTO-JOIN ROUTING & MANIFESTO LOGIC
// ==========================================
let autoJoinData = null;
document.addEventListener('DOMContentLoaded', () => {
  if (window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    if (hashParams.has('r') && hashParams.has('p')) {
      autoJoinData = { room: hashParams.get('r'), pass: hashParams.get('p') };
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  const agreeBtn = document.getElementById('agree-manifesto-btn');
  const timerDisplay = document.getElementById('manifesto-timer');
  const largeTimerDisplay = document.getElementById('large-manifesto-timer');
  let timeLeft = 5; updateTimerDisplay();

  const timerInterval = setInterval(() => {
    timeLeft--; updateTimerDisplay();
    if (timeLeft <= 0) { clearInterval(timerInterval); unlockManifesto(); }
  }, 1000);

  function updateTimerDisplay() {
    const minutes = Math.floor(timeLeft / 60); const seconds = timeLeft % 60;
    const formattedTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    if (timerDisplay) timerDisplay.textContent = `(${formattedTime})`;
    if (largeTimerDisplay) largeTimerDisplay.textContent = formattedTime;
  }

  function unlockManifesto() {
    if (timerDisplay) timerDisplay.textContent = '';
    if (largeTimerDisplay) { largeTimerDisplay.textContent = '00:00'; largeTimerDisplay.style.color = 'var(--primary)'; }
    if (agreeBtn) {
      agreeBtn.textContent = 'I UNDERSTAND AND AGREE'; agreeBtn.disabled = false; agreeBtn.classList.remove('disabled-btn');
      agreeBtn.addEventListener('click', () => { 
        document.getElementById('manifesto-overlay').classList.add('hidden'); 
        if (autoJoinData) {
          switchTab('join');
          document.getElementById('join-code').value = autoJoinData.room;
          document.getElementById('join-password').value = autoJoinData.pass;
          handleJoin({ preventDefault: () => {} });
        }
      });
    }
  }
});

// --- LAYER 1: ANTI-INSPECT SHIELD ---
document.addEventListener('contextmenu', event => event.preventDefault());

document.addEventListener('keydown', (e) => {
  if (
    e.key === 'F12' || 
    (e.ctrlKey && e.shiftKey && ['I', 'i', 'J', 'j', 'C', 'c'].includes(e.key)) || 
    (e.ctrlKey && ['U', 'u'].includes(e.key))
  ) {
    e.preventDefault();
    triggerTamperLockdown();
  }
});

setInterval(() => {
  const start = performance.now();
  debugger; 
  if (performance.now() - start > 100) {
    triggerTamperLockdown();
  }
}, 1000);

function triggerTamperLockdown() {
  document.body.innerHTML = `
    <div style="background:#000; color:red; height:100vh; width:100vw; display:flex; flex-direction:column; justify-content:center; align-items:center; font-family:monospace; text-align:center; padding: 20px;">
      <h1 style="font-size:2rem; margin-bottom:10px;">SECURITY LOCKDOWN</h1>
      <p style="font-size:1rem;">Developer tools are disabled for your privacy. Please refresh to try again.</p>
    </div>
  `;
  if (socket) socket.disconnect();
  performLocalPurge();
}


// --- LAYER 2: CORE P2P LOGIC ---

// UPDATED: Dynamic environment detection for separated hosting
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? 'http://localhost:3000' 
  : 'https://drift-backend-nkru.onrender.com/'; // IMPORTANT: Change this to your actual Fly.io URL!

// Initialize socket with the external URL or localhost
// Include standard polling fallback for Vercel/Fly
const socket = io(BACKEND_URL, {
  transports: ['websocket', 'polling'] 
});

let currentRoomId = null;
let currentPassword = null;

// P2P Data Variables
let peerConnection;
let dataChannel;
let chatIceQueue = []; 
let isCreator = false;

// Media Variables
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

// Call Variables
let callConnection = null;
let callStream = null;
let callIceQueue = []; 
let isVideoCall = false;
let amICaller = false;
let isCallActive = false;

let confirmCallback = null;

const rtcConfig = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ] 
};

window.addEventListener('beforeunload', (e) => {
  if (currentRoomId) {
    e.preventDefault();
    e.returnValue = 'Warning: Refreshing the page will permanently destroy this chat.';
  }
});

function switchTab(tab) {
  document.getElementById('error-message').textContent = '';
  document.getElementById('create-form').classList.toggle('hidden', tab !== 'create');
  document.getElementById('join-form').classList.toggle('hidden', tab !== 'join');
  document.getElementById('tab-create-btn').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join-btn').classList.toggle('active', tab === 'join');
}

function copyData(elementId, btn) {
  const text = document.getElementById(elementId).innerText;
  navigator.clipboard.writeText(text).then(() => {
    btn.innerText = "COPIED!";
    setTimeout(() => { btn.innerText = "COPY"; }, 1500);
  }).catch(() => alert("Copy requires HTTPS connection."));
}

function quickCopyText(textElementId, iconContainerId) {
  const text = document.getElementById(textElementId).innerText;
  navigator.clipboard.writeText(text).then(() => {
    const iconNode = document.getElementById(iconContainerId);
    const originalHTML = iconNode.innerHTML;
    iconNode.innerHTML = `<span style="color:var(--primary); font-size: 0.75rem; font-weight: bold;">COPIED!</span>`;
    setTimeout(() => { iconNode.innerHTML = originalHTML; }, 1500);
  });
}

function showConfirm(message, callback) {
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-modal').classList.remove('hidden');
  confirmCallback = callback;
}
function executeConfirm() {
  document.getElementById('confirm-modal').classList.add('hidden');
  if (confirmCallback) confirmCallback();
}
function cancelConfirm() {
  document.getElementById('confirm-modal').classList.add('hidden');
  confirmCallback = null;
}

function openInfoModal() { document.getElementById('info-modal').classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// --- CONNECTION HANDSHAKE ---

function handleCreate(e) {
  e.preventDefault();
  currentPassword = document.getElementById('create-password').value;
  socket.emit('create-room', { password: currentPassword }, (res) => {
    if (res.success) {
      isCreator = true;
      currentRoomId = res.id;
      document.getElementById('lobby-view').classList.add('hidden');
      document.getElementById('success-view').classList.remove('hidden');
      document.getElementById('disp-id').innerText = currentRoomId;
      document.getElementById('disp-pass').innerText = currentPassword;
      setupWebRTC();
    }
  });
}

function enterGeneratedRoom() {
  openChatInterface();
  displaySystemMessage('Waiting for your friend to join...');
}

function handleJoin(e) {
  e.preventDefault();
  currentRoomId = document.getElementById('join-code').value.toUpperCase();
  currentPassword = document.getElementById('join-password').value;

  socket.emit('join-room', { id: currentRoomId, password: currentPassword }, (res) => {
    if (res.success) {
      isCreator = false;
      setupWebRTC();
      openChatInterface();
    } else {
      document.getElementById('error-message').textContent = 'Incorrect Room ID or Password.';
    }
  });
}

function openChatInterface() {
  document.getElementById('lobby-view').classList.add('hidden');
  document.getElementById('success-view').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = currentRoomId;
  document.getElementById('room-pass-display').textContent = currentPassword;
}

// --- SECURE TEXT & FILE WEBRTC ---

function setupWebRTC() {
  peerConnection = new RTCPeerConnection(rtcConfig);
  chatIceQueue = [];

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) socket.emit('webrtc-ice', event.candidate);
  };

  if (isCreator) {
    dataChannel = peerConnection.createDataChannel('drift-chat');
    setupDataChannel();
  } else {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel();
    };
  }
}

function setupDataChannel() {
  dataChannel.onopen = () => displaySystemMessage('Secure connection established.', 'success');
  dataChannel.onclose = () => displaySystemMessage('Connection lost.', 'danger');
  dataChannel.onmessage = (event) => renderMessage(JSON.parse(event.data), false);
}

socket.on('peer-joined', async () => {
  if (isCreator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', offer);
  }
});

socket.on('webrtc-offer', async (offer) => {
  if (!isCreator) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    while(chatIceQueue.length) peerConnection.addIceCandidate(chatIceQueue.shift()); 
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('webrtc-answer', answer);
  }
});

socket.on('webrtc-answer', async (answer) => {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  while(chatIceQueue.length) peerConnection.addIceCandidate(chatIceQueue.shift()); 
});

socket.on('webrtc-ice', async (candidate) => {
  if (!peerConnection) return;
  const ice = new RTCIceCandidate(candidate);
  if (peerConnection.remoteDescription) {
    peerConnection.addIceCandidate(ice).catch(e => console.error(e));
  } else {
    chatIceQueue.push(ice); 
  }
});

// --- MESSAGING ---

function handleSendText() {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text) return;
  
  const payload = { type: 'text', data: text };
  dataChannel.send(JSON.stringify(payload));
  renderMessage(payload, true);
  input.value = '';
}

function handleFileSelect(event) {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 50 * 1024 * 1024) {
    displaySystemMessage('File is too large. Maximum size is 50MB.', 'danger');
    return;
  }

  showConfirm(`Send this file? (${(file.size/1024/1024).toFixed(2)} MB)`, () => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const payload = { type: 'file', mime: file.type, data: e.target.result };
      dataChannel.send(JSON.stringify(payload));
      renderMessage(payload, true);
    };
    reader.readAsDataURL(file);
    event.target.value = ''; 
  });
}

async function toggleMic() {
  const micBtn = document.getElementById('mic-btn');
  
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        if (audioBlob.size > 50 * 1024 * 1024) {
          displaySystemMessage('Voice message exceeds 50MB limit.', 'danger');
          return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
          const payload = { type: 'file', mime: 'audio/webm', data: e.target.result };
          if (dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(JSON.stringify(payload));
            renderMessage(payload, true);
          }
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
    } catch (err) {
      displaySystemMessage('[ERROR] Microphone access denied or requires HTTPS connection.', 'danger');
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
  }
}

// --- SECURE LIVE CALLING ---

function requestCall(video) {
  if (isCallActive) return;
  isVideoCall = video;
  amICaller = true;
  socket.emit('call-request', { isVideo: video });
  displaySystemMessage(`Dialing peer for ${video ? 'Video' : 'Voice'} Call...`);
}

socket.on('call-request', (data) => {
  if (isCallActive) return socket.emit('call-response', { accepted: false, reason: 'Busy' });
  isVideoCall = data.isVideo;
  amICaller = false;
  document.getElementById('incoming-call-type').textContent = `Incoming ${isVideoCall ? 'Video' : 'Voice'} Call`;
  document.getElementById('incoming-call-modal').classList.remove('hidden');
});

function acceptCall() {
  document.getElementById('incoming-call-modal').classList.add('hidden');
  socket.emit('call-response', { accepted: true });
  startCallEngine();
}

function rejectCall() {
  document.getElementById('incoming-call-modal').classList.add('hidden');
  socket.emit('call-response', { accepted: false });
}

socket.on('call-response', (data) => {
  if (data.accepted) {
    displaySystemMessage('Call accepted. Securing line...', 'success');
    startCallEngine();
  } else {
    displaySystemMessage(`Call declined${data.reason ? ' ('+data.reason+')' : ''}.`, 'danger');
    amICaller = false;
  }
});

async function startCallEngine() {
  isCallActive = true;
  callIceQueue = [];
  document.getElementById('call-ui').classList.remove('hidden');
  document.getElementById('call-status-text').textContent = isVideoCall ? 'SECURE VIDEO ACTIVE' : 'SECURE VOICE ACTIVE';
  document.getElementById('local-video').style.display = isVideoCall ? 'block' : 'none';
  
  try {
    callStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideoCall });
    document.getElementById('local-video').srcObject = callStream;

    callConnection = new RTCPeerConnection(rtcConfig);
    
    callConnection.onicecandidate = (event) => {
      if (event.candidate) socket.emit('call-ice', event.candidate);
    };

    callConnection.ontrack = (event) => {
      document.getElementById('remote-video').srcObject = event.streams[0];
    };

    callStream.getTracks().forEach(track => {
      callConnection.addTrack(track, callStream);
    });

    if (amICaller) {
      const offer = await callConnection.createOffer();
      await callConnection.setLocalDescription(offer);
      socket.emit('call-offer', offer);
    }

  } catch (err) {
    let errorMsg = "Error accessing media devices.";
    if (err.name === 'NotAllowedError') errorMsg = "Camera/Mic permission denied.";
    else if (!navigator.mediaDevices) errorMsg = "Calls require an HTTPS connection.";
    
    displaySystemMessage(`[CALL FAILED] ${errorMsg}`, 'danger');
    endCall();
  }
}

socket.on('call-offer', async (offer) => {
  if (!isCallActive || !callConnection) return;
  await callConnection.setRemoteDescription(new RTCSessionDescription(offer));
  while(callIceQueue.length) callConnection.addIceCandidate(callIceQueue.shift()); 
  const answer = await callConnection.createAnswer();
  await callConnection.setLocalDescription(answer);
  socket.emit('call-answer', answer);
});

socket.on('call-answer', async (answer) => {
  if (!isCallActive || !callConnection) return;
  await callConnection.setRemoteDescription(new RTCSessionDescription(answer));
  while(callIceQueue.length) callConnection.addIceCandidate(callIceQueue.shift()); 
});

socket.on('call-ice', async (candidate) => {
  if (!isCallActive || !callConnection) return;
  const ice = new RTCIceCandidate(candidate);
  if (callConnection.remoteDescription) {
    callConnection.addIceCandidate(ice).catch(e => console.log(e));
  } else {
    callIceQueue.push(ice); 
  }
});

function endCall() {
  if (!isCallActive) return;
  isCallActive = false;
  amICaller = false;
  
  if (callStream) {
    callStream.getTracks().forEach(track => track.stop());
    callStream = null;
  }
  if (callConnection) {
    callConnection.close();
    callConnection = null;
  }
  
  document.getElementById('local-video').srcObject = null;
  document.getElementById('remote-video').srcObject = null;
  document.getElementById('call-ui').classList.add('hidden');
  
  socket.emit('call-end');
  displaySystemMessage('Call ended.', 'normal');
}

socket.on('call-end', () => { if (isCallActive) endCall(); });

function toggleCallMic() {
  if (!callStream) return;
  const audioTrack = callStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    document.getElementById('toggle-call-mic-btn').style.color = audioTrack.enabled ? 'inherit' : 'var(--danger)';
  }
}

function toggleCallCam() {
  if (!callStream) return;
  const videoTrack = callStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    document.getElementById('toggle-call-cam-btn').style.color = videoTrack.enabled ? 'inherit' : 'var(--danger)';
  }
}

// --- RENDER TEXT/FILE UI ---

function renderMessage(payload, isMe) {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div');
  msgEl.className = `msg ${isMe ? 'outgoing' : 'incoming'}`;

  if (payload.type === 'text') {
    const textNode = document.createElement('div');
    textNode.textContent = payload.data; 
    msgEl.appendChild(textNode);
  } else if (payload.type === 'file') {
    if (payload.mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = payload.data;
      img.className = 'media-content clickable-media';
      img.onclick = () => {
        document.getElementById('modal-img').src = payload.data;
        document.getElementById('media-modal').classList.remove('hidden');
      };
      msgEl.appendChild(img);
    } else if (payload.mime.startsWith('audio/')) {
      const audio = document.createElement('audio');
      audio.src = payload.data;
      audio.controls = true;
      audio.className = 'media-content';
      msgEl.appendChild(audio);
    }
  }

  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

function displaySystemMessage(text, type = 'normal') {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div');
  msgEl.className = `msg system ${type}`;
  msgEl.textContent = text;
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

function performLocalPurge() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (callConnection) { callConnection.close(); callConnection = null; }
  if (callStream) { callStream.getTracks().forEach(t => t.stop()); callStream = null; }

  document.getElementById('messages-container').innerHTML = '';
  document.getElementById('chat-view').classList.add('hidden');
  document.getElementById('call-ui').classList.add('hidden');
  document.getElementById('incoming-call-modal').classList.add('hidden');
  document.getElementById('lobby-view').classList.remove('hidden');

  currentRoomId = null;
  currentPassword = null;
  isCallActive = false;
}

function requestPurge() {
  showConfirm("Are you sure you want to leave and destroy the chat?", () => {
    socket.emit('shred-room');
    
    const alertModal = document.getElementById('purge-alert');
    alertModal.classList.remove('hidden');
    performLocalPurge();
    setTimeout(() => alertModal.classList.add('hidden'), 3500); 
  });
}

socket.on('room-shredded', () => {
  const alertModal = document.getElementById('purge-alert');
  alertModal.classList.remove('hidden');
  performLocalPurge();
  setTimeout(() => alertModal.classList.add('hidden'), 3500); 
});

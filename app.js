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

/* // DISABLED TEMPORARILY FOR TESTING 
// Remove the /* and */ /* to re-enable before public launch
setInterval(() => {
  const start = performance.now();
  debugger; 
  if (performance.now() - start > 100) {
    triggerTamperLockdown();
  }
}, 1000);
*/

function triggerTamperLockdown() {
  document.body.innerHTML = `
    <div style="background:#000; color:red; height:100vh; width:100vw; display:flex; flex-direction:column; justify-content:center; align-items:center; font-family:monospace; text-align:center; padding: 20px;">
      <h1 style="font-size:2rem; margin-bottom:10px;">SECURITY LOCKDOWN</h1>
      <p style="font-size:1rem;">Developer tools are disabled for your privacy. Please refresh to try again.</p>
    </div>
  `;
  if (typeof socket !== 'undefined' && socket) socket.disconnect();
  performLocalPurge();
}

// --- LAYER 2: CORE P2P LOGIC ---

const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? 'http://localhost:3000' 
  : 'https://drift-backend-nkru.onrender.com';

const socket = io(BACKEND_URL, {
  transports: ['websocket', 'polling'] 
});

// =========================================================================
// 🛑 EXPRESSTURN SERVER CONFIGURATION (FIREWALL BYPASS)
// =========================================================================
const rtcConfig = { 
  iceServers: [
    // Standard STUN Servers (Keep these for fast local discovery)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    
    // YOUR EXPRESSTURN CREDENTIALS
    {
      urls: [
        "turn:free.expressturn.com:3478?transport=udp",
        "turn:free.expressturn.com:3478?transport=tcp",
        "turns:free.expressturn.com:5349?transport=tcp"
      ],
      username: "000000002103972211",  
      credential: "Z3WQQwReDRX41Vl1sjRp9j/vFnI=" 
    }
  ],
  iceCandidatePoolSize: 10 
};

let currentRoomId = null;
let currentPassword = null;

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

let confirmCallback = null;

window.addEventListener('beforeunload', (e) => {
  if (currentRoomId) {
    e.preventDefault();
    e.returnValue = 'Warning: Refreshing the page will permanently destroy this chat.';
  }
});

// --- UI EFFECTS (LIQUID GLASS & OBFUSCATION) ---
document.addEventListener('DOMContentLoaded', () => {
    // Flashlight hover effect for liquid glass panels
    const panels = document.querySelectorAll('.glass-panel');
    panels.forEach(panel => {
        panel.addEventListener('mousemove', (e) => {
            const rect = panel.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            panel.style.background = `radial-gradient(circle at ${x}px ${y}px, rgba(0, 255, 102, 0.05), rgba(0, 255, 102, 0.01) 40%)`;
        });
        panel.addEventListener('mouseleave', () => {
            panel.style.background = 'var(--glass-bg)';
        });
    });

    // Text obfuscation click-to-reveal
    const obfuscatedElements = document.querySelectorAll('.obfuscated');
    obfuscatedElements.forEach(el => {
        const maskedText = el.innerText;
        const realText = el.getAttribute('data-reveal');
        el.addEventListener('click', function() {
            if (this.classList.contains('revealed')) {
                this.innerText = maskedText;
                this.classList.remove('revealed');
            } else {
                this.innerText = realText;
                this.classList.add('revealed');
            }
        });
    });
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
      if (!peerConnection) setupWebRTC(); 
      openChatInterface();
      displaySystemMessage('[SYSTEM] Room joined. Negotiating secure P2P tunnel...', 'normal');
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

// --- SYNCHRONIZED WEBRTC HANDSHAKE ---

function setupWebRTC() {
  if (peerConnection) return; 
  peerConnection = new RTCPeerConnection(rtcConfig);
  let hasIceCandidates = false;
  
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      hasIceCandidates = true;
      socket.emit('webrtc-ice', event.candidate);
    }
  };

  peerConnection.onicegatheringstatechange = () => {
    if (peerConnection.iceGatheringState === 'complete' && !hasIceCandidates) {
       displaySystemMessage('[WARNING] WebRTC is blocked by your browser! If using Brave, lower your Shields. If using Opera/Edge, disable Tracking Prevention.', 'danger');
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') {
       displaySystemMessage('[SYSTEM] P2P Encrypted Tunnel fully stabilized.', 'success');
    } else if (peerConnection.connectionState === 'failed') {
       displaySystemMessage('[ERROR] Network firewall severely blocked the connection.', 'danger');
    }
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
  dataChannel.onopen = () => displaySystemMessage('Secure connection active.', 'success');
  dataChannel.onclose = () => displaySystemMessage('Connection lost.', 'danger');
  dataChannel.onmessage = (event) => renderMessage(JSON.parse(event.data), false);
}

socket.on('peer-joined', async () => {
  displaySystemMessage('[SYSTEM] Peer detected. Initiating handshake...', 'normal');
  if (isCreator) {
    try {
      if (!peerConnection) setupWebRTC();
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc-offer', offer);
    } catch (err) {
      console.error("Error creating offer:", err);
    }
  }
});

socket.on('webrtc-offer', async (offer) => {
  if (!isCreator) {
    try {
      if (!peerConnection) setupWebRTC();
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc-answer', answer);

      while (pendingChatIce.length) {
        peerConnection.addIceCandidate(new RTCIceCandidate(pendingChatIce.shift())).catch(e => console.log(e));
      }
    } catch (err) {
      console.error("Error handling offer:", err);
    }
  }
});

socket.on('webrtc-answer', async (answer) => {
  if (isCreator) {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      while (pendingChatIce.length) {
        peerConnection.addIceCandidate(new RTCIceCandidate(pendingChatIce.shift())).catch(e => console.log(e));
      }
    } catch (err) {
      console.error("Error handling answer:", err);
    }
  }
});

socket.on('webrtc-ice', async (candidate) => {
  if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.log("ICE error:", e));
  } else {
    pendingChatIce.push(candidate);
  }
});

// --- MESSAGING ---

function handleSendText() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  
  if (!text) return;

  if (!dataChannel) {
    displaySystemMessage('[SYSTEM ALERT] Cannot send: You are alone in the room.', 'danger');
    return;
  }
  
  if (dataChannel.readyState !== 'open') {
    displaySystemMessage(`[SYSTEM ALERT] Cannot send: Connection is pending (State: ${dataChannel.readyState}).`, 'danger');
    return;
  }
  
  const payload = { type: 'text', data: text };
  try {
    dataChannel.send(JSON.stringify(payload));
    renderMessage(payload, true);
    input.value = '';
  } catch(e) {
    displaySystemMessage('[ERROR] Failed to send transmission. Connection unstable.', 'danger');
  }
}

function handleFileSelect(event) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    displaySystemMessage('[SYSTEM ALERT] Cannot send file: Connection is not ready.', 'danger');
    return;
  }
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
      try {
        dataChannel.send(JSON.stringify(payload));
        renderMessage(payload, true);
      } catch (err) {
        displaySystemMessage('[ERROR] File too large for instantaneous network channel buffer.', 'danger');
      }
    };
    reader.readAsDataURL(file);
    event.target.value = ''; 
  });
}

async function toggleMic() {
  const micBtn = document.getElementById('mic-btn');
  
  if (!dataChannel || dataChannel.readyState !== 'open') {
    displaySystemMessage('[SYSTEM ALERT] Cannot record voice: Connection is not ready.', 'danger');
    return;
  }
  
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
            try {
               dataChannel.send(JSON.stringify(payload));
               renderMessage(payload, true);
            } catch(err) {
               displaySystemMessage('[ERROR] Audio payload crashed the connection buffer.', 'danger');
            }
          }
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
    } catch (err) {
      displaySystemMessage('[ERROR] Microphone access denied.', 'danger');
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
  }
}

// --- SECURE CALLING (VOICE ONLY) ---

function requestCall() {
  if (isCallActive) return;
  amICaller = true;
  socket.emit('call-request', { isVideo: false }); // Force false
  displaySystemMessage(`Dialing peer for Secure Voice Call...`);
}

socket.on('call-request', (data) => {
  if (isCallActive) return socket.emit('call-response', { accepted: false, reason: 'Busy' });
  amICaller = false;
  document.getElementById('incoming-call-type').textContent = `Incoming Voice Call`;
  document.getElementById('incoming-call-modal').classList.remove('hidden');
});

async function acceptCall() {
  document.getElementById('incoming-call-modal').classList.add('hidden');
  displaySystemMessage('[SYSTEM] Securing hardware access...', 'normal');
  await startCallEngine(); 
  socket.emit('call-response', { accepted: true }); 
}

function rejectCall() {
  document.getElementById('incoming-call-modal').classList.add('hidden');
  socket.emit('call-response', { accepted: false });
}

socket.on('call-response', async (data) => {
  if (data.accepted) {
    displaySystemMessage('Call accepted. Securing line...', 'success');
    await startCallEngine(); 
  } else {
    displaySystemMessage(`Call declined${data.reason ? ' ('+data.reason+')' : ''}.`, 'danger');
    amICaller = false;
  }
});

async function startCallEngine() {
  isCallActive = true;
  document.getElementById('call-ui').classList.remove('hidden');
  document.getElementById('call-status-text').textContent = 'SECURE VOICE ACTIVE';
  
  try {
    // STRICTLY AUDIO - This prevents the getUserMedia crash
    callStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    callConnection = new RTCPeerConnection(rtcConfig);
    
    callConnection.onicecandidate = (event) => {
      if (event.candidate) socket.emit('call-ice', event.candidate);
    };

    // Attach incoming stream to the audio tag
    callConnection.ontrack = (event) => {
      const remoteAudio = document.getElementById('remote-audio');
      if (remoteAudio.srcObject !== event.streams[0]) {
          remoteAudio.srcObject = event.streams[0];
      }
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
    displaySystemMessage(`[CALL FAILED] Microphone access denied or unavailable.`, 'danger');
    endCall();
  }
}

socket.on('call-offer', async (offer) => {
  if (!isCallActive || !callConnection) return;
  await callConnection.setRemoteDescription(new RTCSessionDescription(offer));
  while (pendingCallIce.length) {
    callConnection.addIceCandidate(new RTCIceCandidate(pendingCallIce.shift())).catch(e => console.log(e));
  }
  const answer = await callConnection.createAnswer();
  await callConnection.setLocalDescription(answer);
  socket.emit('call-answer', answer);
});

socket.on('call-answer', async (answer) => {
  if (!isCallActive || !callConnection) return;
  await callConnection.setRemoteDescription(new RTCSessionDescription(answer));
  while (pendingCallIce.length) {
    callConnection.addIceCandidate(new RTCIceCandidate(pendingCallIce.shift())).catch(e => console.log(e));
  }
});

socket.on('call-ice', async (candidate) => {
  if (callConnection && callConnection.remoteDescription && callConnection.remoteDescription.type) {
    callConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.log(e));
  } else {
    pendingCallIce.push(candidate); 
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
  
  // Clear the audio tag instead of video
  document.getElementById('remote-audio').srcObject = null;
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

// --- UI RENDERING ---

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

  pendingChatIce = [];
  pendingCallIce = [];

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

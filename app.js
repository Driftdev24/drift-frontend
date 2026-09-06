const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? 'http://localhost:3000' 
  : 'https://drift-backend-nkru.onrender.com';

const socket = io(BACKEND_URL, {
  transports: ['websocket', 'polling'] 
});

let rtcConfig = null;
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
const incomingFiles = {};

// Hard limits for DoS and memory protection
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const CHUNK_SIZE = 16384; // 16KB
const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE);

window.addEventListener('beforeunload', (e) => {
  if (currentRoomId) {
    e.preventDefault();
    e.returnValue = 'Warning: Leaving or reloading destroys this ephemeral chat.';
  }
});

// UI Effects
document.addEventListener('DOMContentLoaded', () => {
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
});

function switchTab(tab) {
  document.getElementById('error-message').textContent = '';
  document.getElementById('create-form').classList.toggle('hidden', tab !== 'create');
  document.getElementById('join-form').classList.toggle('hidden', tab !== 'join');
  document.getElementById('tab-create-btn').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join-btn').classList.toggle('active', tab === 'join');
}

// Universal copy function compatible with iOS, Android, and non-HTTPS local testing
function universalCopy(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  } else {
    return new Promise((resolve, reject) => {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        textArea.remove();
        resolve();
      } catch (error) {
        textArea.remove();
        reject(error);
      }
    });
  }
}

function copyData(elementId, btn) {
  const text = document.getElementById(elementId).innerText;
  universalCopy(text).then(() => {
    btn.innerText = "COPIED!";
    setTimeout(() => { btn.innerText = "COPY"; }, 1500);
  }).catch(() => alert("Failed to copy automatically. Please select and copy manually."));
}

function quickCopyText(textElementId, iconContainerId) {
  const text = document.getElementById(textElementId).innerText;
  universalCopy(text).then(() => {
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

// Handshake
function handleCreate(e) {
  e.preventDefault();
  currentPassword = document.getElementById('create-password').value;
  socket.emit('create-room', { password: currentPassword }, (res) => {
    if (res.success) {
      isCreator = true;
      currentRoomId = res.id;
      
      // Receive ICE configuration directly from socket response
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
  openChatInterface();
  displaySystemMessage('Waiting for your peer to join...');
}

function handleJoin(e) {
  e.preventDefault();
  currentRoomId = document.getElementById('join-code').value.toUpperCase();
  currentPassword = document.getElementById('join-password').value;

  socket.emit('join-room', { id: currentRoomId, password: currentPassword }, (res) => {
    if (res.success) {
      isCreator = false;
      
      // Receive ICE configuration directly from socket response
      rtcConfig = { iceServers: res.iceServers, iceCandidatePoolSize: 10 };
      
      if (!peerConnection) setupWebRTC(); 
      openChatInterface();
      displaySystemMessage('[SYSTEM] Room joined. Negotiating direct P2P tunnel...', 'normal');
    } else {
      document.getElementById('error-message').textContent = res.error || 'Incorrect Room ID or Password.';
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

// WebRTC Handshake
function setupWebRTC() {
  if (peerConnection || !rtcConfig) return; 
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
      displaySystemMessage('[WARNING] WebRTC candidates blocked. Check browser privacy shields.', 'danger');
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') {
      displaySystemMessage('[SYSTEM] Direct P2P tunnel active.', 'success');
    } else if (peerConnection.connectionState === 'failed') {
      displaySystemMessage('[ERROR] Network firewall blocked direct connection.', 'danger');
    }
  };

  if (isCreator) {
    dataChannel = peerConnection.createDataChannel('drift-chat', {
      ordered: true,
      maxRetransmits: 3 
    });
    setupDataChannel();
  } else {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel();
    };
  }
}

function setupDataChannel() {
  dataChannel.onopen = () => displaySystemMessage('Secure data tunnel ready.', 'success');
  dataChannel.onclose = () => displaySystemMessage('Connection lost.', 'danger');
  
  dataChannel.onmessage = (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === 'obfuscation') return;

    if (payload.type === 'upload_start') {
      if (payload.totalChunks > MAX_CHUNKS) {
        displaySystemMessage(`[SECURITY] Blocked incoming file exceeding 25MB limit.`, 'danger');
        return;
      }
      incomingFiles[payload.fileId] = { chunks: [], fileType: payload.fileType, mime: payload.mime, total: payload.totalChunks };
      showLoadingIndicator(`Receiving ${payload.fileType}...`, payload.fileId);
    } 
    else if (payload.type === 'upload_chunk') {
      if (incomingFiles[payload.fileId]) {
        incomingFiles[payload.fileId].chunks[payload.chunkIndex] = payload.data;
      }
    } 
    else if (payload.type === 'upload_end') {
      if (incomingFiles[payload.fileId]) {
        hideLoadingIndicator(payload.fileId);
        const completeData = incomingFiles[payload.fileId].chunks.join('');
        renderMessage({ type: incomingFiles[payload.fileId].fileType, mime: incomingFiles[payload.fileId].mime, data: completeData }, false);
        delete incomingFiles[payload.fileId];
      }
    } 
    else {
      renderMessage(payload, false);
    }
  };
}

socket.on('peer-joined', async () => {
  displaySystemMessage('[SYSTEM] Peer detected. Exchanging coordinates...', 'normal');
  if (isCreator) {
    try {
      if (!peerConnection) setupWebRTC();
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc-offer', offer);
    } catch (err) { console.error(err); }
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
        peerConnection.addIceCandidate(new RTCIceCandidate(pendingChatIce.shift())).catch(() => {});
      }
    } catch (err) { console.error(err); }
  }
});

socket.on('webrtc-answer', async (answer) => {
  if (isCreator) {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      while (pendingChatIce.length) {
        peerConnection.addIceCandidate(new RTCIceCandidate(pendingChatIce.shift())).catch(() => {});
      }
    } catch (err) { console.error(err); }
  }
});

socket.on('webrtc-ice', async (candidate) => {
  if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  } else {
    pendingChatIce.push(candidate);
  }
});

// Messaging & File Transfer
function sendDataChunked(dataUrl, fileType, mimeType) {
  if (!dataChannel || dataChannel.readyState !== 'open') return;

  if (dataUrl.length > MAX_FILE_SIZE) {
    displaySystemMessage('[ERROR] File exceeds 25MB limit.', 'danger');
    return;
  }

  const totalChunks = Math.ceil(dataUrl.length / CHUNK_SIZE);
  const fileId = Date.now().toString();

  dataChannel.send(JSON.stringify({ type: 'upload_start', fileId, totalChunks, fileType, mime: mimeType }));
  showLoadingIndicator(`Sending ${fileType}...`, fileId);

  let currentChunk = 0;

  function sendNext() {
    if (dataChannel.readyState !== 'open') return hideLoadingIndicator(fileId);

    const start = currentChunk * CHUNK_SIZE;
    const end = start + CHUNK_SIZE;
    const chunk = dataUrl.slice(start, end);

    dataChannel.send(JSON.stringify({ type: 'upload_chunk', fileId, chunkIndex: currentChunk, data: chunk }));

    currentChunk++;
    if (currentChunk < totalChunks) {
      setTimeout(sendNext, 5);
    } else {
      dataChannel.send(JSON.stringify({ type: 'upload_end', fileId }));
      hideLoadingIndicator(fileId);
      renderMessage({ type: fileType, mime: mimeType, data: dataUrl }, true);
    }
  }
  sendNext();
}

function handleSendText() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  
  if (!text || !dataChannel || dataChannel.readyState !== 'open') return;
  
  const payload = { type: 'text', data: text };
  try {
    dataChannel.send(JSON.stringify(payload));
    renderMessage(payload, true);
    input.value = '';
  } catch(e) {
    displaySystemMessage('[ERROR] Failed to send transmission.', 'danger');
  }
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    displaySystemMessage('[ERROR] File exceeds 25MB limit.', 'danger');
    event.target.value = ''; 
    return;
  }

  showConfirm(`Send image?`, () => {
    const reader = new FileReader();
    reader.onload = (e) => {
      sendDataChunked(e.target.result, 'image', file.type);
    };
    reader.readAsDataURL(file);
    event.target.value = ''; 
  });
}

// Adaptive Mic Recording for iOS Safari & Android
async function toggleMic() {
  const micBtn = document.getElementById('mic-btn');
  
  if (!dataChannel || dataChannel.readyState !== 'open') {
    displaySystemMessage('[SYSTEM ALERT] Connection is not ready.', 'danger');
    return;
  }
  
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Determine device supported codec (iOS Safari prefers mp4, Android/Chrome prefers webm)
      let selectedMimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          selectedMimeType = 'audio/mp4';
        } else {
          selectedMimeType = ''; // Let browser use default
        }
      }

      mediaRecorder = selectedMimeType ? new MediaRecorder(stream, { mimeType: selectedMimeType }) : new MediaRecorder(stream);
      audioChunks = [];
      
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: selectedMimeType || 'audio/mp4' });
        
        if (audioBlob.size > MAX_FILE_SIZE) {
          displaySystemMessage('[ERROR] Voice message exceeded limit.', 'danger');
          return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
          sendDataChunked(e.target.result, 'voice message', selectedMimeType || 'audio/mp4');
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
    } catch (err) {
      displaySystemMessage('[ERROR] Microphone access denied or unsupported.', 'danger');
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
  }
}

// Voice Calling Engine
function requestCall() {
  if (isCallActive) return;
  amICaller = true;
  socket.emit('call-request', { isVideo: false });
  displaySystemMessage(`Dialing peer for Voice Call...`);
}

socket.on('call-request', () => {
  if (isCallActive) return socket.emit('call-response', { accepted: false, reason: 'Busy' });
  amICaller = false;
  document.getElementById('incoming-call-type').textContent = `Incoming Voice Call`;
  document.getElementById('incoming-call-modal').classList.remove('hidden');
});

async function acceptCall() {
  document.getElementById('incoming-call-modal').classList.add('hidden');
  displaySystemMessage('[SYSTEM] Connecting voice hardware...', 'normal');
  await startCallEngine(); 
  socket.emit('call-response', { accepted: true }); 
}

function rejectCall() {
  document.getElementById('incoming-call-modal').classList.add('hidden');
  socket.emit('call-response', { accepted: false });
}

socket.on('call-response', async (data) => {
  if (data.accepted) {
    displaySystemMessage('Call accepted. Connecting...', 'success');
    await startCallEngine(); 
  } else {
    displaySystemMessage(`Call declined${data.reason ? ' (' + data.reason + ')' : ''}.`, 'danger');
    amICaller = false;
  }
});

async function startCallEngine() {
  isCallActive = true;
  document.getElementById('call-ui').classList.remove('hidden');
  
  try {
    callStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    callConnection = new RTCPeerConnection(rtcConfig);
    
    callConnection.onicecandidate = (event) => {
      if (event.candidate) socket.emit('call-ice', event.candidate);
    };

    callConnection.ontrack = (event) => {
      const remoteAudio = document.getElementById('remote-audio');
      if (remoteAudio.srcObject !== event.streams[0]) {
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play().catch(() => {});
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
    displaySystemMessage(`[CALL FAILED] Microphone access denied.`, 'danger');
    endCall();
  }
}

socket.on('call-offer', async (offer) => {
  if (!isCallActive || !callConnection) return;
  await callConnection.setRemoteDescription(new RTCSessionDescription(offer));
  while (pendingCallIce.length) {
    callConnection.addIceCandidate(new RTCIceCandidate(pendingCallIce.shift())).catch(() => {});
  }
  const answer = await callConnection.createAnswer();
  await callConnection.setLocalDescription(answer);
  socket.emit('call-answer', answer);
});

socket.on('call-answer', async (answer) => {
  if (!isCallActive || !callConnection) return;
  await callConnection.setRemoteDescription(new RTCSessionDescription(answer));
  while (pendingCallIce.length) {
    callConnection.addIceCandidate(new RTCIceCandidate(pendingCallIce.shift())).catch(() => {});
  }
});

socket.on('call-ice', async (candidate) => {
  if (callConnection && callConnection.remoteDescription && callConnection.remoteDescription.type) {
    callConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
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
  
  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio) remoteAudio.srcObject = null;
  
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

// XSS-Safe DOM Rendering
function showLoadingIndicator(text, id) {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div');
  msgEl.className = `msg loading`;
  msgEl.id = `load-${id}`;
  
  const spinner = document.createElement('span');
  spinner.className = 'loader-circle';
  
  const textNode = document.createTextNode(' ' + text);

  msgEl.appendChild(spinner);
  msgEl.appendChild(textNode);
  
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

function hideLoadingIndicator(id) {
  const loader = document.getElementById(`load-${id}`);
  if (loader) loader.remove();
}

function renderMessage(payload, isMe) {
  const container = document.getElementById('messages-container');
  const msgEl = document.createElement('div');
  msgEl.className = `msg ${isMe ? 'outgoing' : 'incoming'}`;

  if (payload.type === 'text') {
    const textNode = document.createElement('div');
    textNode.textContent = payload.data; 
    msgEl.appendChild(textNode);
  } else if (payload.type === 'image') {
    const img = document.createElement('img');
    img.src = payload.data;
    img.className = 'media-content clickable-media';
    img.onclick = () => {
      document.getElementById('modal-img').src = payload.data;
      document.getElementById('media-modal').classList.remove('hidden');
    };
    msgEl.appendChild(img);
  } else if (payload.type === 'voice message' || payload.type === 'audio') {
    const audio = document.createElement('audio');
    audio.src = payload.data;
    audio.controls = true;
    audio.playsInline = true;
    audio.className = 'media-content';
    msgEl.appendChild(audio);
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

// Memory Purge
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

// Periodic dummy traffic injection (masks timing and message length analysis)
setInterval(() => {
  if (dataChannel && dataChannel.readyState === 'open') {
    const randomSize = Math.floor(Math.random() * 128) + 16;
    const garbage = new Uint8Array(randomSize);
    crypto.getRandomValues(garbage);
    dataChannel.send(JSON.stringify({ type: 'obfuscation', data: Array.from(garbage) }));
  }
}, Math.random() * 4000 + 2000);

// =========================================================================
// MANDATORY MANIFESTO TIMER (3 MINUTES)
// =========================================================================

document.addEventListener('DOMContentLoaded', () => {
    const agreeBtn = document.getElementById('agree-manifesto-btn');
    const timerDisplay = document.getElementById('manifesto-timer');
    const largeTimerDisplay = document.getElementById('large-manifesto-timer');
    
    // 180 seconds = 3 minutes
    let timeLeft = 180; 

    // Initial display
    updateTimerDisplay();

    const timerInterval = setInterval(() => {
        timeLeft--;
        updateTimerDisplay();

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            unlockManifesto();
        }
    }, 1000);

    function updateTimerDisplay() {
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        const formattedTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        if (timerDisplay) {
            timerDisplay.textContent = `(${formattedTime})`;
        }
        if (largeTimerDisplay) {
            largeTimerDisplay.textContent = formattedTime;
        }
    }

    function unlockManifesto() {
        if (timerDisplay) timerDisplay.textContent = '';
        if (largeTimerDisplay) {
            largeTimerDisplay.textContent = '00:00';
            largeTimerDisplay.style.color = 'var(--primary)';
            largeTimerDisplay.classList.remove('pulse-text');
        }

        if (agreeBtn) {
            agreeBtn.textContent = 'I UNDERSTAND AND AGREE';
            agreeBtn.disabled = false;
            agreeBtn.classList.remove('disabled-btn');
            
            // Add click event to dismiss the overlay once unlocked
            agreeBtn.addEventListener('click', () => {
                document.getElementById('manifesto-overlay').classList.add('hidden');
            });
        }
    }
});

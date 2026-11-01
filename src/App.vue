<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { TRACKS, type Edit, type Member, type Project, type Role, type ServerMessage } from '../shared/protocol';
import { AudioEngine } from './audio';
import RankedPanel from './RankedPanel.vue';
import BattlePanel from './BattlePanel.vue';
import type { BattleView, DuelView } from '../shared/battle';
import type { RankedPlayer } from '../shared/ranked';

const room = ref(new URLSearchParams(location.search).get('room')?.replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'studio-01');
const name = ref(localStorage.getItem('beat-royale-name') || '');
const role = ref<Role>('producer');
const joined = ref(false), busy = ref(false), connected = ref(false), error = ref('');
const self = ref(''), following = ref(''), members = ref<Member[]>([]), project = ref<Project | null>(null);
const pending = ref(false), position = ref(-1), latency = ref(0), audioReady = ref(false);
const volume = ref(.65);
const mode = ref(new URLSearchParams(location.search).has('ranked') ? 'ranked' : 'studio');
const ownProject = ref<Project | null>(null), leaderboard = ref<RankedPlayer[]>([]);
const battle = ref<BattleView | null>(null), duel = ref<DuelView | null>(null), duelReason = ref('');
const heard = ref<string[]>([]), auditioning = ref(''), clockNow = ref(Date.now());
let auditionTimer: ReturnType<typeof setTimeout> | undefined;
const clockTick = setInterval(() => { clockNow.value = Date.now() + offset; }, 250);
let audio: AudioEngine | undefined, socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
let editTimeout: ReturnType<typeof setTimeout> | undefined;
let requestId = '', offset = 0, bestRtt = Infinity, retryCount = 0, stopped = false;
const producers = computed(() => members.value.filter(m => m.role === 'producer'));
const watching = computed(() => following.value !== self.value);
const battleEditable = computed(() => !battle.value || battle.value.phase === 'waiting' || (battle.value.phase !== 'finished' && battle.value.standings.some(p => p.id === self.value && p.active)));
const editable = computed(() => connected.value && role.value === 'producer' && !watching.value && !pending.value && battleEditable.value);
const selected = computed(() => members.value.find(m => m.id === following.value));
const colors = ['#e0ad77', '#95a8cd', '#b5c98b', '#a0c2b4', '#c2a3c4', '#c8b886'];

async function join() {
  busy.value = true; error.value = ''; stopped = false;
  try {
    if (!/^[a-z0-9-]{1,32}$/.test(room.value)) throw new Error('Room: use 1–32 lowercase letters, numbers or hyphens.');
    audio ??= new AudioEngine();
    await audio.prepare(); audioReady.value = true;
    const response = await fetch(`/api/rooms/${room.value}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.value || 'Guest', role: role.value }) });
    const result = await response.json() as { id: string; role: Role; error?: string };
    if (!response.ok) throw new Error(result.error || 'Unable to join.');
    localStorage.setItem('beat-royale-name', name.value);
    self.value = result.id; role.value = result.role;
    joined.value = true; following.value = result.role === 'producer' ? result.id : '';
    history.replaceState(null, '', `?room=${encodeURIComponent(room.value)}`);
    connect();
  } catch (e) { error.value = e instanceof Error ? e.message : 'Unable to join.'; }
  finally { busy.value = false; }
}
function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${room.value}/socket`);
  socket.onopen = () => {
    connected.value = true; retryCount = 0; error.value = ''; bestRtt = Infinity;
    ping(); heartbeat = setInterval(ping, 5000);
  };
  socket.onmessage = event => {
    if (event.data === 'pong') return;
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.type === 'welcome') {
      members.value = message.members;
      if (following.value && following.value !== self.value) follow(following.value);
      else if (role.value === 'spectator' && producers.value[0]) follow(producers.value[0].id);
    }
    if (message.type === 'roster') {
      members.value = message.members;
      if (!following.value && role.value === 'spectator' && producers.value[0]) follow(producers.value[0].id);
    }
    if (message.type === 'following') {
      following.value = message.id || ''; project.value = null; audio?.setProject(null);
    }
    if (message.type === 'project') {
      if (message.ack === requestId) { pending.value = false; clearTimeout(editTimeout); }
      if (message.id === self.value) ownProject.value = message.project;
      if (message.id === following.value) { project.value = message.project; if (!auditioning.value) audio?.setProject(message.project); }
    }
    if (message.type === 'battle') {
      battle.value = message.battle;
      if (message.battle.phase !== 'round') { duel.value = null; stopAudition(); }
    }
    if (message.type === 'duel') {
      if (duel.value?.id !== message.duel?.id) { heard.value = []; stopAudition(); }
      duel.value = message.duel; duelReason.value = message.reason ?? '';
    }
    if (message.type === 'voteRecorded' && duel.value?.id === message.duelId) duel.value.voted = message.choice;
    if (message.type === 'pong') {
      const rtt = Date.now() - message.sentAt; latency.value = Math.round(rtt);
      if (rtt < bestRtt) { bestRtt = rtt; offset = message.serverTime - (message.sentAt + rtt / 2); if (audio) audio.offset = offset; }
    }
    if (message.type === 'error') { error.value = message.message; pending.value = false; clearTimeout(editTimeout); }
  };
  socket.onclose = () => {
    stopAudition();
    connected.value = false; pending.value = false; clearInterval(heartbeat); clearTimeout(editTimeout);
    audio?.setProject(null); project.value = null;
    if (!stopped) {
      error.value = 'Connection lost. Reconnecting…';
      retry = setTimeout(connect, Math.min(1000 * 2 ** retryCount++, 10000));
    }
  };
  socket.onerror = () => { error.value = 'Unable to reach this room. Retrying…'; };
}
function ping() { socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'ping', sentAt: Date.now() })); }
function follow(id: string) {
  if (!connected.value) return;
  stopAudition();
  project.value = null; audio?.setProject(null); following.value = id;
  socket?.send(JSON.stringify({ type: 'follow', id }));
}
function battleCommand(value: Record<string, unknown>) { if (connected.value) socket?.send(JSON.stringify(value)); }
function stopAudition() { clearTimeout(auditionTimer); if (auditioning.value) { auditioning.value = ''; audio?.setProject(project.value); } }
async function audition(side: 'A' | 'B') {
  if (!duel.value || auditioning.value || !audio) return;
  try {
    await audio.resume();
    const current = duel.value; auditioning.value = side;
    audio.setProject(null);
    audio.setProject({ ...current[side === 'A' ? 'a' : 'b'], playing: true, startedAt: Date.now() + offset + 100 });
    auditionTimer = setTimeout(() => { if (duel.value?.id === current.id && audio?.running) heard.value = [...new Set([...heard.value, side])]; stopAudition(); }, current.clipMs + 100);
  } catch { error.value = 'Enable audio before listening.'; }
}
function edit(change: Edit) {
  if (!editable.value || !project.value) return;
  error.value = ''; pending.value = true; requestId = crypto.randomUUID();
  socket?.send(JSON.stringify({ type: 'edit', revision: project.value.revision, requestId, edit: change }));
  editTimeout = setTimeout(() => { pending.value = false; error.value = 'Update timed out. Refreshing state…'; socket?.send(JSON.stringify({ type: 'snapshot' })); }, 4000);
}
async function leave() {
  busy.value = true;
  try {
    const response = await fetch(`/api/rooms/${room.value}/leave`, { method: 'POST' });
    if (!response.ok) throw new Error('Could not leave the room. Retry when connected.');
    stopped = true; clearTimeout(retry); clearInterval(heartbeat); clearTimeout(editTimeout); socket?.close();
    stopAudition(); audio?.dispose(); audio = undefined; joined.value = false; connected.value = false; audioReady.value = false; project.value = null; ownProject.value = null; battle.value = null; duel.value = null; members.value = [];
  } catch (e) { error.value = e instanceof Error ? e.message : 'Could not leave.'; }
  finally { busy.value = false; }
}
async function resumeAudio() { try { await audio?.resume(); audioReady.value = !!audio?.running; } catch { error.value = 'Click again to enable audio.'; } }
const clock = setInterval(() => {
  const p = project.value;
  position.value = p?.playing ? Math.max(-1, Math.floor((Date.now() + offset - p.startedAt) / (60000 / p.bpm / 4))) % 16 : -1;
  if (audio) audioReady.value = audio.running;
}, 30);
onUnmounted(() => { stopped = true; clearInterval(clockTick); clearTimeout(auditionTimer); clearInterval(clock); clearInterval(heartbeat); clearTimeout(retry); clearTimeout(editTimeout); socket?.close(); audio?.dispose(); });
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a href="/" class="brand"><span class="brand-mark">b<span>r</span></span><span>BEAT ROYALE<small>MAKE SOMETHING WORTH HEARING.</small></span></a>
      <div class="top-right"><span class="version">BATTLE BETA / 002</span><span class="connection" :class="{ online: connected }"><i></i>{{ connected ? 'CONNECTED' : 'LOCAL AUDIO · EDGE SYNC' }}</span></div>
    </header>
    <nav class="mode-nav" aria-label="Game mode"><button :class="{ active: mode === 'studio' }" @click="mode = 'studio'">STUDIO / BATTLE ROYALE</button><button :class="{ active: mode === 'ranked' }" @click="mode = 'ranked'">RANKED <span>1v1</span></button></nav>
    <RankedPanel v-show="mode === 'ranked'" :project="ownProject" :name="name" @studio="mode = 'studio'" @leaderboard="leaderboard = $event" />

    <main v-if="!joined && mode === 'studio'" class="entry">
      <section class="entry-copy"><span class="eyebrow">THE STUDIO IS OPEN</span><h1>Your sound.<br>Your <em>moment.</em></h1><p>One sample pack. Endless possibilities.<br>Build a beat, share a room, hear it happen live.</p><div class="entry-notes"><span>01 / MAKE A BEAT</span><span>02 / TUNE IN LIVE</span><span>03 / FIND YOUR SOUND</span></div></section>
      <form class="join-card" @submit.prevent="join">
        <div class="card-heading"><span class="eyebrow">SESSION ACCESS</span><span class="live-pill">ALPHA</span></div>
        <h2>Step into the studio.</h2><p class="muted">No account. Just a name and an idea.</p>
        <label>Your name<input v-model="name" maxlength="24" placeholder="Guest producer" autocomplete="nickname"></label>
        <label>Room code<input v-model="room" required maxlength="32" pattern="[a-z0-9-]+" autocomplete="off"></label>
        <div class="role-choice"><button type="button" :class="{ selected: role === 'producer' }" @click="role = 'producer'">Produce <small>Make your own beat</small></button><button type="button" :class="{ selected: role === 'spectator' }" @click="role = 'spectator'">Listen <small>Follow a producer</small></button></div>
        <button class="primary join-button" :disabled="busy">{{ busy ? 'Loading your sound…' : 'Enter studio ↗' }}</button>
        <p class="fine-print">Your click enables audio. Everyone loads the same verified sample pack.</p>
      </form>
    </main>

    <main v-else-if="mode === 'studio'" class="studio">
      <aside class="sidebar">
        <div class="room-label"><span class="eyebrow">CURRENT ROOM</span><h2>{{ room }}</h2><span class="muted">{{ producers.length }} / 50 producers</span></div>
        <div class="section-label">ON THE FLOOR <span>{{ producers.length.toString().padStart(2, '0') }}</span></div>
        <button v-for="member in producers" :key="member.id" class="member" :class="{ active: following === member.id }" @click="follow(member.id)"><span class="avatar">{{ member.name.slice(0, 2).toUpperCase() }}</span><span class="member-name">{{ member.name }}<small>{{ member.id === self ? 'Your studio' : member.online ? 'Live producer' : 'Offline · saved beat' }}</small></span><i :class="{ online: member.online }"></i></button>
        <p v-if="!producers.length" class="muted empty-roster">Waiting for the first producer.</p>
        <button class="lobby-rank-link" @click="mode = 'ranked'"><span class="eyebrow">RANKED LEADERBOARD ↗</span><span v-for="(p,i) in leaderboard.slice(0,3)" :key="p.id">{{ i + 1 }}. {{ p.name }} <strong>{{ p.rating }}</strong></span><small v-if="!leaderboard.length">No completed matches yet. Take the first spot.</small></button>
        <div class="sidebar-bottom"><span class="eyebrow">SHARED SOUNDS</span><strong>FOUNDRY / VOL. 01</strong><p>Six original sounds.<br>One common starting point.</p><span class="pack-check">✓ Pack verified</span></div>
        <button class="leave" :disabled="busy" @click="leave">Leave room ↗</button>
      </aside>
      <section class="workspace">
        <BattlePanel v-if="battle" :battle="battle" :duel="duel" :reason="duelReason" :self="self" :producer="role === 'producer'" :ready="!!members.find(m => m.id === self)?.ready" :connected="connected" :now="clockNow" :heard="heard" :auditioning="auditioning" @ready="battleCommand({ type: 'ready', value: $event })" @audition="audition" @vote="battleCommand({ type: 'vote', duelId: duel?.id, choice: $event })" />
        <div class="workspace-heading"><div><span class="eyebrow">{{ watching ? 'LIVE LISTENING' : 'YOUR WORKSPACE' }}</span><h1>{{ watching ? selected?.name || 'Waiting for a producer' : 'Make your mark.' }}</h1></div><span class="mode-tag">{{ watching ? 'READ ONLY' : 'STEP SEQUENCER' }}</span></div>
        <div v-if="!audioReady" class="audio-notice"><span>Audio is paused by your browser.</span><button @click="resumeAudio">Enable audio</button></div>
        <template v-if="project">
          <div class="transport"><button class="play" :disabled="!editable" @click="edit({ kind: 'transport', value: !project.playing })">{{ project.playing ? '■' : '▶' }} <span>{{ project.playing ? 'STOP' : 'PLAY' }}</span></button><div class="tempo"><label for="bpm">TEMPO</label><input id="bpm" type="number" min="60" max="180" :value="project.bpm" :disabled="!editable" @change="edit({ kind: 'bpm', value: Number(($event.target as HTMLInputElement).value) })"><span>BPM</span></div><div class="transport-info"><span>4/4</span><span>16 STEPS</span><span class="signal">{{ project.playing ? '● PLAYING' : '○ STOPPED' }}</span></div><button class="text-button" :disabled="!editable" @click="edit({ kind: 'clear' })">Clear pattern</button></div>
          <div class="sequencer-wrap"><div class="sequencer"><div class="step-ruler"><span>SOUND / CHANNEL</span><div class="steps"><span v-for="n in 16" :key="n" :class="{ current: position === n - 1 }">{{ n.toString().padStart(2, '0') }}</span></div><span class="mix-label">LEVEL</span></div>
            <div v-for="(track, ti) in project.tracks" :key="ti" class="track" :style="{ '--track': colors[ti] }"><div class="track-title"><span class="track-number">0{{ ti + 1 }}</span><div><strong>{{ TRACKS[ti] }}</strong><div class="track-actions"><button :aria-label="`Mute ${TRACKS[ti]}`" :aria-pressed="track.muted" :class="{ engaged: track.muted }" :disabled="!editable" @click="edit({ kind: 'mix', track: ti, key: 'muted', value: !track.muted })">M</button><button :aria-label="`Solo ${TRACKS[ti]}`" :aria-pressed="track.solo" :class="{ engaged: track.solo }" :disabled="!editable" @click="edit({ kind: 'mix', track: ti, key: 'solo', value: !track.solo })">S</button><input class="pan" type="range" min="-1" max="1" step="0.1" :aria-label="`Pan ${TRACKS[ti]}`" :value="track.pan" :disabled="!editable" @change="edit({ kind: 'mix', track: ti, key: 'pan', value: Number(($event.target as HTMLInputElement).value) })"></div></div></div><div class="steps"><button v-for="(active, si) in track.steps" :key="si" class="step" :class="{ enabled: active, current: position === si, downbeat: si % 4 === 0 }" :aria-label="`${TRACKS[ti]} step ${si + 1}`" :aria-pressed="active" :disabled="!editable" @click="edit({ kind: 'step', track: ti, step: si, value: !active })"><span></span></button></div><div class="track-level"><input type="range" min="0" max="1" step="0.05" :aria-label="`Volume ${TRACKS[ti]}`" :value="track.volume" :disabled="!editable" @change="edit({ kind: 'mix', track: ti, key: 'volume', value: Number(($event.target as HTMLInputElement).value) })"><span>{{ Math.round(track.volume * 100) }}</span></div></div>
          </div></div>
          <div class="sequencer-footer"><span>{{ watching ? 'Following live changes. Audio is reconstructed on your device.' : 'Click a step to place a sound. Your changes are saved to this room.' }}</span><span>{{ pending ? 'SAVING…' : 'SYNCED' }} / REV {{ project.revision }}</span></div>
        </template>
        <div v-else class="empty-project"><span class="empty-icon">♫</span><h2>{{ connected ? 'The floor is yours to discover.' : 'Reconnecting to your studio…' }}</h2><p>Choose a producer on the left to hear their beat.</p></div>
        <div class="bottom-panels"><div class="session-card"><span class="eyebrow">SESSION NOTES</span><h3>Same sounds. Different fingerprints.</h3><p>Share this room’s URL to play alongside friends. Select a producer to follow their sequencer and listen live.</p><span class="development-note">Battle beta · 50-player elimination or Gemini-judged Ranked 1v1.</span></div><div class="output-card"><span class="eyebrow">YOUR MONITOR</span><h3>Master output <span>{{ Math.round(volume * 100) }}%</span></h3><input v-model.number="volume" aria-label="Master volume" type="range" min="0" max="1" step="0.01" @input="audio?.setVolume(volume)"><p>Local listening level. Your mix stays unchanged.</p></div></div>
      </section>
    </main>
    <div v-if="error" class="error-banner" role="alert">{{ error }}<button aria-label="Dismiss message" @click="error = ''">×</button></div>
    <footer class="page-footer"><span>BUILT FOR THE MOMENT.</span><span>{{ joined ? `${latency} MS ROUND TRIP · FOUNDRY V1` : 'REAL-TIME MUSIC, MADE TOGETHER' }}</span><span>BEAT ROYALE © {{ new Date().getFullYear() }}</span></footer>
  </div>
</template>

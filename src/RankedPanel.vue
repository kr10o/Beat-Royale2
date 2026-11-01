<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { totalScore, type RankedPlayer, type RankedView } from '../shared/ranked';
import type { Project } from '../shared/protocol';
const props = defineProps<{ project: Project | null; name: string }>();
const emit = defineEmits<{ studio: []; leaderboard: [players: RankedPlayer[]] }>();
const view = ref<RankedView | null>(null), alias = ref(''), apiKey = ref(''), busy = ref(false), notice = ref('');
const now = ref(Date.now()); let poll: ReturnType<typeof setInterval> | undefined; let refreshing = false; let serverOffset = 0;
const me = computed(() => view.value?.me), match = computed(() => view.value?.match);
const mine = computed(() => match.value?.players.find(p => p.id === me.value?.id));
const opponent = computed(() => match.value?.players.find(p => p.id !== me.value?.id));
const sponsored = computed(() => !!me.value?.verified && view.value?.sponsoredJudgeAvailable);
const remaining = computed(() => { const seconds = Math.max(0, Math.ceil(((match.value?.deadline ?? 0) - now.value) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; });
function accept(value: RankedView) { serverOffset = value.serverTime - Date.now(); now.value = value.serverTime; view.value = value; emit('leaderboard', value.leaderboard); }
async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try { const response = await fetch('/api/ranked/state'); if (response.ok) accept(await response.json()); }
  catch { /* A transient read failure must not reset a locked match or expose a key. */ }
  finally { refreshing = false; }
}
async function act(action: string, payload: Record<string, unknown> = {}) {
  busy.value = true; notice.value = '';
  try {
    const response = await fetch(`/api/ranked/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Ranked is temporarily unavailable.');
    accept(value);
  } catch (error) { notice.value = error instanceof Error ? error.message : 'Unable to complete the request.'; }
  finally { busy.value = false; }
}
async function createProfile() { await act('profile', { name: alias.value || props.name || 'Guest' }); }
async function queue() { await act('queue', { sponsor: !!apiKey.value.trim() }); }
async function judgeMatch() {
  const key = apiKey.value.trim();
  apiKey.value = ''; // Keep secrets out of persistence and clear the field as soon as sent.
  await act('judge', { matchId: match.value?.id, provider: 'google', apiKey: key });
}
async function googleLogin() {
  if (!me.value) await createProfile();
  if (view.value?.me && view.value.googleAvailable) location.assign('/api/ranked/auth/start');
}
onMounted(() => { void refresh(); poll = setInterval(() => { now.value = Date.now() + serverOffset; void refresh(); }, 3000); });
onUnmounted(() => { clearInterval(poll); apiKey.value = ''; });
</script>

<template>
  <main class="ranked-page">
    <section class="ranked-intro"><div><span class="eyebrow">ONE BEAT. ONE OPPONENT.</span><h1>Ranked <em>1v1.</em></h1><p>Same sounds. Five minutes. An independent AI scorecard.</p></div><span class="judge-badge">JUDGE / GEMINI 3.8 FLASH</span></section>
    <div class="ranked-columns">
      <section class="ranked-main">
        <div class="ranked-card identity-card"><div><span class="eyebrow">YOUR RANKED PROFILE</span><h2>{{ me?.name || 'Put your name on the board.' }}</h2><p v-if="me">{{ me.rating }} Elo · {{ me.wins }} wins · {{ me.losses }} losses · {{ me.verified ? 'Google linked' : 'Guest profile · saved on this browser' }}</p><p v-else>Join as a guest, or link Google when available.</p></div>
          <form v-if="!me" @submit.prevent="createProfile"><label class="sr-only" for="ranked-name">Ranked display name</label><input id="ranked-name" v-model="alias" maxlength="24" :placeholder="name || 'Your producer name'"><button class="primary" :disabled="busy">Create ranked profile</button></form>
          <button v-if="!me?.verified" class="google-button" :disabled="busy || !view?.googleAvailable" @click="googleLogin">Continue with Google</button>
          <small v-if="!view?.googleAvailable" class="muted">Google sign-in awaits site configuration. Guest + API key is available.</small>
        </div>
        <div class="ranked-card funding-card"><span class="eyebrow">POWER THE JUDGE</span><h3>One participant brings the key.</h3><label for="judge-provider">LLM provider</label><select id="judge-provider"><option value="google">Google AI Studio · Gemini 3.8 Flash</option></select><label for="judge-key">Your Gemini API key <span>optional if your opponent provides one</span></label><input id="judge-key" v-model="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste key for this match only"><p>Your key is used only for the server’s Google request. It is never saved or shared with your opponent. Google API usage is charged to the key’s project.</p><p v-if="sponsored" class="pack-check">Google-linked judging available · up to 3 sponsored attempts per day.</p></div>
        <div v-if="!match || ['finished','cancelled'].includes(match.phase)" class="ranked-card queue-card"><div><h3>Find your next challenger.</h3><p>At least one player must provide judging access. Rematches are limited to one pairing per day.</p></div><button v-if="!view?.queued" class="primary" :disabled="!me || busy" @click="queue">Find ranked match ↗</button><template v-else><span class="searching">● Looking for an opponent…</span><button :disabled="busy" @click="act('cancel-queue')">Leave queue</button></template></div>
        <div v-if="match" class="ranked-card match-card"><div class="match-header"><span class="eyebrow">{{ match.phase.replaceAll('_',' ').toUpperCase() }}</span><span v-if="!['finished','cancelled'].includes(match.phase)" class="match-clock">{{ remaining }}</span></div><div class="versus"><strong>{{ me?.name }}</strong><span>VS</span><strong>{{ opponent?.name }}</strong></div>
          <template v-if="match.phase === 'composing'"><div class="lock-status"><span>{{ mine?.locked ? '✓ Your beat locked' : 'Your beat is still open' }}</span><span>{{ opponent?.locked ? '✓ Opponent locked' : 'Opponent is producing' }}</span></div><p>Open the studio, build your beat, then lock it here. Locking is final for this match.</p><div class="ranked-actions"><button @click="emit('studio')">Open studio</button><button class="primary" :disabled="busy || !project || mine?.locked" @click="act('submit', { matchId: match.id, project })">{{ mine?.locked ? 'Beat locked ✓' : 'Lock my beat' }}</button></div><small v-if="!project" class="muted">Enter a studio as producer to create your beat first.</small></template>
          <template v-if="match.phase === 'awaiting_judge'"><h3>Both beats are locked.</h3><p>Submit two anonymous, equally long audio clips to Gemini. Once judged, the scorecard and Elo result are final.</p><button class="primary" :disabled="busy || (!apiKey.trim() && !sponsored)" @click="judgeMatch">{{ busy ? 'Sending to the judge…' : 'Judge match with Gemini' }}</button><small v-if="!apiKey.trim() && !sponsored" class="muted">Either participant can enter a key above and request judging.</small></template>
          <template v-if="match.phase === 'judging'"><h3 class="searching">Gemini is listening…</h3><p>Scoring groove, musicality, creativity and mix. Your key is not retained.</p></template>
          <template v-if="match.result"><div class="result-title">{{ match.result.winner === null ? 'A draw. Respect all around.' : match.result.winner === me?.id ? 'You won this battle.' : `${opponent?.name} takes this round.` }}</div><p>{{ match.result.summary }}</p><div class="scorecards"><div v-for="player in match.players" :key="player.id" class="scorecard"><strong>{{ player.name }}</strong><span class="score-total">{{ totalScore(match.result.scores[player.id]).toFixed(2) }}<small>/ 10</small></span><dl><template v-for="metric in (['groove','musicality','creativity','mix'] as const)" :key="metric"><dt>{{ metric }}</dt><dd>{{ match.result.scores[player.id][metric] }}</dd></template></dl><p>{{ match.result.scores[player.id].feedback }}</p><span class="elo-change">{{ match.result.changes[player.id] >= 0 ? '+' : '' }}{{ match.result.changes[player.id] }} Elo</span></div></div></template>
          <p v-if="match.error" class="ranked-error" role="status">{{ match.error }}</p>
        </div>
        <p v-if="notice" class="ranked-error" role="alert">{{ notice }}</p>
        <p class="ranked-disclosure">Ranked beta · AI judging is subjective. Groove 30%, musicality 25%, creativity 20%, mix 25%. Equal scores produce a draw. No rating is awarded when judging fails.</p>
      </section>
      <aside class="ranked-card leaderboard"><div class="leaderboard-title"><span class="eyebrow">PUBLIC LEADERBOARD</span><span>SEASON 01</span></div><h2>The ones to beat.</h2><div class="leaderboard-columns"><span>PRODUCER</span><span>ELO</span></div><div v-for="(player, index) in view?.leaderboard" :key="player.id" class="leaderboard-row"><span class="place">{{ String(index + 1).padStart(2,'0') }}</span><div><strong>{{ player.name }} <small v-if="player.verified">✓</small></strong><small>{{ player.wins }}W · {{ player.losses }}L · {{ player.draws }}D</small></div><strong>{{ player.rating }}</strong></div><div v-if="!view?.leaderboard.length" class="leaderboard-empty"><span>♜</span><h3>The first spot is open.</h3><p>Complete a judged match to appear here. Everyone in the lobby can see this board.</p></div><p class="ranked-disclosure">Guest profiles are browser-bound. Google-linked profiles can be recovered by signing in. No email addresses or API keys are public.</p></aside>
    </div>
  </main>
</template>

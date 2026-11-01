<script setup lang="ts">
import { computed } from 'vue';
import type { BattleView, DuelView } from '../shared/battle';
const props = defineProps<{ battle: BattleView; duel: DuelView | null; reason: string; self: string; producer: boolean; ready: boolean; connected: boolean; now: number; heard: string[]; auditioning: string }>();
defineEmits<{ ready: [value: boolean]; audition: [side: 'A' | 'B']; vote: [side: 'A' | 'B'] }>();
const time = computed(() => { const n = Math.max(0, Math.ceil(((props.battle.deadline ?? props.now) - props.now) / 1000)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2,'0')}`; });
const eliminated = computed(() => props.battle.standings.find(p => p.id === props.battle.eliminated));
const winner = computed(() => props.battle.standings.find(p => p.id === props.battle.winner));
const eligible = computed(() => props.connected && props.duel && !props.duel.voted && props.now >= props.duel.eligibleAt && props.now < props.duel.expiresAt && props.heard.includes('A') && props.heard.includes('B'));
</script>
<template>
  <section class="battle-panel"><div class="battle-top"><div><span class="eyebrow">BATTLE ROYALE / {{ battle.phase.toUpperCase() }}</span><h3>{{ battle.phase === 'waiting' ? `${battle.readyCount} / ${battle.requiredPlayers} ready` : battle.phase === 'finished' ? `${winner?.name} wins the battle.` : battle.phase === 'preparing' ? 'One minute. Find your groove.' : `Round ${battle.round} · ${battle.alive} still standing` }}</h3></div><button v-if="battle.phase === 'waiting' && producer" :disabled="!connected" :class="{ primary: !ready }" @click="$emit('ready', !ready)">{{ ready ? 'Ready ✓ · undo' : 'Ready for battle' }}</button><span v-else-if="battle.deadline" class="match-clock">{{ time }}</span></div>
    <p v-if="battle.phase === 'waiting'">The 50-minute match begins when all {{ battle.requiredPlayers }} producers are ready. Until then, the studio is open.</p>
    <p v-if="battle.phase === 'preparing'">Build your first beat. Each round judges a frozen version; edits carry into the next round.</p>
    <p v-if="eliminated && battle.phase === 'round'" class="elimination-note">{{ eliminated.name }} was eliminated · {{ eliminated.rank }}th place.</p>
    <div v-if="battle.phase === 'round' && duel" class="duel-panel"><div><strong>Blind A/B duel</strong><small>{{ duel.voted ? `Vote locked: ${duel.voted}` : 'Listen to both 4-second clips, then choose.' }}</small></div><div v-for="side in (['A','B'] as const)" :key="side" class="duel-side"><button :disabled="!connected || !!auditioning || now >= duel.expiresAt" @click="$emit('audition', side)">{{ auditioning === side ? 'Listening…' : `▶ Listen ${side}` }} {{ heard.includes(side) ? '✓' : '' }}</button><button class="primary" :disabled="!eligible" @click="$emit('vote', side)">Vote {{ side }}</button></div></div>
    <p v-else-if="battle.phase === 'round'">{{ reason }}</p>
    <p v-if="battle.phase === 'round'" class="ranked-disclosure">One vote per round. Ties use previous results, then a preassigned random order. No-vote rounds use the same tie rule.</p>
    <div v-if="battle.phase === 'finished'" class="battle-podium"><span v-for="p in [...battle.standings].sort((a,b) => (a.rank ?? 99) - (b.rank ?? 99)).slice(0,3)" :key="p.id">#{{ p.rank }} {{ p.name }}</span></div>
  </section>
</template>

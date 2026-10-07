<script setup lang="ts">
/**
 * The image Reports shares to WhatsApp: one headline number, its movement, and
 * at most two short top-five lists — never the full heat tables, which are
 * unreadable once a phone shrinks them to fit a chat bubble.
 *
 * Fixed 480px layout, rendered off-screen and exported at 2.25x (1080px wide,
 * WhatsApp's native image width), so a share from a phone and one from a
 * desktop produce the same picture. Type is sized for the phone that receives
 * it: 1080px shown ~390px wide, so 17px here reads as ~14px there.
 */
export type CardDelta = { text: string; dir: 'up' | 'down' | 'flat' };
export type CardRow = { label: string; value: string; delta?: CardDelta | null };
export type CardModel = {
  kicker: string;
  title: string;
  hero: { value: string; label: string; delta?: CardDelta | null; deltaNote?: string };
  secondary?: { label: string; value: string; delta?: CardDelta | null }[];
  sections: { title: string; rows: CardRow[]; numbered?: boolean }[];
  note?: string;
  footer: string;
};

defineProps<{ card: CardModel }>();
</script>

<template>
  <div class="share-card">
    <header class="sc-band">
      <div class="sc-kicker">{{ card.kicker }}</div>
      <div class="sc-title">{{ card.title }}</div>
    </header>

    <section class="sc-hero">
      <div class="sc-hero-value">{{ card.hero.value }}</div>
      <div class="sc-hero-label">{{ card.hero.label }}</div>
      <div v-if="card.hero.delta" class="sc-hero-delta" :class="card.hero.delta.dir">
        {{ card.hero.delta.text }}<span v-if="card.hero.deltaNote" class="sc-delta-note">
          {{ card.hero.deltaNote }}</span
        >
      </div>
      <div v-if="card.secondary?.length" class="sc-secondary">
        <span v-for="s in card.secondary" :key="s.label" class="sc-secondary-item">
          {{ s.label }} <strong>{{ s.value }}</strong>
          <span v-if="s.delta" class="sc-delta" :class="s.delta.dir">{{ s.delta.text }}</span>
        </span>
      </div>
    </section>

    <section v-for="sec in card.sections" :key="sec.title" class="sc-section">
      <h3 class="sc-section-title">{{ sec.title }}</h3>
      <ol class="sc-rows" :class="{ numbered: sec.numbered }">
        <li v-for="(r, i) in sec.rows" :key="i" class="sc-row">
          <span v-if="sec.numbered" class="sc-rank">{{ i + 1 }}</span>
          <span class="sc-label">{{ r.label }}</span>
          <span class="sc-value">{{ r.value }}</span>
          <span v-if="r.delta !== undefined" class="sc-delta" :class="r.delta?.dir ?? 'flat'">{{
            r.delta?.text ?? ''
          }}</span>
        </li>
      </ol>
    </section>

    <p v-if="card.note" class="sc-note">{{ card.note }}</p>
    <footer class="sc-footer">{{ card.footer }}</footer>
  </div>
</template>

<style scoped>
.share-card {
  width: 480px;
  background: #fff;
  color: #0b2545;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
  font-size: 17px;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.sc-band {
  background: #0b2545;
  color: #fff;
  padding: 20px 24px 18px;
}
.sc-kicker {
  font-size: 15px;
  opacity: 0.8;
}
.sc-title {
  font-size: 24px;
  font-weight: 700;
  margin-top: 2px;
}
.sc-hero {
  padding: 22px 24px 18px;
  border-bottom: 1px solid #e2e8f0;
}
.sc-hero-value {
  font-size: 52px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.02em;
}
.sc-hero-label {
  font-size: 18px;
  color: #475569;
  margin-top: 6px;
}
.sc-hero-delta {
  font-size: 20px;
  font-weight: 700;
  margin-top: 10px;
}
.sc-delta-note {
  font-weight: 400;
  color: #64748b;
}
.sc-secondary {
  margin-top: 14px;
  font-size: 16px;
  color: #475569;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
}
.sc-secondary strong {
  color: #0b2545;
}
.sc-secondary .sc-delta {
  min-width: 0;
  margin-left: 6px;
}
.sc-section {
  padding: 16px 24px 6px;
}
.sc-section-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 700;
  color: #64748b;
}
.sc-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sc-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #f1f5f9;
}
.sc-row:last-child {
  border-bottom: 0;
}
.sc-rank {
  flex: none;
  width: 18px;
  color: #94a3b8;
  font-weight: 700;
}
.sc-label {
  flex: 1;
  min-width: 0;
}
.sc-value {
  flex: none;
  font-weight: 700;
}
.sc-delta {
  flex: none;
  min-width: 62px;
  text-align: right;
  font-size: 15px;
  font-weight: 700;
}
.up {
  color: #16a34a;
}
.down {
  color: #dc2626;
}
.flat {
  color: #64748b;
}
.sc-note {
  margin: 8px 24px 0;
  padding: 10px 12px;
  background: #fff7ed;
  border-radius: 8px;
  font-size: 15px;
  color: #7c2d12;
}
.sc-footer {
  padding: 14px 24px 18px;
  font-size: 13px;
  color: #94a3b8;
}
</style>

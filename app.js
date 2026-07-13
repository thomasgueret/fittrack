import { EXERCISE_LIBRARY, EXERCISE_GROUPS, FOOD_LIBRARY, FOOD_CATEGORIES, MEALS } from "./data.js";
import { BODY_SVG } from "./body.js";

/* =========================================================
   État & persistance
   ========================================================= */
const APP_VERSION = "1.4.0";
const STORAGE_KEY = "fittrack-state-v1";

const DEFAULT_STATE = {
  settings: {
    sleepGoalH: 8,
    waterGoalMl: 2000,
    kcalGoal: 2500,
    protGoal: 150,
    glucGoal: 280,
    lipGoal: 80,
    bodyweightKg: 75,
  },
  customExercises: [],   // {id, name, group, unit, custom:true}
  customFoods: [],       // {id, name, cat, kcal, prot, gluc, lip, custom:true}
  templates: [],         // {id, name, exerciseIds:[]}
  sessions: [],          // {id, date:"YYYY-MM-DD", name, entries:[{exId, sets:[{w,r}]}]}
  activeSession: null,
  sleep: {},             // "YYYY-MM-DD" (jour du réveil) -> {hours, bed, wake, source?}
  nutrition: {},         // "YYYY-MM-DD" -> {meals:{breakfast:[{foodId,grams}],...}, water:ml}
  healthWorkoutDays: [], // jours d'entraînement importés d'Apple Santé
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(DEFAULT_STATE), ...parsed, settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) } };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* =========================================================
   Helpers
   ========================================================= */
const $ = (sel) => document.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2));

function keyFromDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const todayKey = () => keyFromDate(new Date());
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  return keyFromDate(date);
}
function fmtDateLong(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}
function fmtDateShort(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Normalisation pour la recherche : minuscules + sans accents ("creme" trouve "Crème")
function norm(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
const round1 = (n) => Math.round(n * 10) / 10;

function allExercises() { return [...EXERCISE_LIBRARY, ...state.customExercises]; }
function getExercise(id) { return allExercises().find((e) => e.id === id); }
function allFoods() { return [...FOOD_LIBRARY, ...state.customFoods]; }
function getFood(id) { return allFoods().find((f) => f.id === id); }

// Estimation 1RM (formule d'Epley)
const e1rm = (w, r) => (r <= 1 ? w : w * (1 + r / 30));

/* Charge réelle d'une série (poids de corps inclus) :
   - exercice "pdc" : poids de corps + lest éventuel (set.w)
   - série marquée PDC (set.pdc, via le pavé) : poids de corps seul
   - sinon : charge externe (set.w) */
function loadOfSet(ex, set) {
  const bw = state.settings.bodyweightKg;
  if (ex?.unit === "pdc") return bw + (Number(set.w) || 0);
  if (set.pdc) return bw;
  return Number(set.w) || 0;
}

// Libellé de la charge d'une série ("10 kg", "PDC", "PDC +10 kg")
function chargeLabel(ex, set) {
  const w = Number(set.w) || 0;
  if (ex?.unit === "pdc") return w > 0 ? `PDC +${w} kg` : "PDC";
  if (set.pdc) return "PDC";
  return `${w} kg`;
}

function workoutDaysSet() {
  const days = new Set(state.sessions.map((s) => s.date));
  state.healthWorkoutDays.forEach((d) => days.add(d));
  return days;
}

function getNutriDay(key) {
  if (!state.nutrition[key]) {
    state.nutrition[key] = { meals: { breakfast: [], lunch: [], dinner: [], snack: [] }, water: 0 };
  }
  return state.nutrition[key];
}

/* Meilleure performance historique pour un exercice.
   kg  → {w, r, e1rm} · pdc → {lest, r, e1rm} (avec poids de corps) · min → {min} */
function bestForExercise(exId) {
  const ex = getExercise(exId);
  if (!ex) return null;
  const bw = state.settings.bodyweightKg;
  let best = null;
  for (const session of state.sessions) {
    for (const entry of session.entries) {
      if (entry.exId !== exId) continue;
      for (const set of entry.sets) {
        if (ex.unit === "min") {
          const min = Number(set.r) || 0;
          if (min > 0 && (!best || min > best.min)) best = { min, date: session.date };
        } else if (ex.unit === "pdc") {
          const lest = Number(set.w) || 0, r = Number(set.r) || 0;
          if (r > 0) {
            const score = e1rm(bw + lest, r);
            if (!best || score > best.e1rm) best = { lest, r, e1rm: score, date: session.date };
          }
        } else {
          const load = loadOfSet(ex, set), r = Number(set.r) || 0;
          if (load > 0 && r > 0) {
            const score = e1rm(load, r);
            if (!best || score > best.e1rm) best = { w: Number(set.w) || 0, pdc: !!set.pdc, r, e1rm: score, date: session.date };
          }
        }
      }
    }
  }
  return best;
}

/* =========================================================
   Gamification — rangs et stats par groupe musculaire
   ========================================================= */
/* 24 grades : Fer I → Champion III. Les seuils (`min`, XP global) sont
   calibrés pour un entraînement QUOTIDIEN (~220 XP/jour : ~15 séries à
   10 XP + 2-3 groupes musculaires à 25 XP) :
   Cuivre I ≈ 1 mois, Bronze I ≈ 2 mois, Argent I ≈ 3 mois, Or I ≈ 6 mois,
   Diamant I ≈ 1 an, Platine I ≈ 2 ans, Champion I ≈ 3 ans. */
const RANK_FAMILIES = [
  { name: "Fer", color: "#9aa3ad" },
  { name: "Cuivre", color: "#c96f4a" },
  { name: "Bronze", color: "#cd8a4b" },
  { name: "Argent", color: "#c8d0dc" },
  { name: "Or", color: "#ffd166" },
  { name: "Diamant", color: "#4da3ff" },
  { name: "Platine", color: "#6fe3d4" },
  { name: "Champion", color: "#ff5c39" },
];
const RANK_THRESHOLDS = [
  0, 800, 2000,             // Fer I, II, III
  6500, 8500, 10500,        // Cuivre (I ≈ 1 mois → 6 600 XP)
  13000, 15000, 17000,      // Bronze (I ≈ 2 mois → 13 200 XP)
  19500, 26000, 32000,      // Argent (I ≈ 3 mois → 19 800 XP)
  39000, 52000, 65000,      // Or (I ≈ 6 mois → 39 600 XP)
  80000, 105000, 130000,    // Diamant (I ≈ 1 an → 80 300 XP)
  160000, 185000, 210000,   // Platine (I ≈ 2 ans → 160 600 XP)
  240000, 280000, 320000,   // Champion (I ≈ 3 ans → 240 900 XP)
];
const RANKS = RANK_FAMILIES.flatMap((f, i) =>
  ["I", "II", "III"].map((t, j) => ({ name: `${f.name} ${t}`, color: f.color, min: RANK_THRESHOLDS[i * 3 + j] })));

// Rang par groupe musculaire : seuils divisés par 6 (l'XP globale se
// répartit sur plusieurs groupes ; ~6 réellement travaillés en moyenne).
const GROUP_SCALE = 1 / 6;

// XP d'un groupe : 10 par série + 25 par séance incluant le groupe.
function rankFor(xp, scale = 1) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= Math.round(RANKS[i].min * scale)) idx = i;
  const rank = RANKS[idx], next = RANKS[idx + 1];
  const curMin = Math.round(rank.min * scale);
  const nextMin = next ? Math.round(next.min * scale) : null;
  const progress = next ? (xp - curMin) / (nextMin - curMin) : 1;
  return { rank, next, nextMin, progress: Math.min(1, progress), xp };
}

function computeGroupStats() {
  const map = {};
  EXERCISE_GROUPS.forEach((g) => { map[g] = { sets: 0, sessions: 0, last: null, sets30: 0 }; });
  const cutoff = addDays(todayKey(), -30);
  for (const s of state.sessions) {
    const groupsInSession = new Set();
    for (const e of s.entries) {
      const ex = getExercise(e.exId);
      if (!ex || !map[ex.group]) continue;
      map[ex.group].sets += e.sets.length;
      if (s.date >= cutoff) map[ex.group].sets30 += e.sets.length;
      groupsInSession.add(ex.group);
    }
    groupsInSession.forEach((g) => {
      map[g].sessions++;
      if (!map[g].last || s.date > map[g].last) map[g].last = s.date;
    });
  }
  Object.values(map).forEach((st) => { st.xp = st.sets * 10 + st.sessions * 25; });
  return map;
}

// Niveau d'intensité (couleur du muscle) selon les séries des 30 derniers jours
function levelFor(sets30) {
  if (!sets30) return 0;
  if (sets30 < 8) return 1;
  if (sets30 < 20) return 2;
  if (sets30 < 40) return 3;
  return 4;
}

function rankBadge(rank, label) {
  return `<span class="rank-badge" style="background:${rank.color}22;color:${rank.color}">
    <span style="width:8px;height:8px;border-radius:50%;background:${rank.color}"></span>${label || rank.name}</span>`;
}

// Libellé d'un record selon le type de compteur
function recordLabel(ex, best) {
  if (ex.unit === "min") return `<span class="badge purple">${best.min} min</span>`;
  if (ex.unit === "pdc") return `${best.r} reps${best.lest ? ` +${best.lest} kg` : ""} <span class="badge blue">PDC</span>`;
  if (best.pdc) return `PDC × ${best.r} <span class="badge accent">1RM ≈ ${Math.round(best.e1rm)} kg</span>`;
  return `${best.w} kg × ${best.r} <span class="badge accent">1RM ≈ ${Math.round(best.e1rm)} kg</span>`;
}

/* =========================================================
   Navigation par onglets
   ========================================================= */
const VIEWS = ["dashboard", "workout", "sleep", "nutrition", "settings"];
let currentView = "dashboard";

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

function showView(name) {
  currentView = name;
  VIEWS.forEach((v) => {
    $(`#view-${v}`).classList.toggle("active", v === name);
  });
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  renderCurrentView();
  window.scrollTo(0, 0);
}

function renderCurrentView() {
  ({ dashboard: renderDashboard, workout: renderWorkout, sleep: renderSleep, nutrition: renderNutrition, settings: renderSettings })[currentView]();
}

/* =========================================================
   Modal générique
   ========================================================= */
const backdrop = $("#modal-backdrop");
function openModal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  backdrop.classList.add("open");
  return $("#modal-body");
}
function closeModal() { backdrop.classList.remove("open"); }
$("#modal-close").addEventListener("click", closeModal);
backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });

/* =========================================================
   DASHBOARD
   ========================================================= */
function renderDashboard() {
  $("#dash-date").textContent = fmtDateLong(todayKey());

  // --- Stats de régularité ---
  const days = workoutDaysSet();
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  let weekCount = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    if (days.has(keyFromDate(d))) weekCount++;
  }
  const monthPrefix = todayKey().slice(0, 7);
  const monthCount = [...days].filter((d) => d.startsWith(monthPrefix)).length;

  $("#dash-stats").innerHTML = `
    <div class="stat-box accent"><div class="value">${weekCount}</div><div class="label">Séances cette semaine</div></div>
    <div class="stat-box green"><div class="value">${monthCount}</div><div class="label">Séances ce mois-ci</div></div>
    <div class="stat-box blue"><div class="value">${days.size}</div><div class="label">Jours d'entraînement</div></div>`;

  // --- Calendrier pixels (26 dernières semaines, lundi en haut) ---
  const NB_WEEKS = 26;
  const start = new Date(monday);
  start.setDate(monday.getDate() - (NB_WEEKS - 1) * 7);
  let colsHtml = "", monthsHtml = "";
  let lastMonth = -1;
  for (let w = 0; w < NB_WEEKS; w++) {
    const colStart = new Date(start); colStart.setDate(start.getDate() + w * 7);
    const m = colStart.getMonth();
    monthsHtml += `<span style="width:13px;flex-shrink:0">${m !== lastMonth ? colStart.toLocaleDateString("fr-FR", { month: "short" }).slice(0, 3) : ""}</span>`;
    lastMonth = m;
    let col = `<div class="pixel-col">`;
    for (let d = 0; d < 7; d++) {
      const day = new Date(colStart); day.setDate(colStart.getDate() + d);
      const key = keyFromDate(day);
      const future = day > today;
      col += `<div class="pixel ${days.has(key) ? "done" : ""} ${key === todayKey() ? "today" : ""}" ${future ? 'style="opacity:0.25"' : ""} title="${key}"></div>`;
    }
    colsHtml += col + `</div>`;
  }
  $("#pixel-calendar").innerHTML = colsHtml;
  $("#pixel-months").innerHTML = monthsHtml;
  const cal = $("#pixel-calendar");
  cal.scrollLeft = cal.scrollWidth;

  // --- Records personnels ---
  const exIds = new Set();
  state.sessions.forEach((s) => s.entries.forEach((e) => exIds.add(e.exId)));
  const records = [...exIds]
    .map((id) => ({ ex: getExercise(id), best: bestForExercise(id) }))
    .filter((r) => r.ex && r.best)
    .sort((a, b) => (b.best.e1rm || b.best.min || 0) - (a.best.e1rm || a.best.min || 0))
    .slice(0, 6);
  $("#dash-records").innerHTML = records.length
    ? records.map((r) => `
        <div class="list-item">
          <div class="li-main">
            <div class="li-title">${escapeHtml(r.ex.name)}</div>
            <div class="li-sub">${fmtDateShort(r.best.date)}</div>
          </div>
          <div class="li-value">${recordLabel(r.ex, r.best)}</div>
        </div>`).join("")
    : `<div class="empty-state"><div class="big">🏆</div>Terminez votre première séance pour voir vos records ici.</div>`;

  // --- Résumé du jour ---
  const tk = todayKey();
  const sleep = state.sleep[tk];
  const nutri = state.nutrition[tk];
  const totals = nutri ? dayTotals(tk) : null;
  const trainedToday = days.has(tk);
  $("#dash-today").innerHTML = `
    <div class="list-item"><div class="li-main"><div class="li-title">🏋️ Entraînement</div></div>
      <div class="li-value">${trainedToday ? '<span class="badge green">Séance réalisée ✓</span>' : '<span class="badge accent">À faire</span>'}</div></div>
    <div class="list-item"><div class="li-main"><div class="li-title">😴 Sommeil</div></div>
      <div class="li-value">${sleep ? `${round1(sleep.hours)} h / ${state.settings.sleepGoalH} h` : "—"}</div></div>
    <div class="list-item"><div class="li-main"><div class="li-title">🍽️ Calories</div></div>
      <div class="li-value">${totals ? `${Math.round(totals.kcal)} / ${state.settings.kcalGoal} kcal` : "—"}</div></div>
    <div class="list-item"><div class="li-main"><div class="li-title">💧 Eau</div></div>
      <div class="li-value">${nutri ? `${nutri.water} / ${state.settings.waterGoalMl} ml` : "—"}</div></div>`;
}

/* =========================================================
   ENTRAÎNEMENT — séances types (templates)
   ========================================================= */
let activeExIndex = null; // exercice ouvert dans la séance active (sous-vue détail)

function renderWorkout() {
  const home = $("#workout-home"), active = $("#workout-active"), exDetail = $("#workout-exercise");
  const showEx = state.activeSession && activeExIndex !== null && state.activeSession.entries[activeExIndex];
  home.classList.toggle("hidden", !!state.activeSession);
  active.classList.toggle("hidden", !state.activeSession || !!showEx);
  exDetail.classList.toggle("hidden", !showEx);
  if (showEx) { renderExerciseDetail(); return; }
  if (state.activeSession) { activeExIndex = null; renderActiveSession(); return; }

  renderCharacter();

  // Liste des séances types
  $("#template-list").innerHTML = state.templates.length
    ? state.templates.map((t) => `
        <div class="list-item">
          <div class="li-main tappable" data-edit-template="${t.id}">
            <div class="li-title">${escapeHtml(t.name)}</div>
            <div class="li-sub">${t.exerciseIds.length} exercice${t.exerciseIds.length > 1 ? "s" : ""} — ${t.exerciseIds.map((id) => escapeHtml(getExercise(id)?.name || "?")).slice(0, 3).join(", ")}${t.exerciseIds.length > 3 ? "…" : ""}</div>
          </div>
          <button class="btn primary small" data-start-template="${t.id}">Démarrer</button>
        </div>`).join("")
    : `<div class="empty-state"><div class="big">📋</div>Créez votre première séance type avec « + Séance ».</div>`;

  $("#template-list").querySelectorAll("[data-start-template]").forEach((b) =>
    b.addEventListener("click", () => startSession(b.dataset.startTemplate)));
  $("#template-list").querySelectorAll("[data-edit-template]").forEach((el) =>
    el.addEventListener("click", () => openTemplateEditor(el.dataset.editTemplate)));

  // Historique
  const history = [...state.sessions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
  $("#session-history").innerHTML = history.length
    ? history.map((s) => {
        const nbSets = s.entries.reduce((n, e) => n + e.sets.length, 0);
        const vol = s.entries.reduce((v, e) => {
          const ex = getExercise(e.exId);
          if (ex?.unit === "min") return v;
          return v + e.sets.reduce((sv, set) => {
            const r = Number(set.r) || 0;
            return sv + (r > 0 ? loadOfSet(ex, set) * r : 0);
          }, 0);
        }, 0);
        return `
        <div class="list-item">
          <div class="li-main">
            <div class="li-title">${escapeHtml(s.name)}</div>
            <div class="li-sub">${fmtDateShort(s.date)} — ${s.entries.length} exos, ${nbSets} séries${vol ? `, ${Math.round(vol)} kg de volume` : ""}</div>
          </div>
          <button class="btn ghost small danger" data-del-session="${s.id}">✕</button>
        </div>`;
      }).join("")
    : `<div class="empty-state"><div class="big">🕐</div>Aucune séance enregistrée pour le moment.</div>`;

  $("#session-history").querySelectorAll("[data-del-session]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!confirm("Supprimer cette séance de l'historique ?")) return;
      state.sessions = state.sessions.filter((s) => s.id !== b.dataset.delSession);
      save(); renderWorkout();
    }));
}

/* ---------- Personnage : silhouette, rangs, panneau muscle ---------- */
let selectedGroup = null;

function renderCharacter() {
  const stats = computeGroupStats();

  // Rang global du personnage
  const totalXp = Object.values(stats).reduce((a, s) => a + s.xp, 0);
  const global = rankFor(totalXp);
  $("#global-rank-badge").innerHTML = rankBadge(global.rank, `${global.rank.name} · ${totalXp} XP`);

  // Silhouette colorée par intensité (30 derniers jours)
  $("#body-map").innerHTML = BODY_SVG;
  const zones = document.querySelectorAll("#body-map .muscle");
  zones.forEach((z) => {
    const g = z.dataset.group;
    z.classList.add(`lvl-${levelFor(stats[g]?.sets30 || 0)}`);
    z.addEventListener("click", () => selectMuscle(g, stats));
    z.addEventListener("mouseenter", () => selectMuscle(g, stats));
  });

  // Liste des rangs par groupe
  $("#rank-list").innerHTML = EXERCISE_GROUPS.map((g) => {
    const { rank } = rankFor(stats[g].xp, GROUP_SCALE);
    return `<div class="rank-item tappable" data-group-row="${g}">
      <span class="rg-name">${g}</span>${rankBadge(rank)}</div>`;
  }).join("");
  document.querySelectorAll("[data-group-row]").forEach((el) =>
    el.addEventListener("click", () => selectMuscle(el.dataset.groupRow, stats)));

  selectMuscle(selectedGroup, stats, true);
}

function selectMuscle(group, stats, silent) {
  const panel = $("#muscle-panel");
  if (!group || !stats[group]) {
    if (!silent) return;
    panel.innerHTML = `<span style="color:var(--text-faint)">Touchez un muscle sur la silhouette (ou survolez-le sur PC) pour voir vos statistiques et votre rang.</span>`;
    return;
  }
  selectedGroup = group;
  document.querySelectorAll("#body-map .muscle").forEach((z) =>
    z.classList.toggle("selected", z.dataset.group === group));

  const st = stats[group];
  const { rank, next, nextMin, progress, xp } = rankFor(st.xp, GROUP_SCALE);
  panel.innerHTML = `
    <div class="mp-head"><span class="mp-name">${group}</span>${rankBadge(rank, `${rank.name}`)}</div>
    <div class="mp-rows">
      <span>Entraînements : <strong>${st.sessions}</strong></span>
      <span>Séries : <strong>${st.sets}</strong></span>
      <span>Dernier : <strong>${st.last ? fmtDateShort(st.last) : "jamais"}</strong></span>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.round(progress * 100)}%;background:${rank.color}"></div></div>
    <div class="mp-next">${next ? `${xp} XP — encore ${nextMin - xp} XP avant le rang ${next.name}` : `${xp} XP — rang maximum atteint 👑`}</div>`;
}

$("#btn-new-template").addEventListener("click", () => openTemplateEditor(null));

function openTemplateEditor(templateId, draftOverride) {
  const tpl = templateId ? state.templates.find((t) => t.id === templateId) : { id: null, name: "", exerciseIds: [] };
  const draft = draftOverride || { ...tpl, exerciseIds: [...tpl.exerciseIds] };

  const body = openModal(templateId ? "Modifier la séance" : "Nouvelle séance", `
    <label class="field"><span class="field-name">Nom de la séance</span>
      <input type="text" id="tpl-name" placeholder="Ex : Push, Pull, Legs…" value="${escapeHtml(draft.name)}"></label>
    <div class="field-name" style="font-size:12.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px">Exercices</div>
    <div id="tpl-exercises"></div>
    <button class="btn full" id="tpl-add-ex" style="margin:10px 0">+ Ajouter un exercice</button>
    <button class="btn primary full" id="tpl-save">Enregistrer la séance</button>
    ${templateId ? '<button class="btn full danger ghost" id="tpl-delete" style="margin-top:8px">Supprimer cette séance</button>' : ""}
  `);

  function renderDraftExercises() {
    body.querySelector("#tpl-exercises").innerHTML = draft.exerciseIds.length
      ? draft.exerciseIds.map((id, i) => `
          <div class="list-item">
            <div class="li-main"><div class="li-title">${escapeHtml(getExercise(id)?.name || "?")}</div>
            <div class="li-sub">${escapeHtml(getExercise(id)?.group || "")}</div></div>
            <button class="btn ghost small danger" data-rm="${i}">✕</button>
          </div>`).join("")
      : `<div class="empty-state" style="padding:14px">Aucun exercice pour l'instant.</div>`;
    body.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { draft.exerciseIds.splice(Number(b.dataset.rm), 1); renderDraftExercises(); }));
  }
  renderDraftExercises();

  body.querySelector("#tpl-add-ex").addEventListener("click", () => {
    draft.name = body.querySelector("#tpl-name").value;
    openExercisePicker((exId) => {
      draft.exerciseIds.push(exId);
      openTemplateEditor(templateId, draft);
    });
  });

  body.querySelector("#tpl-save").addEventListener("click", () => {
    const name = body.querySelector("#tpl-name").value.trim();
    if (!name) { alert("Donnez un nom à la séance."); return; }
    if (templateId) {
      const t = state.templates.find((t) => t.id === templateId);
      t.name = name; t.exerciseIds = draft.exerciseIds;
    } else {
      state.templates.push({ id: uid(), name, exerciseIds: draft.exerciseIds });
    }
    save(); closeModal(); renderWorkout();
  });

  body.querySelector("#tpl-delete")?.addEventListener("click", () => {
    if (!confirm("Supprimer cette séance type ?")) return;
    state.templates = state.templates.filter((t) => t.id !== templateId);
    save(); closeModal(); renderWorkout();
  });
}

/* ---------- Sélecteur d'exercices (bibliothèque) ---------- */
function openExercisePicker(onPick) {
  const body = openModal("Bibliothèque d'exercices", `
    <input type="text" id="ex-search" placeholder="🔍 Rechercher un exercice…" style="margin-bottom:10px">
    <div class="group-chips" id="ex-chips"></div>
    <div id="ex-list"></div>
    <div class="divider"></div>
    <button class="btn full" id="btn-new-exercise">+ Créer un nouvel exercice</button>
  `);

  let activeGroup = "Tous";
  const groups = ["Tous", ...EXERCISE_GROUPS];

  function renderChips() {
    body.querySelector("#ex-chips").innerHTML = groups.map((g) =>
      `<button class="chip ${g === activeGroup ? "active" : ""}" data-g="${g}">${g}</button>`).join("");
    body.querySelectorAll("[data-g]").forEach((c) =>
      c.addEventListener("click", () => { activeGroup = c.dataset.g; renderChips(); renderList(); }));
  }

  function renderList() {
    const q = norm(body.querySelector("#ex-search").value.trim());
    const items = allExercises().filter((e) =>
      (activeGroup === "Tous" || e.group === activeGroup) &&
      (!q || norm(e.name).includes(q)));

    // Exercices déjà réalisés, du plus récent au plus ancien
    let recentsHtml = "";
    if (!q && activeGroup === "Tous") {
      const recentIds = [];
      [...state.sessions].sort((x, y) => y.date.localeCompare(x.date)).forEach((sess) =>
        sess.entries.forEach((e) => { if (!recentIds.includes(e.exId) && getExercise(e.exId)) recentIds.push(e.exId); }));
      if (recentIds.length) {
        recentsHtml = `<div class="field-name" style="font-size:12px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin:4px 0 2px">Récents</div>`
          + recentIds.slice(0, 5).map((id) => {
            const e = getExercise(id);
            return `<div class="list-item tappable" data-pick="${e.id}">
              <div class="li-main"><div class="li-title">${escapeHtml(e.name)}</div>
              <div class="li-sub">${escapeHtml(e.group)}</div></div>
              <span style="color:var(--text-faint)">›</span></div>`;
          }).join("")
          + `<div class="divider"></div>`;
      }
    }

    body.querySelector("#ex-list").innerHTML = recentsHtml + (items.length
      ? items.map((e) => `
          <div class="list-item tappable" data-pick="${e.id}">
            <div class="li-main"><div class="li-title">${escapeHtml(e.name)}${e.custom ? ' <span class="badge accent">perso</span>' : ""}</div>
            <div class="li-sub">${escapeHtml(e.group)} · ${{ kg: "charge × reps", pdc: "poids de corps", min: "chronomètre" }[e.unit] || "charge × reps"}</div></div>
            <span style="color:var(--text-faint)">›</span>
          </div>`).join("")
      : `<div class="empty-state">Aucun exercice trouvé.</div>`);
    body.querySelectorAll("[data-pick]").forEach((el) =>
      el.addEventListener("click", () => { closeModal(); onPick(el.dataset.pick); }));
  }

  renderChips(); renderList();
  body.querySelector("#ex-search").addEventListener("input", renderList);

  body.querySelector("#btn-new-exercise").addEventListener("click", () => openNewExerciseForm(onPick));
}

function openNewExerciseForm(onPick) {
  const body = openModal("Nouvel exercice", `
    <label class="field"><span class="field-name">Nom</span><input type="text" id="nex-name" placeholder="Ex : Curl à la poulie basse"></label>
    <label class="field"><span class="field-name">Groupe musculaire</span>
      <select id="nex-group">${EXERCISE_GROUPS.map((g) => `<option>${g}</option>`).join("")}</select></label>
    <label class="field"><span class="field-name">Type de compteur</span>
      <select id="nex-unit">
        <option value="kg">Charge (kg) × répétitions</option>
        <option value="pdc">Poids de corps (reps + lest optionnel)</option>
        <option value="min">Chronomètre / durée (min)</option>
      </select></label>
    <button class="btn primary full" id="nex-save">Créer l'exercice</button>
  `);
  body.querySelector("#nex-save").addEventListener("click", () => {
    const name = body.querySelector("#nex-name").value.trim();
    if (!name) { alert("Donnez un nom à l'exercice."); return; }
    const ex = { id: "custom-" + uid(), name, group: body.querySelector("#nex-group").value, unit: body.querySelector("#nex-unit").value, custom: true };
    state.customExercises.push(ex);
    save(); closeModal();
    if (onPick) onPick(ex.id);
  });
}

/* ---------- Séance active ---------- */
function startSession(templateId) {
  const tpl = state.templates.find((t) => t.id === templateId);
  state.activeSession = {
    id: uid(),
    date: todayKey(),
    type: "muscu",
    name: tpl ? tpl.name : "Musculation",
    entries: (tpl ? tpl.exerciseIds : []).map((exId) => ({ exId, sets: [] })),
  };
  activeExIndex = null;
  save(); renderWorkout();
}

// Choix du sport au démarrage d'une séance libre
$("#btn-start-session").addEventListener("click", () => {
  const body = openModal("Nouvelle séance", `
    <div class="section-note" style="margin-bottom:12px">Choisissez votre sport :</div>
    <button class="btn full" id="sport-muscu" style="margin-bottom:10px;font-size:16px;padding:15px">🏋️ &nbsp;Musculation</button>
    <button class="btn full" style="margin-bottom:10px;font-size:16px;padding:15px;opacity:0.45">🏃 &nbsp;Course à pied <span class="badge accent" style="margin-left:6px">bientôt</span></button>
    <button class="btn full" style="font-size:16px;padding:15px;opacity:0.45">🏊 &nbsp;Natation <span class="badge accent" style="margin-left:6px">bientôt</span></button>
  `);
  body.querySelector("#sport-muscu").addEventListener("click", () => { closeModal(); startSession(null); });
});

// Libellé d'une série ("10 reps × 10 kg", "10 reps × PDC", "1.5 min")
function serieLabel(ex, set) {
  if (ex?.unit === "min") return `<span class="sr-val">${Number(set.r) || 0} <span class="x">min</span></span>`;
  const charge = chargeLabel(ex, set);
  const hl = charge.startsWith("PDC");
  return `<span class="sr-val">${Number(set.r) || 0} <span class="x">reps ×</span> <span class="${hl ? "hl" : ""}">${charge}</span></span>`;
}

// Totaux d'un groupe de séries (pour les cartes de date, style Liftoff :
// le PDC ne compte pas dans le total kg, seule la charge externe est sommée)
function entryTotals(ex, sets) {
  if (ex?.unit === "min") {
    const min = sets.reduce((a, s2) => a + (Number(s2.r) || 0), 0);
    return { a: { v: sets.length, l: "séries" }, b: { v: round1(min), l: "min" } };
  }
  const reps = sets.reduce((a, s2) => a + (Number(s2.r) || 0), 0);
  const kg = sets.reduce((a, s2) => a + (Number(s2.w) || 0) * (Number(s2.r) || 0), 0);
  return { a: { v: reps, l: "reps" }, b: { v: Math.round(kg), l: "kg" } };
}

function renderActiveSession() {
  const s = state.activeSession;
  $("#active-session-name").textContent = s.name;
  $("#active-session-sub").textContent = fmtDateLong(s.date);

  $("#active-session-exercises").innerHTML = s.entries.length
    ? s.entries.map((entry, ei) => {
        const ex = getExercise(entry.exId);
        const last = entry.sets[entry.sets.length - 1];
        return `
        <div class="list-item">
          <div class="li-main tappable" data-open-ex="${ei}">
            <div class="li-title">${escapeHtml(ex?.name || "?")}</div>
            <div class="li-sub">${entry.sets.length} série${entry.sets.length > 1 ? "s" : ""}${last ? ` — dernière : ${Number(last.r) || 0}${ex?.unit === "min" ? " min" : ` reps × ${chargeLabel(ex, last)}`}` : " — touchez pour saisir vos séries"}</div>
          </div>
          <button class="btn ghost small danger" data-rm-ex="${ei}">✕</button>
        </div>`;
      }).join("")
    : `<div class="empty-state"><div class="big">🏋️</div>Ajoutez un premier exercice pour démarrer.</div>`;

  const root = $("#active-session-exercises");
  root.querySelectorAll("[data-open-ex]").forEach((el) =>
    el.addEventListener("click", () => { activeExIndex = Number(el.dataset.openEx); renderWorkout(); }));
  root.querySelectorAll("[data-rm-ex]").forEach((b) =>
    b.addEventListener("click", () => {
      if (s.entries[b.dataset.rmEx].sets.length && !confirm("Supprimer cet exercice et ses séries ?")) return;
      s.entries.splice(Number(b.dataset.rmEx), 1);
      save(); renderActiveSession();
    }));
}

/* ---------- Détail d'un exercice : séries du jour + historique ---------- */
function renderExerciseDetail() {
  const s = state.activeSession;
  const entry = s.entries[activeExIndex];
  const ex = getExercise(entry.exId);
  $("#ex-detail-name").textContent = ex?.name || "?";
  $("#ex-detail-sub").textContent = `${ex?.group || ""} · ${{ kg: "charge × reps", pdc: "poids de corps", min: "chronomètre" }[ex?.unit] || ""}`;

  const dateCard = (dateKey, sets, current) => {
    const t = entryTotals(ex, sets);
    const [y, m, d] = dateKey.split("-");
    return `
    <div class="date-card ${current ? "" : "past"}">
      <div class="dc-date">${d}/${m}<small>${y}</small></div>
      <div class="dc-label">Total</div>
      <div class="dc-stat"><div class="v">${t.a.v}</div><div class="l">${t.a.l}</div></div>
      <div class="dc-stat"><div class="v">${t.b.v}</div><div class="l">${t.b.l}</div></div>
      ${current ? '<div class="dc-label" style="margin-left:auto">en cours</div>' : ""}
    </div>`;
  };

  // Séance en cours (séries supprimables)
  let html = dateCard(s.date, entry.sets, true);
  html += entry.sets.length
    ? entry.sets.map((set, si) => `
        <div class="serie-row">
          <span class="sr-num">Série ${si + 1}</span>
          ${serieLabel(ex, set)}
          <button class="sr-del" data-del-serie="${si}">✕</button>
        </div>`).join("")
    : `<div class="empty-state" style="padding:14px">Aucune série — appuyez sur « + Ajouter une série ».</div>`;

  // Historique : séances passées contenant cet exercice
  const past = [...state.sessions]
    .filter((sess) => sess.entries.some((e) => e.exId === entry.exId))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);
  for (const sess of past) {
    const pastSets = sess.entries.filter((e) => e.exId === entry.exId).flatMap((e) => e.sets);
    html += dateCard(sess.date, pastSets, false);
    html += pastSets.map((set, si) => `
      <div class="serie-row">
        <span class="sr-num">Série ${si + 1}</span>
        ${serieLabel(ex, set)}
      </div>`).join("");
  }

  $("#ex-detail-cards").innerHTML = html;
  $("#ex-detail-cards").querySelectorAll("[data-del-serie]").forEach((b) =>
    b.addEventListener("click", () => {
      entry.sets.splice(Number(b.dataset.delSerie), 1);
      save(); renderExerciseDetail();
    }));
}

$("#btn-ex-back").addEventListener("click", () => { activeExIndex = null; renderWorkout(); });
$("#btn-add-serie").addEventListener("click", () => {
  const entry = state.activeSession?.entries[activeExIndex];
  if (entry) openSetKeypad(entry, getExercise(entry.exId));
});

// Dernière série réalisée pour un exercice (dans l'historique)
function lastSetForExercise(exId) {
  const sess = [...state.sessions]
    .filter((s) => s.entries.some((e) => e.exId === exId))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!sess) return null;
  const sets = sess.entries.filter((e) => e.exId === exId).flatMap((e) => e.sets);
  return sets[sets.length - 1] || null;
}

/* ---------- Pavé numérique de saisie de série (style Liftoff) ---------- */
function openSetKeypad(entry, ex) {
  const unit = ex?.unit || "kg";
  const isMin = unit === "min";
  const padKeys = (prefix, extra) => {
    let keys = "";
    for (let n = 1; n <= 9; n++) keys += `<button class="pad-key" data-key="${prefix}:${n}">${n}</button>`;
    keys += `<button class="pad-key" data-key="${prefix}:0">0</button>${extra}`;
    return keys;
  };

  const body = openModal("Séries", isMin ? `
    <div class="pad-section-head"><span class="pad-label">Durée :</span><span class="pad-value" id="pad-a"></span></div>
    <div class="pad-grid">${padKeys("a", `<button class="pad-key" data-key="a:.">,</button><button class="pad-key" data-key="a:clear">Effacer</button>`)}</div>
    <button class="btn full" id="pad-chrono" style="margin:12px 0 10px">⏱ Lancer le chrono</button>
    <button class="btn primary full" id="pad-validate">Valider la série</button>
  ` : `
    <div class="pad-section-head"><span class="pad-label">Nombre de répétitions :</span><span class="pad-value" id="pad-a"></span></div>
    <div class="pad-grid">${padKeys("a", `<button class="pad-key span-2" data-key="a:clear">Effacer</button>`)}</div>
    <div class="pad-section-head"><span class="pad-label">${unit === "pdc" ? "Lest :" : "Charge :"}</span><span class="pad-value" id="pad-b"></span></div>
    <div class="pad-grid">${padKeys("b", `<button class="pad-key" id="pad-pdc" data-key="b:pdc">PDC</button><button class="pad-key" data-key="b:clear">Effacer</button>`)}</div>
    <button class="btn primary full" id="pad-validate" style="margin-top:16px">Valider la série</button>
  `);

  // Pré-remplissage avec la série précédente (séance en cours, sinon historique).
  // La première touche remplace la valeur pré-remplie au lieu de s'y ajouter.
  const prev = entry.sets[entry.sets.length - 1] || lastSetForExercise(entry.exId);
  let a = "", b = "", pdcFlag = unit === "pdc";
  let aFresh = false, bFresh = false;
  if (prev) {
    a = String(Number(prev.r) || "");
    b = Number(prev.w) > 0 ? String(Number(prev.w)) : "";
    if (unit === "kg") pdcFlag = !!prev.pdc;
    aFresh = !!a; bFresh = true;
  }
  let padChrono = null;

  function refresh() {
    if (isMin) {
      body.querySelector("#pad-a").innerHTML = `${a || "0"} <span class="unit">min</span>`;
      return;
    }
    body.querySelector("#pad-a").innerHTML = `${a || "0"} <span class="unit">reps</span>`;
    const bEl = body.querySelector("#pad-b");
    if (unit === "pdc") bEl.innerHTML = b ? `PDC <span class="unit">+</span> ${b} <span class="unit">kg</span>` : `<span style="color:var(--accent)">PDC</span>`;
    else if (pdcFlag) bEl.innerHTML = `<span style="color:var(--accent)">PDC</span>`;
    else bEl.innerHTML = `${b || "0"} <span class="unit">kg</span>`;
    body.querySelector("#pad-pdc")?.classList.toggle("active", pdcFlag && !b);
  }

  body.querySelectorAll("[data-key]").forEach((k) =>
    k.addEventListener("click", () => {
      const [target, val] = k.dataset.key.split(":");
      if (val === "clear") { if (target === "a") { a = ""; aFresh = false; } else { b = ""; bFresh = false; pdcFlag = unit === "pdc"; } }
      else if (val === "pdc") { pdcFlag = true; b = ""; bFresh = false; }
      else if (val === ".") { if (aFresh) { a = "0."; aFresh = false; } else if (!a.includes(".")) a = (a || "0") + "."; }
      else if (target === "a") {
        if (aFresh) { a = val; aFresh = false; }
        else if (a.replace(".", "").length < 4) a += val;
      } else {
        if (bFresh) { b = val; bFresh = false; }
        else if (b.length < 4) b += val;
        if (unit !== "pdc") pdcFlag = false;
      }
      refresh();
    }));

  body.querySelector("#pad-chrono")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (padChrono) {
      clearInterval(padChrono.timer);
      a = String(Math.round(((Date.now() - padChrono.start) / 60000) * 100) / 100);
      padChrono = null;
      btn.textContent = "⏱ Lancer le chrono";
      refresh();
      return;
    }
    padChrono = { start: Date.now(), timer: setInterval(() => {
      if (!document.contains(btn)) { clearInterval(padChrono.timer); padChrono = null; return; }
      const sec = Math.floor((Date.now() - padChrono.start) / 1000);
      btn.textContent = `⏹ Arrêter — ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    }, 400) };
    btn.textContent = "⏹ Arrêter — 0:00";
  });

  body.querySelector("#pad-validate").addEventListener("click", () => {
    const r = Number(a);
    if (!(r > 0)) { alert(isMin ? "Indiquez une durée (ou utilisez le chrono)." : "Indiquez un nombre de répétitions."); return; }
    if (padChrono) { clearInterval(padChrono.timer); padChrono = null; }
    const set = { w: Number(b) || 0, r };
    if (!isMin && unit !== "pdc" && pdcFlag) set.pdc = true;
    entry.sets.push(set);
    save(); closeModal(); renderExerciseDetail();
  });

  refresh();
}

$("#btn-session-add-exercise").addEventListener("click", () =>
  openExercisePicker((exId) => {
    state.activeSession.entries.push({ exId, sets: [] });
    activeExIndex = state.activeSession.entries.length - 1;
    save(); renderWorkout(); // ouvre directement la fiche de l'exercice
  }));

$("#btn-cancel-session").addEventListener("click", () => {
  if (!confirm("Abandonner cette séance ? Les données saisies seront perdues.")) return;
  state.activeSession = null;
  activeExIndex = null;
  save(); renderWorkout();
});

$("#btn-finish-session").addEventListener("click", () => {
  const s = state.activeSession;
  // Records AVANT enregistrement, pour détecter les nouveaux PR
  const prevBests = {};
  s.entries.forEach((e) => { prevBests[e.exId] = bestForExercise(e.exId); });

  // Ne garder que les séries remplies
  const cleaned = s.entries
    .map((e) => ({ exId: e.exId, sets: e.sets.filter((set) => Number(set.w) > 0 || Number(set.r) > 0) }))
    .filter((e) => e.sets.length > 0);
  if (!cleaned.length) { alert("Aucune série renseignée. Remplissez au moins une série (ou annulez la séance)."); return; }

  state.sessions.push({ id: s.id, date: s.date, name: s.name, entries: cleaned });
  state.activeSession = null;
  activeExIndex = null;
  save();

  // Détection des nouveaux records
  const prs = [];
  cleaned.forEach((e) => {
    const ex = getExercise(e.exId), prev = prevBests[e.exId], now = bestForExercise(e.exId);
    if (!ex || !now) return;
    if (ex.unit === "min") {
      if (!prev || now.min > prev.min) prs.push(`${ex.name} : ${now.min} min`);
    } else if (!prev || now.e1rm > prev.e1rm) {
      if (ex.unit === "pdc") prs.push(`${ex.name} : ${now.r} reps${now.lest ? ` +${now.lest} kg` : ""}`);
      else if (now.pdc) prs.push(`${ex.name} : PDC × ${now.r}`);
      else prs.push(`${ex.name} : ${now.w} kg × ${now.r}`);
    }
  });
  if (prs.length) alert("🏆 Nouveau record personnel !\n\n" + prs.join("\n"));
  renderWorkout();
});

/* =========================================================
   SOMMEIL
   ========================================================= */
function renderSleep() {
  const goal = state.settings.sleepGoalH;
  const entry = state.sleep[todayKey()];
  const hours = entry ? entry.hours : 0;
  const pct = Math.min(100, (hours / goal) * 100);

  // Anneau de progression
  const R = 46, C = 2 * Math.PI * R;
  $("#sleep-ring").innerHTML = `
    <svg width="110" height="110" viewBox="0 0 110 110">
      <circle cx="55" cy="55" r="${R}" fill="none" stroke="var(--card-hover)" stroke-width="10"/>
      <circle cx="55" cy="55" r="${R}" fill="none" stroke="var(--purple)" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/>
    </svg>
    <div class="ring-label"><span class="big">${entry ? round1(hours) + " h" : "—"}</span><span class="small">${Math.round(pct)} % de l'objectif</span></div>`;

  $("#sleep-today-summary").innerHTML = entry
    ? `Nuit du ${fmtDateShort(addDays(todayKey(), -1))} : <strong>${round1(hours)} h</strong>${entry.bed ? ` (${entry.bed} → ${entry.wake})` : ""}.<br>${hours >= goal ? "🎉 Objectif atteint !" : `Il manque ${round1(goal - hours)} h pour atteindre votre objectif.`}`
    : `Aucune nuit enregistrée pour ce matin. Objectif : <strong>${goal} h</strong>.`;

  // Graphique 7 jours
  const maxH = Math.max(goal, ...Object.values(state.sleep).map((s) => s.hours), 9);
  let bars = "";
  for (let i = 6; i >= 0; i--) {
    const key = addDays(todayKey(), -i);
    const e = state.sleep[key];
    const h = e ? e.hours : 0;
    const heightPct = (h / maxH) * 100;
    const dayLabel = new Date(key + "T12:00").toLocaleDateString("fr-FR", { weekday: "short" }).slice(0, 3);
    bars += `
      <div class="bar-col">
        <span class="bar-value">${e ? round1(h) : ""}</span>
        <div class="bar ${h >= goal ? "" : "under"}" style="height:${Math.max(heightPct, 2)}%"></div>
        <span class="bar-label">${dayLabel}</span>
      </div>`;
  }
  $("#sleep-chart").innerHTML = bars;
  $("#sleep-goal-note").textContent = `Objectif : ${goal} h — barres violettes = objectif atteint.`;

  // Stats 30 jours
  const last30 = [];
  for (let i = 0; i < 30; i++) {
    const e = state.sleep[addDays(todayKey(), -i)];
    if (e) last30.push(e.hours);
  }
  const avg = last30.length ? last30.reduce((a, b) => a + b, 0) / last30.length : 0;
  const hit = last30.filter((h) => h >= goal).length;
  $("#sleep-stats-note").innerHTML = last30.length
    ? `Sur 30 jours : moyenne <strong>${round1(avg)} h</strong>, objectif atteint <strong>${hit}/${last30.length}</strong> nuits.`
    : "Enregistrez vos nuits pour voir vos statistiques sur 30 jours.";

  $("#sleep-goal-input").value = goal;
}

$("#btn-save-sleep-goal").addEventListener("click", () => {
  const v = Number($("#sleep-goal-input").value);
  if (v >= 4 && v <= 12) { state.settings.sleepGoalH = v; save(); renderSleep(); }
});

$("#btn-log-sleep").addEventListener("click", () => {
  const existing = state.sleep[todayKey()];
  const body = openModal("Enregistrer ma nuit", `
    <p class="section-note" style="margin-bottom:12px">Nuit du ${fmtDateShort(addDays(todayKey(), -1))} au ${fmtDateShort(todayKey())}</p>
    <div class="field-row">
      <label class="field"><span class="field-name">Coucher</span><input type="time" id="sl-bed" value="${existing?.bed || "23:00"}"></label>
      <label class="field"><span class="field-name">Réveil</span><input type="time" id="sl-wake" value="${existing?.wake || "07:00"}"></label>
    </div>
    <div class="section-note" id="sl-duration" style="margin-bottom:12px"></div>
    <button class="btn primary full" id="sl-save">Enregistrer</button>
  `);
  function computeH() {
    const [bh, bm] = body.querySelector("#sl-bed").value.split(":").map(Number);
    const [wh, wm] = body.querySelector("#sl-wake").value.split(":").map(Number);
    let mins = (wh * 60 + wm) - (bh * 60 + bm);
    if (mins <= 0) mins += 24 * 60;
    return mins / 60;
  }
  function refresh() { body.querySelector("#sl-duration").innerHTML = `Durée : <strong>${round1(computeH())} h</strong>`; }
  body.querySelector("#sl-bed").addEventListener("input", refresh);
  body.querySelector("#sl-wake").addEventListener("input", refresh);
  refresh();
  body.querySelector("#sl-save").addEventListener("click", () => {
    state.sleep[todayKey()] = { hours: computeH(), bed: body.querySelector("#sl-bed").value, wake: body.querySelector("#sl-wake").value };
    save(); closeModal(); renderSleep();
  });
});

/* =========================================================
   NUTRITION
   ========================================================= */
let nutriDate = todayKey();

function dayTotals(key) {
  const day = state.nutrition[key];
  const totals = { kcal: 0, prot: 0, gluc: 0, lip: 0 };
  if (!day) return totals;
  Object.values(day.meals).forEach((items) => items.forEach(({ foodId, grams }) => {
    const f = getFood(foodId);
    if (!f) return;
    const k = grams / 100;
    totals.kcal += f.kcal * k; totals.prot += f.prot * k; totals.gluc += f.gluc * k; totals.lip += f.lip * k;
  }));
  return totals;
}

function renderNutrition() {
  const day = getNutriDay(nutriDate);
  $("#nutri-date-label").textContent = nutriDate === todayKey() ? "Aujourd'hui — " + fmtDateShort(nutriDate) : fmtDateLong(nutriDate);

  // Macros
  const t = dayTotals(nutriDate);
  const g = state.settings;
  const macro = (name, val, goal, unit, color) => `
    <div class="macro-row">
      <div class="macro-labels"><span class="name">${name}</span><span class="nums">${Math.round(val)} / ${goal} ${unit}</span></div>
      <div class="progress-track"><div class="progress-fill ${color}" style="width:${Math.min(100, (val / goal) * 100)}%"></div></div>
    </div>`;
  $("#nutri-macros").innerHTML =
    macro("Calories", t.kcal, g.kcalGoal, "kcal", "") +
    macro("Protéines", t.prot, g.protGoal, "g", "green") +
    macro("Glucides", t.gluc, g.glucGoal, "g", "yellow") +
    macro("Lipides", t.lip, g.lipGoal, "g", "purple");

  // Eau
  const waterPct = Math.min(100, (day.water / g.waterGoalMl) * 100);
  $("#water-badge").textContent = `${day.water} / ${g.waterGoalMl} ml`;
  $("#water-fill").style.width = waterPct + "%";
  const nbGlasses = Math.ceil(g.waterGoalMl / 250);
  $("#water-glasses").innerHTML = Array.from({ length: nbGlasses }, (_, i) =>
    `<span class="water-glass ${day.water >= (i + 1) * 250 ? "filled" : ""}">💧</span>`).join("");

  // Repas
  $("#meals-container").innerHTML = MEALS.map((meal) => {
    const items = day.meals[meal.id] || [];
    const mealKcal = items.reduce((k, it) => k + (getFood(it.foodId)?.kcal || 0) * it.grams / 100, 0);
    return `
    <div class="meal-section">
      <div class="meal-head">
        <span class="meal-name">${meal.icon} ${meal.name}</span>
        <span class="meal-kcal">${Math.round(mealKcal)} kcal</span>
      </div>
      ${items.map((it, i) => {
        const f = getFood(it.foodId);
        return `
        <div class="list-item">
          <div class="li-main"><div class="li-title" style="font-size:14px">${escapeHtml(f?.name || "?")}</div>
          <div class="li-sub">${it.grams} g — ${Math.round((f?.kcal || 0) * it.grams / 100)} kcal · P ${round1((f?.prot || 0) * it.grams / 100)} · G ${round1((f?.gluc || 0) * it.grams / 100)} · L ${round1((f?.lip || 0) * it.grams / 100)}</div></div>
          <button class="btn ghost small danger" data-rm-food="${meal.id}:${i}">✕</button>
        </div>`;
      }).join("")}
      <button class="btn small" data-add-food="${meal.id}" style="margin:6px 0 10px">+ Ajouter un aliment</button>
    </div>`;
  }).join("");

  $("#meals-container").querySelectorAll("[data-add-food]").forEach((b) =>
    b.addEventListener("click", () => openFoodPicker(b.dataset.addFood)));
  $("#meals-container").querySelectorAll("[data-rm-food]").forEach((b) =>
    b.addEventListener("click", () => {
      const [mealId, idx] = b.dataset.rmFood.split(":");
      getNutriDay(nutriDate).meals[mealId].splice(Number(idx), 1);
      save(); renderNutrition();
    }));
}

$("#nutri-prev").addEventListener("click", () => { nutriDate = addDays(nutriDate, -1); renderNutrition(); });
$("#nutri-next").addEventListener("click", () => { nutriDate = addDays(nutriDate, 1); renderNutrition(); });

document.querySelectorAll("[data-water]").forEach((b) =>
  b.addEventListener("click", () => {
    const day = getNutriDay(nutriDate);
    if (b.dataset.water === "reset") day.water = 0;
    else day.water += Number(b.dataset.water);
    save(); renderNutrition();
  }));

/* ---------- Sélecteur d'aliments (bibliothèque) ---------- */
function openFoodPicker(mealId) {
  const body = openModal("Ajouter un aliment", `
    <input type="text" id="food-search" placeholder="🔍 Rechercher un aliment…" style="margin-bottom:10px">
    <div class="group-chips" id="food-chips"></div>
    <div id="food-list"></div>
    <div class="divider"></div>
    <button class="btn full" id="btn-new-food">+ Créer un nouvel aliment</button>
  `);

  let activeCat = "Tous";
  const cats = ["Tous", ...FOOD_CATEGORIES];

  function renderChips() {
    body.querySelector("#food-chips").innerHTML = cats.map((c) =>
      `<button class="chip ${c === activeCat ? "active" : ""}" data-c="${c}">${c}</button>`).join("");
    body.querySelectorAll("[data-c]").forEach((chip) =>
      chip.addEventListener("click", () => { activeCat = chip.dataset.c; renderChips(); renderList(); }));
  }

  function renderList() {
    const q = norm(body.querySelector("#food-search").value.trim());
    const items = allFoods().filter((f) =>
      (activeCat === "Tous" || f.cat === activeCat) &&
      (!q || norm(f.name).includes(q)));
    body.querySelector("#food-list").innerHTML = items.length
      ? items.map((f) => `
          <div class="list-item tappable" data-pick="${f.id}">
            <div class="li-main"><div class="li-title" style="font-size:14px">${escapeHtml(f.name)}${f.custom ? ' <span class="badge accent">perso</span>' : ""}</div>
            <div class="li-sub">${f.kcal} kcal · P ${f.prot} · G ${f.gluc} · L ${f.lip} (pour 100 g/ml)</div></div>
            <span style="color:var(--text-faint)">›</span>
          </div>`).join("")
      : `<div class="empty-state">Aucun aliment trouvé.</div>`;
    body.querySelectorAll("[data-pick]").forEach((el) =>
      el.addEventListener("click", () => openGramsStep(mealId, el.dataset.pick)));
  }

  renderChips(); renderList();
  body.querySelector("#food-search").addEventListener("input", renderList);
  body.querySelector("#btn-new-food").addEventListener("click", () => openNewFoodForm(mealId));
}

function openGramsStep(mealId, foodId) {
  const f = getFood(foodId);
  const body = openModal(f.name, `
    <p class="section-note" style="margin-bottom:12px">${f.kcal} kcal · P ${f.prot} g · G ${f.gluc} g · L ${f.lip} g — pour 100 g/ml</p>
    <label class="field"><span class="field-name">Quantité (g ou ml)</span>
      <input type="number" id="grams-input" inputmode="numeric" value="100" min="1"></label>
    <div class="section-note" id="grams-preview" style="margin-bottom:12px"></div>
    <button class="btn primary full" id="grams-add">Ajouter au repas</button>
  `);
  const input = body.querySelector("#grams-input");
  function refresh() {
    const k = (Number(input.value) || 0) / 100;
    body.querySelector("#grams-preview").innerHTML =
      `→ <strong>${Math.round(f.kcal * k)} kcal</strong> · P ${round1(f.prot * k)} g · G ${round1(f.gluc * k)} g · L ${round1(f.lip * k)} g`;
  }
  input.addEventListener("input", refresh); refresh();
  input.select?.();
  body.querySelector("#grams-add").addEventListener("click", () => {
    const grams = Number(input.value);
    if (!(grams > 0)) return;
    getNutriDay(nutriDate).meals[mealId].push({ foodId, grams });
    save(); closeModal(); renderNutrition();
  });
}

function openNewFoodForm(mealId) {
  const body = openModal("Nouvel aliment", `
    <label class="field"><span class="field-name">Nom</span><input type="text" id="nf-name" placeholder="Ex : Compote sans sucre"></label>
    <label class="field"><span class="field-name">Catégorie</span>
      <select id="nf-cat">${FOOD_CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select></label>
    <p class="section-note" style="margin-bottom:10px">Valeurs pour <strong>100 g</strong> :</p>
    <div class="field-row">
      <label class="field"><span class="field-name">kcal</span><input type="number" id="nf-kcal" min="0"></label>
      <label class="field"><span class="field-name">Prot. (g)</span><input type="number" id="nf-prot" min="0" step="0.1"></label>
    </div>
    <div class="field-row">
      <label class="field"><span class="field-name">Gluc. (g)</span><input type="number" id="nf-gluc" min="0" step="0.1"></label>
      <label class="field"><span class="field-name">Lip. (g)</span><input type="number" id="nf-lip" min="0" step="0.1"></label>
    </div>
    <button class="btn primary full" id="nf-save">Créer l'aliment</button>
  `);
  body.querySelector("#nf-save").addEventListener("click", () => {
    const name = body.querySelector("#nf-name").value.trim();
    if (!name) { alert("Donnez un nom à l'aliment."); return; }
    const food = {
      id: "custom-" + uid(), name, cat: body.querySelector("#nf-cat").value,
      kcal: Number(body.querySelector("#nf-kcal").value) || 0,
      prot: Number(body.querySelector("#nf-prot").value) || 0,
      gluc: Number(body.querySelector("#nf-gluc").value) || 0,
      lip: Number(body.querySelector("#nf-lip").value) || 0,
      custom: true,
    };
    state.customFoods.push(food);
    save();
    openGramsStep(mealId, food.id);
  });
}

/* =========================================================
   RÉGLAGES
   ========================================================= */
function renderSettings() {
  const g = state.settings;
  $("#set-bodyweight").value = g.bodyweightKg;
  $("#set-kcal").value = g.kcalGoal;
  $("#set-water").value = g.waterGoalMl;
  $("#set-prot").value = g.protGoal;
  $("#set-gluc").value = g.glucGoal;
  $("#set-lip").value = g.lipGoal;
  $("#app-version").textContent = `FitTrack v${APP_VERSION} — ${allFoods().length} aliments, ${allExercises().length} exercices en bibliothèque`;
}

$("#btn-save-settings").addEventListener("click", () => {
  const g = state.settings;
  g.bodyweightKg = Number($("#set-bodyweight").value) || g.bodyweightKg;
  g.kcalGoal = Number($("#set-kcal").value) || g.kcalGoal;
  g.waterGoalMl = Number($("#set-water").value) || g.waterGoalMl;
  g.protGoal = Number($("#set-prot").value) || g.protGoal;
  g.glucGoal = Number($("#set-gluc").value) || g.glucGoal;
  g.lipGoal = Number($("#set-lip").value) || g.lipGoal;
  save();
  alert("Objectifs enregistrés ✓");
});

/* ---------- Import Apple Santé (export.xml) ---------- */
$("#btn-health-import").addEventListener("click", () => $("#health-import-file").click());

$("#health-import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("#health-import-status");
  status.textContent = "Lecture du fichier… (peut prendre un moment sur un gros export)";
  try {
    const text = await file.text();
    let sleepNights = 0, waterDays = 0, workoutDays = 0;

    // Sommeil et eau : agrégés par jour, appliqués de façon idempotente
    const sleepByDay = {}, waterByDay = {};
    const recordRe = /<Record[^>]*type="([^"]+)"[^>]*\/?>/g;
    let m;
    while ((m = recordRe.exec(text)) !== null) {
      const tag = m[0], type = m[1];
      const attr = (name) => (tag.match(new RegExp(name + '="([^"]+)"')) || [])[1];
      if (type === "HKCategoryTypeIdentifierSleepAnalysis") {
        const value = attr("value") || "";
        if (!value.includes("Asleep")) continue;
        const start = new Date(attr("startDate")), end = new Date(attr("endDate"));
        if (isNaN(start) || isNaN(end)) continue;
        const day = keyFromDate(end);
        sleepByDay[day] = (sleepByDay[day] || 0) + (end - start) / 3600000;
      } else if (type === "HKQuantityTypeIdentifierDietaryWater") {
        const val = Number(attr("value")), unit = attr("unit") || "";
        const day = keyFromDate(new Date(attr("startDate")));
        if (!isNaN(val) && day) {
          const ml = unit.toLowerCase() === "l" ? val * 1000 : val;
          waterByDay[day] = (waterByDay[day] || 0) + ml;
        }
      }
    }
    for (const [day, hours] of Object.entries(sleepByDay)) {
      if (!state.sleep[day] || state.sleep[day].source === "health") {
        state.sleep[day] = { hours: round1(hours), source: "health" };
        sleepNights++;
      }
    }
    for (const [day, ml] of Object.entries(waterByDay)) {
      const dayData = getNutriDay(day);
      dayData.water = Math.max(dayData.water, Math.round(ml));
      waterDays++;
    }

    // Entraînements : on marque les jours pour le calendrier de régularité
    const workoutRe = /<Workout[^>]*startDate="([^"]+)"[^>]*/g;
    const daysSet = new Set(state.healthWorkoutDays);
    while ((m = workoutRe.exec(text)) !== null) {
      const day = keyFromDate(new Date(m[1]));
      if (!daysSet.has(day)) { daysSet.add(day); workoutDays++; }
    }
    state.healthWorkoutDays = [...daysSet];

    save();
    status.innerHTML = `✅ Import terminé : <strong>${sleepNights}</strong> nuits de sommeil, <strong>${workoutDays}</strong> jours d'entraînement, eau sur <strong>${waterDays}</strong> jours.`;
  } catch (err) {
    status.textContent = "❌ Échec de l'import : " + err.message;
  }
  e.target.value = "";
});

/* ---------- Sauvegarde JSON ---------- */
$("#btn-export-json").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fittrack-sauvegarde-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#btn-import-json").addEventListener("click", () => $("#json-import-file").click());
$("#json-import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.settings || !Array.isArray(data.sessions)) throw new Error("format inattendu");
    if (!confirm("Remplacer toutes les données actuelles par cette sauvegarde ?")) return;
    state = { ...structuredClone(DEFAULT_STATE), ...data, settings: { ...DEFAULT_STATE.settings, ...data.settings } };
    save(); renderCurrentView();
    alert("Sauvegarde importée ✓");
  } catch (err) {
    alert("Fichier invalide : " + err.message);
  }
  e.target.value = "";
});

$("#btn-reset-all").addEventListener("click", () => {
  if (!confirm("⚠️ Effacer TOUTES les données (séances, sommeil, nutrition) ? Cette action est irréversible.")) return;
  if (!confirm("Vraiment sûr ? Pensez à exporter une sauvegarde avant.")) return;
  state = structuredClone(DEFAULT_STATE);
  save(); renderCurrentView();
});

/* =========================================================
   Démarrage
   ========================================================= */
showView(state.activeSession ? "workout" : "dashboard");

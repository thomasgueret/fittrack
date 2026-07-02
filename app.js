import { EXERCISE_LIBRARY, EXERCISE_GROUPS, FOOD_LIBRARY, FOOD_CATEGORIES, MEALS } from "./data.js";

/* =========================================================
   État & persistance
   ========================================================= */
const APP_VERSION = "1.1.0";
const STORAGE_KEY = "fittrack-state-v1";

const DEFAULT_STATE = {
  settings: {
    sleepGoalH: 8,
    waterGoalMl: 2000,
    kcalGoal: 2500,
    protGoal: 150,
    glucGoal: 280,
    lipGoal: 80,
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
   Retourne {w, r, e1rm} pour les exercices en kg, {min} pour les exercices en minutes. */
function bestForExercise(exId) {
  const ex = getExercise(exId);
  if (!ex) return null;
  let best = null;
  for (const session of state.sessions) {
    for (const entry of session.entries) {
      if (entry.exId !== exId) continue;
      for (const set of entry.sets) {
        if (ex.unit === "min") {
          const min = Number(set.r) || 0;
          if (min > 0 && (!best || min > best.min)) best = { min, date: session.date };
        } else {
          const w = Number(set.w) || 0, r = Number(set.r) || 0;
          if (w > 0 && r > 0) {
            const score = e1rm(w, r);
            if (!best || score > best.e1rm) best = { w, r, e1rm: score, date: session.date };
          }
        }
      }
    }
  }
  return best;
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
          <div class="li-value">${r.ex.unit === "min"
            ? `<span class="badge purple">${r.best.min} min</span>`
            : `${r.best.w} kg × ${r.best.r} <span class="badge accent">1RM ≈ ${Math.round(r.best.e1rm)} kg</span>`}</div>
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
function renderWorkout() {
  const home = $("#workout-home"), active = $("#workout-active");
  if (state.activeSession) {
    home.classList.add("hidden");
    active.classList.remove("hidden");
    renderActiveSession();
    return;
  }
  home.classList.remove("hidden");
  active.classList.add("hidden");

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
          return v + e.sets.reduce((sv, set) => sv + (Number(set.w) || 0) * (Number(set.r) || 0), 0);
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
    body.querySelector("#ex-list").innerHTML = items.length
      ? items.map((e) => `
          <div class="list-item tappable" data-pick="${e.id}">
            <div class="li-main"><div class="li-title">${escapeHtml(e.name)}${e.custom ? ' <span class="badge accent">perso</span>' : ""}</div>
            <div class="li-sub">${escapeHtml(e.group)} · ${e.unit === "min" ? "durée" : "charge × reps"}</div></div>
            <span style="color:var(--text-faint)">›</span>
          </div>`).join("")
      : `<div class="empty-state">Aucun exercice trouvé.</div>`;
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
    <label class="field"><span class="field-name">Type de suivi</span>
      <select id="nex-unit"><option value="kg">Charge (kg) × répétitions</option><option value="min">Durée (minutes)</option></select></label>
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
    name: tpl ? tpl.name : "Séance libre",
    entries: (tpl ? tpl.exerciseIds : []).map((exId) => ({ exId, sets: [{ w: "", r: "" }, { w: "", r: "" }, { w: "", r: "" }] })),
  };
  save(); renderWorkout();
}

function renderActiveSession() {
  const s = state.activeSession;
  $("#active-session-name").textContent = s.name;
  $("#active-session-sub").textContent = fmtDateLong(s.date);

  $("#active-session-exercises").innerHTML = s.entries.map((entry, ei) => {
    const ex = getExercise(entry.exId);
    const best = bestForExercise(entry.exId);
    const isMin = ex?.unit === "min";
    const bestTxt = best ? (isMin ? `Record : ${best.min} min` : `Record : ${best.w} kg × ${best.r} (1RM ≈ ${Math.round(best.e1rm)} kg)`) : "Premier passage 💪";
    return `
    <div class="card session-exercise">
      <div class="ex-head">
        <div>
          <div class="ex-name">${escapeHtml(ex?.name || "?")}</div>
          <div class="ex-best">${bestTxt}</div>
        </div>
        <button class="btn ghost small danger" data-rm-ex="${ei}">✕</button>
      </div>
      <div class="set-cols-header"><span>#</span><span>${isMin ? "Durée (min)" : "Poids (kg)"}</span><span>${isMin ? "" : "Reps"}</span><span></span></div>
      ${entry.sets.map((set, si) => `
        <div class="set-row">
          <span class="set-num">${si + 1}</span>
          <input type="number" inputmode="decimal" step="0.5" placeholder="${isMin ? "min" : "kg"}" value="${isMin ? set.r : set.w}" data-set="${ei}:${si}:${isMin ? "r" : "w"}">
          ${isMin ? "<span></span>" : `<input type="number" inputmode="numeric" placeholder="reps" value="${set.r}" data-set="${ei}:${si}:r">`}
          <button class="set-del" data-rm-set="${ei}:${si}">✕</button>
        </div>`).join("")}
      <button class="btn small full" data-add-set="${ei}">+ Série</button>
    </div>`;
  }).join("") || `<div class="empty-state"><div class="big">🏋️</div>Ajoutez un premier exercice pour démarrer.</div>`;

  // Bindings (mise à jour de l'état sans re-render pour garder le focus)
  const root = $("#active-session-exercises");
  root.querySelectorAll("[data-set]").forEach((input) =>
    input.addEventListener("input", () => {
      const [ei, si, field] = input.dataset.set.split(":");
      s.entries[ei].sets[si][field] = input.value;
      save();
    }));
  root.querySelectorAll("[data-add-set]").forEach((b) =>
    b.addEventListener("click", () => { s.entries[b.dataset.addSet].sets.push({ w: "", r: "" }); save(); renderActiveSession(); }));
  root.querySelectorAll("[data-rm-set]").forEach((b) =>
    b.addEventListener("click", () => {
      const [ei, si] = b.dataset.rmSet.split(":");
      s.entries[ei].sets.splice(Number(si), 1);
      save(); renderActiveSession();
    }));
  root.querySelectorAll("[data-rm-ex]").forEach((b) =>
    b.addEventListener("click", () => { s.entries.splice(Number(b.dataset.rmEx), 1); save(); renderActiveSession(); }));
}

$("#btn-session-add-exercise").addEventListener("click", () =>
  openExercisePicker((exId) => {
    state.activeSession.entries.push({ exId, sets: [{ w: "", r: "" }, { w: "", r: "" }, { w: "", r: "" }] });
    save(); renderActiveSession();
  }));

$("#btn-cancel-session").addEventListener("click", () => {
  if (!confirm("Abandonner cette séance ? Les données saisies seront perdues.")) return;
  state.activeSession = null;
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
  save();

  // Détection des nouveaux records
  const prs = [];
  cleaned.forEach((e) => {
    const ex = getExercise(e.exId), prev = prevBests[e.exId], now = bestForExercise(e.exId);
    if (!ex || !now) return;
    if (ex.unit === "min") {
      if (!prev || now.min > prev.min) prs.push(`${ex.name} : ${now.min} min`);
    } else if (!prev || now.e1rm > prev.e1rm) {
      prs.push(`${ex.name} : ${now.w} kg × ${now.r}`);
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
  $("#set-kcal").value = g.kcalGoal;
  $("#set-water").value = g.waterGoalMl;
  $("#set-prot").value = g.protGoal;
  $("#set-gluc").value = g.glucGoal;
  $("#set-lip").value = g.lipGoal;
  $("#app-version").textContent = `FitTrack v${APP_VERSION} — ${allFoods().length} aliments, ${allExercises().length} exercices en bibliothèque`;
}

$("#btn-save-settings").addEventListener("click", () => {
  const g = state.settings;
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

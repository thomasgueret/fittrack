// Silhouette interactive (face + dos) — les zones .muscle portent data-group
// et sont colorées selon l'intensité d'entraînement (classes lvl-0 à lvl-4).
export const BODY_SVG = `
<svg viewBox="0 0 340 340" xmlns="http://www.w3.org/2000/svg" id="body-svg">
  <!-- ===== FACE (cx = 80) ===== -->
  <g class="body-base">
    <circle cx="80" cy="26" r="15"/>
    <rect x="74" y="40" width="12" height="10" rx="4"/>
    <path d="M 50 58 C 44 74, 46 110, 56 150 L 104 150 C 114 110, 116 74, 110 58 C 100 50, 60 50, 50 58 Z"/>
    <rect x="56" y="150" width="48" height="30" rx="10"/>
    <rect x="32" y="60" width="15" height="98" rx="7"/>
    <rect x="113" y="60" width="15" height="98" rx="7"/>
    <rect x="57" y="178" width="21" height="118" rx="9"/>
    <rect x="82" y="178" width="21" height="118" rx="9"/>
  </g>
  <g class="muscles">
    <circle class="muscle" data-group="Épaules" cx="41" cy="67" r="9"/>
    <circle class="muscle" data-group="Épaules" cx="119" cy="67" r="9"/>
    <rect class="muscle" data-group="Pectoraux" x="56" y="66" width="23" height="25" rx="8"/>
    <rect class="muscle" data-group="Pectoraux" x="81" y="66" width="23" height="25" rx="8"/>
    <rect class="muscle" data-group="Biceps" x="34" y="88" width="11" height="30" rx="5"/>
    <rect class="muscle" data-group="Biceps" x="115" y="88" width="11" height="30" rx="5"/>
    <rect class="muscle" data-group="Abdos" x="63" y="97" width="34" height="48" rx="8"/>
    <rect class="muscle" data-group="Jambes" x="60" y="184" width="15" height="52" rx="7"/>
    <rect class="muscle" data-group="Jambes" x="85" y="184" width="15" height="52" rx="7"/>
    <rect class="muscle" data-group="Jambes" x="61" y="252" width="13" height="36" rx="6"/>
    <rect class="muscle" data-group="Jambes" x="86" y="252" width="13" height="36" rx="6"/>
  </g>

  <!-- ===== DOS (cx = 250) ===== -->
  <g class="body-base">
    <circle cx="250" cy="26" r="15"/>
    <rect x="244" y="40" width="12" height="10" rx="4"/>
    <path d="M 220 58 C 214 74, 216 110, 226 150 L 274 150 C 284 110, 286 74, 280 58 C 270 50, 230 50, 220 58 Z"/>
    <rect x="226" y="150" width="48" height="30" rx="10"/>
    <rect x="202" y="60" width="15" height="98" rx="7"/>
    <rect x="283" y="60" width="15" height="98" rx="7"/>
    <rect x="227" y="178" width="21" height="118" rx="9"/>
    <rect x="252" y="178" width="21" height="118" rx="9"/>
  </g>
  <g class="muscles">
    <circle class="muscle" data-group="Épaules" cx="211" cy="67" r="9"/>
    <circle class="muscle" data-group="Épaules" cx="289" cy="67" r="9"/>
    <path class="muscle" data-group="Dos" d="M 226 62 L 274 62 C 278 80, 276 100, 268 118 L 232 118 C 224 100, 222 80, 226 62 Z"/>
    <rect class="muscle" data-group="Dos" x="238" y="122" width="24" height="24" rx="6"/>
    <rect class="muscle" data-group="Triceps" x="204" y="88" width="11" height="30" rx="5"/>
    <rect class="muscle" data-group="Triceps" x="285" y="88" width="11" height="30" rx="5"/>
    <rect class="muscle" data-group="Fessiers" x="228" y="152" width="21" height="26" rx="9"/>
    <rect class="muscle" data-group="Fessiers" x="251" y="152" width="21" height="26" rx="9"/>
    <rect class="muscle" data-group="Jambes" x="230" y="184" width="15" height="52" rx="7"/>
    <rect class="muscle" data-group="Jambes" x="255" y="184" width="15" height="52" rx="7"/>
    <rect class="muscle" data-group="Jambes" x="231" y="252" width="13" height="36" rx="6"/>
    <rect class="muscle" data-group="Jambes" x="256" y="252" width="13" height="36" rx="6"/>
  </g>

  <text x="80" y="332" text-anchor="middle" class="body-label">Face</text>
  <text x="250" y="332" text-anchor="middle" class="body-label">Dos</text>
</svg>`;

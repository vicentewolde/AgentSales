import {
  type CoverData,
  type ReelOverlayData,
  SLIDE_SIZES,
  type SlideBrand,
  type SpecSheetData,
} from "@agentsales/core";
import {
  dataUrl,
  documentOf,
  escapeHtml,
  OPERATION_LABEL,
  place,
  readableOn,
  safeColor,
} from "./html.js";
import { icon } from "./icons.js";

// Diseño (docs/04-formato-publicaciones.md): textos dentro de márgenes seguros de 64 px, Inter,
// colores del corredor e íconos solo de los datos que llegan. Nunca la dirección: los tipos de
// datos no la traen.

const MARGIN = 64;
/** Filas de la ficha: más no caben en 1080×1350 con el resto. */
const MAX_SPEC_ROWS = 10;
const DEFAULT_PRIMARY = "#1F4E79";

function brandColors(brand: SlideBrand) {
  const primary = safeColor(brand.primaryColor, DEFAULT_PRIMARY);
  const secondary = safeColor(brand.secondaryColor, primary);
  return { primary, secondary, onPrimary: readableOn(primary), onSecondary: readableOn(secondary) };
}

/** El logo del corredor, o su nombre si no tiene. */
function brandMark(brand: SlideBrand, className: string): string {
  const src = brand.logo === null ? null : dataUrl(brand.logo);
  return src === null
    ? `<span class="${className}-name">${escapeHtml(brand.brandName)}</span>`
    : `<img class="${className}" src="${src}" alt="">`;
}

export function coverHtml(data: CoverData, fontCss: string): string {
  const { width, height } = SLIDE_SIZES.cover;
  const colors = brandColors(data.brand);
  const photo = dataUrl(data.photo);
  const facts = data.facts
    .slice(0, 3)
    .map((fact) => `<li>${icon(fact.icon, 40)}<span>${escapeHtml(fact.text)}</span></li>`)
    .join("");
  const css = `
.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.shade{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.82) 0%,rgba(0,0,0,.45) 30%,rgba(0,0,0,0) 55%),linear-gradient(to bottom,rgba(0,0,0,.35) 0%,rgba(0,0,0,0) 22%)}
header{position:absolute;top:${MARGIN}px;left:${MARGIN}px;right:${MARGIN}px;display:flex;justify-content:space-between;align-items:flex-start}
.badge{background:${colors.secondary};color:${colors.onSecondary};font-weight:800;font-size:30px;letter-spacing:.12em;padding:14px 26px;border-radius:12px}
.logo{max-width:260px;max-height:120px;object-fit:contain}
.logo-name{color:#fff;font-weight:600;font-size:30px;max-width:520px;text-align:right}
footer{position:absolute;left:${MARGIN}px;right:${MARGIN}px;bottom:${MARGIN}px;color:#fff}
.price{font-weight:800;font-size:104px;line-height:1.05;letter-spacing:-.02em}
.place{font-weight:600;font-size:44px;margin-top:14px;opacity:.95}
.facts{list-style:none;display:flex;gap:44px;margin-top:34px;font-size:34px;font-weight:600}
.facts li{display:flex;align-items:center;gap:14px}`;
  const body = `${photo === null ? "" : `<img class="photo" src="${photo}" alt="">`}
<div class="shade"></div>
<header><span class="badge">${OPERATION_LABEL[data.operation].toUpperCase()}</span>${brandMark(data.brand, "logo")}</header>
<footer>
<div class="price">${escapeHtml(data.price)}</div>
<div class="place">${place(data.propertyType, data.comuna)}</div>
${facts === "" ? "" : `<ul class="facts">${facts}</ul>`}
</footer>`;
  return documentOf({ width, height, fontCss, css, body });
}

export function specSheetHtml(data: SpecSheetData, fontCss: string): string {
  const { width, height } = SLIDE_SIZES.specSheet;
  const colors = brandColors(data.brand);
  const rows = data.rows
    .slice(0, MAX_SPEC_ROWS)
    .map(
      (row) =>
        `<div class="row">${icon(row.icon, 44)}<div><div class="label">${escapeHtml(row.label)}</div><div class="value">${escapeHtml(row.value)}</div></div></div>`,
    )
    .join("");
  const contact = [
    data.contact.whatsapp === null
      ? ""
      : `<span>${icon("phone", 36)}${escapeHtml(data.contact.whatsapp)}</span>`,
    data.contact.instagramHandle === null
      ? ""
      : `<span>${icon("instagram", 36)}@${escapeHtml(data.contact.instagramHandle.replace(/^@+/, ""))}</span>`,
  ].join("");
  const css = `
body{background:${colors.primary};color:${colors.onPrimary}}
.sheet{position:absolute;inset:${MARGIN}px;display:flex;flex-direction:column}
header{display:flex;justify-content:space-between;align-items:center}
.badge{background:${colors.secondary};color:${colors.onSecondary};font-weight:800;font-size:28px;letter-spacing:.12em;padding:12px 24px;border-radius:12px}
.mark{max-width:220px;max-height:96px;object-fit:contain}
.mark-name{font-weight:600;font-size:28px;opacity:.9}
.place{font-weight:800;font-size:54px;margin-top:44px;line-height:1.1}
.price{font-weight:800;font-size:70px;margin-top:16px;letter-spacing:-.01em}
.expenses{font-size:30px;margin-top:6px;opacity:.85}
.rows{display:grid;grid-template-columns:1fr 1fr;gap:26px 40px;margin-top:44px}
.row{display:flex;gap:18px;align-items:center}
.label{font-size:24px;opacity:.75}
.value{font-size:34px;font-weight:600}
.availability{font-size:30px;margin-top:36px}
.availability strong{font-weight:800}
.contact{margin-top:auto;display:flex;gap:44px;font-size:34px;font-weight:600;padding-top:24px;border-top:2px solid currentColor}
.contact span{display:flex;align-items:center;gap:14px}`;
  const body = `<div class="sheet">
<header><span class="badge">${OPERATION_LABEL[data.operation].toUpperCase()}</span>${brandMark(data.brand, "mark")}</header>
<div class="place">${place(data.propertyType, data.comuna)}</div>
<div class="price">${escapeHtml(data.price)}</div>
${data.commonExpenses === null ? "" : `<div class="expenses">Gastos comunes aprox. ${escapeHtml(data.commonExpenses)}</div>`}
${rows === "" ? "" : `<div class="rows">${rows}</div>`}
${data.availability === null ? "" : `<div class="availability"><strong>Disponibilidad:</strong> ${escapeHtml(data.availability)}</div>`}
${contact === "" ? "" : `<div class="contact">${contact}</div>`}
</div>`;
  return documentOf({ width, height, fontCss, css, body });
}

export function reelOverlayHtml(data: ReelOverlayData, fontCss: string): string {
  const { width, height } = SLIDE_SIZES.reelOverlay;
  // Arriba, bajo la zona que tapa la interfaz de Instagram, y dentro de los márgenes seguros.
  const css = `
.box{position:absolute;top:260px;left:${MARGIN}px;right:${MARGIN}px;background:rgba(0,0,0,.6);color:#fff;border-radius:32px;padding:44px 56px;text-align:center}
.operation{font-weight:800;font-size:34px;letter-spacing:.14em;opacity:.9}
.place{font-weight:800;font-size:58px;margin-top:14px;line-height:1.1}
.price{font-weight:800;font-size:76px;margin-top:16px}`;
  const body = `<div class="box">
<div class="operation">${OPERATION_LABEL[data.operation].toUpperCase()}</div>
<div class="place">${place(data.propertyType, data.comuna)}</div>
<div class="price">${escapeHtml(data.price)}</div>
</div>`;
  return documentOf({ width, height, fontCss, css, body, transparent: true });
}

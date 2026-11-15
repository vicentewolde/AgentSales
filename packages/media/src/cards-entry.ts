// Subruta `@agentsales/media/cards` (F9.7, ADR-0043): las tarjetas y las láminas con estilo, solo
// con sharp (sin Playwright ni ffmpeg), para la vista previa del estilo en la API.
export { CARD_RENDER_VERSION, createCardRenderer } from "./cards.js";
export { renderStyledCard, type StyledCardResult } from "./styled-cards.js";

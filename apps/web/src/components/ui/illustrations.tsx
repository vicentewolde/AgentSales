// Ilustraciones de hogar (F9.5-T26) para los estados vacíos y la bienvenida de «Hoy»: SVG en línea,
// de trazo, en los tonos de la paleta. Decorativas (`aria-hidden`): el texto de al lado dice qué
// pasa.

type IllustrationProps = { className?: string };

/** Una casa con su puerta, dos ventanas, la chimenea, una planta y el sol. */
export function HomeIllustration({ className = "w-40" }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 160 120"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="124" cy="30" r="15" className="fill-accent-100" />
      <path d="M14 104h132" strokeWidth={2} className="stroke-line-strong" />
      <path
        d="M46 104V62l34-26 34 26v42"
        strokeWidth={2.25}
        className="fill-surface stroke-brand-700"
      />
      <path d="M36 68 80 34l44 34" strokeWidth={2.25} className="stroke-brand-700" />
      <path d="M100 47V36h8v17" strokeWidth={2.25} className="fill-surface stroke-brand-700" />
      <rect
        x="70"
        y="80"
        width="20"
        height="24"
        rx="3"
        strokeWidth={2}
        className="fill-brand-100 stroke-brand-700"
      />
      <circle cx="85" cy="93" r="1.4" className="fill-brand-700" />
      <rect
        x="53"
        y="70"
        width="12"
        height="12"
        rx="2"
        strokeWidth={2}
        className="fill-accent-50 stroke-brand-700"
      />
      <rect
        x="95"
        y="70"
        width="12"
        height="12"
        rx="2"
        strokeWidth={2}
        className="fill-accent-50 stroke-brand-700"
      />
      <path
        d="M59 70v12M53 76h12M101 70v12M95 76h12"
        strokeWidth={1.5}
        className="stroke-brand-700"
      />
      <path
        d="m129 104-3-11h15l-3 11z"
        strokeWidth={2}
        className="fill-brand-200 stroke-brand-700"
      />
      <path
        d="M133.5 93c0-8-4.5-13-10-14 0 6.5 4 11.5 10 14Zm0 0c0-9 4.5-14 11-15 0 7-4.5 12-11 15Z"
        strokeWidth={1.75}
        className="fill-success-100 stroke-success-700"
      />
    </svg>
  );
}

/** Un sillón con una lámpara: para lo que todavía no tiene nada que mostrar. */
export function ArmchairIllustration({ className = "w-40" }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 160 120"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M14 104h132" strokeWidth={2} className="stroke-line-strong" />
      <path d="M118 104V46" strokeWidth={2} className="stroke-accent-700" />
      <path d="M108 104h20" strokeWidth={2} className="stroke-accent-700" />
      <path
        d="M106 46h24l-6-18h-12z"
        strokeWidth={2}
        className="fill-accent-100 stroke-accent-700"
      />
      <path
        d="M42 74V58c0-8 6-14 14-14h20c8 0 14 6 14 14v16"
        strokeWidth={2.25}
        className="fill-brand-100 stroke-brand-700"
      />
      <path
        d="M34 74c0-5 3-8 8-8s8 3 8 8v8h32v-8c0-5 3-8 8-8s8 3 8 8v18H34z"
        strokeWidth={2.25}
        className="fill-surface stroke-brand-700"
      />
      <path d="M40 92v12M92 92v12" strokeWidth={2.25} className="stroke-brand-700" />
    </svg>
  );
}
